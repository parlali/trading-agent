"""MT5 SDK wrapper -- handles connection, account queries, and order execution."""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from datetime import datetime, timedelta, timezone
from typing import Any, NoReturn

import structlog

try:
    import MetaTrader5 as mt5  # type: ignore[import-untyped]
except ImportError:
    mt5 = None  # Allow import on non-Windows for type checking

from config import settings
from mt5_errors import (
    MT5ConnectionError,
    classify_connection_error,
    read_mt5_error_details,
)
from mt5_mappers import (
    map_deal_status,
    map_history_order_status,
    map_account_pnl_event,
    map_open_order,
    map_open_order_status,
    map_order_result,
    map_position,
    map_position_closures,
    map_position_status,
    map_symbol_info,
    resolve_filling_mode,
    resolve_order_type,
)

log = structlog.get_logger()


def is_transient_symbol_select_failure(code: int, message: str) -> bool:
    normalized = message.lower()
    return (
        code in {-1, -10000, -10001, -10002, -10003, -10004, -10005}
        or "terminal" in normalized and "call failed" in normalized
        or "ipc" in normalized
        or "socket" in normalized
        or "timeout" in normalized
        or "timed out" in normalized
        or "connection" in normalized
        or "not connected" in normalized
    )


def resolve_margin_mode_name(margin_mode: int) -> str:
    if mt5 is None:
        return "unknown"

    if margin_mode == getattr(mt5, "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING", -1):
        return "retail_hedging"
    if margin_mode == getattr(mt5, "ACCOUNT_MARGIN_MODE_RETAIL_NETTING", -1):
        return "retail_netting"
    if margin_mode == getattr(mt5, "ACCOUNT_MARGIN_MODE_EXCHANGE", -1):
        return "exchange"

    return "unknown"


# ---------------------------------------------------------------------------
# MT5 Client
# ---------------------------------------------------------------------------

class MT5Client:
    """Wraps MetaTrader5 SDK for a single account connection."""

    def __init__(self, login: int, password: str, server: str):
        self.login = login
        self.password = password
        self.server = server
        self._connected = False

    # -- Connection lifecycle --------------------------------------------------

    def _portable_path(self) -> str:
        return os.path.join(settings.mt5_portable_dir, str(self.login))

    def _ensure_portable_dir(self) -> str:
        path = self._portable_path()
        os.makedirs(path, exist_ok=True)

        terminal_dst = os.path.join(path, "terminal64.exe")
        if not os.path.isfile(terminal_dst):
            src = settings.mt5_terminal_path
            if os.path.isfile(src):
                shutil.copy2(src, terminal_dst)

        config_dir = os.path.join(path, "config")
        os.makedirs(config_dir, exist_ok=True)
        servers_dst = os.path.join(config_dir, "servers.dat")
        servers_src = os.path.abspath(os.path.expanduser(settings.mt5_servers_dat_path))
        if not os.path.isfile(servers_src):
            raise MT5ConnectionError(
                "Required MT5 servers.dat not found. Place it in private/mt5-worker/servers.dat or set MT5_SERVERS_DAT_PATH.",
                error_type="missing_servers_dat",
                retryable=False,
            )

        if not os.path.isfile(servers_dst):
            shutil.copy2(servers_src, servers_dst)

        return path

    def _shutdown_sdk_connection(self) -> None:
        try:
            mt5.shutdown()
        except Exception as exc:
            log.warning("mt5_sdk_shutdown_failed", login=self.login, error=str(exc))

    def _stop_portable_terminal_processes(self, terminal_exe: str) -> None:
        if os.name != "nt":
            return

        script = "\n".join([
            "$target = [System.IO.Path]::GetFullPath($env:MT5_TERMINAL_EXE).ToLowerInvariant()",
            "Get-CimInstance Win32_Process -Filter \"Name = 'terminal64.exe'\" |",
            "Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath).ToLowerInvariant() -eq $target) } |",
            "ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output $_.ProcessId }",
        ])

        env = os.environ.copy()
        env["MT5_TERMINAL_EXE"] = terminal_exe

        try:
            result = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    script,
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except Exception as exc:
            log.warning(
                "mt5_stale_terminal_cleanup_failed",
                login=self.login,
                terminal=terminal_exe,
                error=str(exc),
            )
            return

        killed_pids = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if killed_pids:
            log.warning(
                "mt5_stale_terminal_processes_killed",
                login=self.login,
                terminal=terminal_exe,
                processIds=killed_pids,
            )

        if result.returncode != 0:
            log.warning(
                "mt5_stale_terminal_cleanup_returned_error",
                login=self.login,
                terminal=terminal_exe,
                returnCode=result.returncode,
                stderr=result.stderr.strip(),
            )

    def _initialize_terminal(self, terminal_exe: str) -> bool:
        return mt5.initialize(
            terminal_exe,
            login=self.login,
            password=self.password,
            server=self.server,
            timeout=settings.mt5_initialize_timeout_ms,
            portable=True,
        )

    def connect(self, reset_terminal: bool = False) -> bool:
        """Initialize MT5 SDK and log in to the account."""
        if mt5 is None:
            raise MT5ConnectionError(
                "MetaTrader5 package is not available (requires Windows)",
                error_type="platform_unsupported",
                retryable=False,
            )

        portable_dir = self._ensure_portable_dir()
        terminal_exe = os.path.join(portable_dir, "terminal64.exe")
        self._shutdown_sdk_connection()
        if reset_terminal:
            self._stop_portable_terminal_processes(terminal_exe)

        log.info(
            "mt5_connecting",
            login=self.login,
            server=self.server,
            timeout_ms=settings.mt5_initialize_timeout_ms,
            reset_terminal=reset_terminal,
        )

        ok = self._initialize_terminal(terminal_exe)

        if ok:
            self._connected = True
            self._log_account_info()
            return True

        err = mt5.last_error()
        failure = classify_connection_error(err)
        mt5.shutdown()

        if failure["retryable"]:
            log.warning(
                "mt5_warm_connect_failed_cold_retrying",
                error_type=failure["error_type"],
                message=failure["message"],
            )
            self._stop_portable_terminal_processes(terminal_exe)
            time.sleep(settings.reconnect_delay_seconds)

            ok = self._initialize_terminal(terminal_exe)

            if ok:
                self._connected = True
                self._log_account_info()
                return True

            err = mt5.last_error()
            failure = classify_connection_error(err)
            mt5.shutdown()

        raise MT5ConnectionError(
            failure["message"],
            error_type=failure["error_type"],
            retryable=failure["retryable"],
        )

    def disconnect(self) -> None:
        if self._connected:
            mt5.shutdown()
            self._connected = False
            log.info("mt5_disconnected", login=self.login)

    def ensure_connected(self) -> None:
        """Verify the active MT5 terminal session."""
        if not self._connected:
            raise MT5ConnectionError(
                "MT5 session is not connected. Call /connect before broker operations.",
                error_type="not_connected",
            )

        info = mt5.terminal_info()
        if info is None:
            detail = self._last_error_details()
            log.warning(
                "mt5_session_lost",
                login=self.login,
                code=detail["code"],
                message=detail["message"],
            )
            self._connected = False
            raise MT5ConnectionError(
                f"MT5 terminal health check failed: {detail['message']} ({detail['code']})",
                error_type="session_lost",
            )

    def _log_account_info(self) -> None:
        info = mt5.account_info()
        if info:
            margin_mode = int(getattr(info, "margin_mode", -1))
            log.info(
                "mt5_connected",
                login=self.login,
                server=info.server,
                name=info.name,
                balance=info.balance,
                equity=info.equity,
                currency=info.currency,
                leverage=info.leverage,
                marginMode=margin_mode,
                marginModeName=resolve_margin_mode_name(margin_mode),
            )

    def _last_error_details(self) -> dict[str, Any]:
        detail = read_mt5_error_details(mt5)
        return {
            "code": detail.code,
            "message": detail.message,
            "raw": detail.raw,
        }

    def _raise_mt5_error(
        self,
        operation: str,
        error_type: str = "query_failed",
        retryable: bool = True,
    ) -> NoReturn:
        detail = self._last_error_details()
        log.error(
            "mt5_sdk_call_failed",
            login=self.login,
            operation=operation,
            code=detail["code"],
            message=detail["message"],
            rawError=detail["raw"],
        )
        raise MT5ConnectionError(
            f"{operation} failed: {detail['message']} ({detail['code']})",
            error_type=error_type,
            retryable=retryable,
        )

    def _raise_symbol_select_error(self, symbol: str) -> NoReturn:
        detail = self._last_error_details()
        transient = is_transient_symbol_select_failure(detail["code"], detail["message"])
        if transient:
            self._connected = False

        error_type = "query_failed" if transient else "symbol_unavailable"
        retryable = transient
        log.error(
            "mt5_sdk_call_failed",
            login=self.login,
            operation="symbol_select",
            symbol=symbol,
            code=detail["code"],
            message=detail["message"],
            rawError=detail["raw"],
            errorType=error_type,
            retryable=retryable,
        )
        raise MT5ConnectionError(
            f"symbol_select failed for {symbol}: {detail['message']} ({detail['code']})",
            error_type=error_type,
            retryable=retryable,
        )

    def _require_mt5_result(
        self,
        operation: str,
        result: Any,
        error_type: str = "query_failed",
        retryable: bool = True,
    ) -> Any:
        if result is None:
            self._raise_mt5_error(operation, error_type=error_type, retryable=retryable)

        return result

    def assert_session_login(self, expected_login: int) -> None:
        self.ensure_connected()
        info = self._require_mt5_result("account_info", mt5.account_info())
        active_login = int(info.login)
        if active_login != int(expected_login):
            self._connected = False
            log.error(
                "mt5_session_login_mismatch",
                expectedLogin=int(expected_login),
                activeLogin=active_login,
            )
            raise MT5ConnectionError(
                f"MT5 active session login {active_login} does not match requested login {expected_login}",
                error_type="session_login_mismatch",
                retryable=False,
            )

    # -- Account & positions ---------------------------------------------------

    def get_account_info(self) -> dict[str, Any]:
        self.ensure_connected()
        info = self._require_mt5_result("account_info", mt5.account_info())
        margin_mode = int(getattr(info, "margin_mode", -1))

        return {
            "login": info.login,
            "name": info.name,
            "server": info.server,
            "company": info.company,
            "balance": float(info.balance),
            "equity": float(info.equity),
            "margin": float(info.margin),
            "freeMargin": float(info.margin_free),
            "marginLevel": float(info.margin_level) if info.margin_level else 0.0,
            "currency": info.currency,
            "leverage": info.leverage,
            "profit": float(info.profit),
            "marginMode": margin_mode,
            "marginModeName": resolve_margin_mode_name(margin_mode),
        }

    def get_positions(self) -> list[dict[str, Any]]:
        self.ensure_connected()
        positions = self._require_mt5_result("positions_get", mt5.positions_get())

        return [map_position(mt5, pos) for pos in positions]

    def get_open_orders(self) -> list[dict[str, Any]]:
        self.ensure_connected()
        orders = self._require_mt5_result("orders_get", mt5.orders_get())

        return [map_open_order(order) for order in orders]

    def get_position_closures(self, lookback_hours: int = 24) -> list[dict[str, Any]]:
        self.ensure_connected()

        now = datetime.now(timezone.utc)
        start = now - timedelta(hours=max(1, lookback_hours))
        deals = self._require_mt5_result(
            "history_deals_get",
            mt5.history_deals_get(start, now),
        )

        if len(deals) == 0:
            return []

        result = map_position_closures(mt5, deals)

        return sorted(result, key=lambda deal: int(deal["timeDone"]), reverse=True)

    def get_account_pnl_events(self, lookback_hours: int = 24) -> list[dict[str, Any]]:
        self.ensure_connected()

        info = mt5.account_info()
        if info is None:
            self._raise_mt5_error("account_info")

        currency = str(getattr(info, "currency", "") or "")
        now = datetime.now(timezone.utc)
        start = now - timedelta(hours=max(1, lookback_hours))
        deals = self._require_mt5_result(
            "history_deals_get.account_pnl_events",
            mt5.history_deals_get(start, now),
        )

        if len(deals) == 0:
            return []

        result: list[dict[str, Any]] = []
        for deal in deals:
            mapped = map_account_pnl_event(mt5, deal, currency)
            if mapped is not None:
                result.append(mapped)

        return sorted(result, key=lambda event: int(event["occurredAt"]), reverse=True)

    # -- Order execution -------------------------------------------------------

    def submit_order(
        self,
        symbol: str,
        side: str,
        volume: float,
        order_type: str = "market",
        price: float | None = None,
        stop_loss: float | None = None,
        take_profit: float | None = None,
        magic: int = 0,
        comment: str = "",
        deviation: int = 20,
    ) -> dict[str, Any]:
        """Submit a new order to MT5."""
        self.ensure_connected()

        selected = mt5.symbol_select(symbol, True)
        if not selected:
            self._raise_symbol_select_error(symbol)

        tick = self._require_mt5_result("symbol_info_tick", mt5.symbol_info_tick(symbol))

        mt5_type = resolve_order_type(mt5, side, order_type)
        fill_price = price if price is not None else (tick.ask if side == "buy" else tick.bid)

        request: dict[str, Any] = {
            "action": mt5.TRADE_ACTION_DEAL if order_type == "market" else mt5.TRADE_ACTION_PENDING,
            "symbol": symbol,
            "volume": volume,
            "type": mt5_type,
            "price": fill_price,
            "deviation": deviation,
            "magic": magic,
            "comment": comment,
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": self._resolve_filling_mode(symbol),
        }

        if stop_loss is not None:
            request["sl"] = stop_loss
        if take_profit is not None:
            request["tp"] = take_profit

        log.info("mt5_order_sending", symbol=symbol, side=side, volume=volume, price=fill_price)

        result = mt5.order_send(request)
        if result is None:
            self._raise_mt5_error("order_send", error_type="order_failed")

        return map_order_result(mt5, result)

    def modify_order(
        self,
        ticket: int,
        price: float | None = None,
        stop_loss: float | None = None,
        take_profit: float | None = None,
    ) -> dict[str, Any]:
        self.ensure_connected()

        order = self._find_open_order(ticket)
        if order is not None:
            return self._modify_pending_order(ticket, order, price, stop_loss, take_profit)

        pos = self._find_position(ticket)
        if pos is None:
            raise ValueError(f"Order or position {ticket} not found")

        return self._modify_position(ticket, pos, stop_loss, take_profit)

    def _modify_pending_order(
        self,
        ticket: int,
        order: Any,
        price: float | None,
        stop_loss: float | None,
        take_profit: float | None,
    ) -> dict[str, Any]:
        request: dict[str, Any] = {
            "action": mt5.TRADE_ACTION_MODIFY,
            "order": ticket,
            "symbol": order.symbol,
            "price": price if price is not None else order.price_open,
            "sl": stop_loss if stop_loss is not None else order.sl,
            "tp": take_profit if take_profit is not None else order.tp,
            "type_time": mt5.ORDER_TIME_GTC,
        }

        result = mt5.order_send(request)
        if result is None:
            self._raise_mt5_error("order_send.modify_order", error_type="order_failed")

        return map_order_result(mt5, result)

    def _modify_position(
        self,
        ticket: int,
        pos: Any,
        stop_loss: float | None,
        take_profit: float | None,
    ) -> dict[str, Any]:
        request: dict[str, Any] = {
            "action": mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol": pos.symbol,
            "sl": stop_loss if stop_loss is not None else pos.sl,
            "tp": take_profit if take_profit is not None else pos.tp,
        }

        result = mt5.order_send(request)
        if result is None:
            self._raise_mt5_error("order_send.modify_position", error_type="order_failed")

        return map_order_result(mt5, result)

    def modify_position(
        self,
        ticket: int,
        stop_loss: float | None = None,
        take_profit: float | None = None,
    ) -> dict[str, Any]:
        return self.modify_order(
            ticket=ticket,
            stop_loss=stop_loss,
            take_profit=take_profit,
        )

    def cancel_order(self, ticket: int) -> dict[str, Any]:
        self.ensure_connected()

        order = self._find_open_order(ticket)
        if order is None:
            raise ValueError(f"Pending order {ticket} not found")

        request: dict[str, Any] = {
            "action": mt5.TRADE_ACTION_REMOVE,
            "order": ticket,
        }

        result = mt5.order_send(request)
        if result is None:
            self._raise_mt5_error("order_send.cancel_order", error_type="order_failed")

        return map_order_result(mt5, result, fallback_order_id=ticket)

    def close_position(
        self,
        ticket: int,
        volume: float | None = None,
        deviation: int = 20,
        comment: str = "close",
    ) -> dict[str, Any]:
        """Close an existing position (fully or partially)."""
        self.ensure_connected()

        pos = self._find_position(ticket)
        if pos is None:
            raise ValueError(f"Position {ticket} not found")

        close_volume = volume if volume is not None else pos.volume
        close_side = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY

        tick = self._require_mt5_result("symbol_info_tick", mt5.symbol_info_tick(pos.symbol))

        close_price = tick.bid if pos.type == mt5.ORDER_TYPE_BUY else tick.ask

        request: dict[str, Any] = {
            "action": mt5.TRADE_ACTION_DEAL,
            "position": ticket,
            "symbol": pos.symbol,
            "volume": close_volume,
            "type": close_side,
            "price": close_price,
            "deviation": deviation,
            "magic": pos.magic,
            "comment": comment,
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": self._resolve_filling_mode(pos.symbol),
        }

        result = mt5.order_send(request)
        if result is None:
            self._raise_mt5_error("order_send.close_position", error_type="order_failed")

        return map_order_result(mt5, result)

    # -- Symbol info -----------------------------------------------------------

    def get_symbol_info(self, symbol: str) -> dict[str, Any]:
        self.ensure_connected()
        selected = mt5.symbol_select(symbol, True)
        if not selected:
            self._raise_symbol_select_error(symbol)

        info = self._require_mt5_result("symbol_info", mt5.symbol_info(symbol))

        tick = self._require_mt5_result("symbol_info_tick", mt5.symbol_info_tick(symbol))

        return map_symbol_info(info, tick)

    def get_symbol_info_batch(self, symbols: list[str]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for symbol in symbols:
            info = self.get_symbol_info(symbol)
            result.append(info)
        return result

    # -- Order status ----------------------------------------------------------

    def get_order(self, order_id: int) -> dict[str, Any] | None:
        """Get pending order status."""
        if order_id <= 0:
            log.warning("mt5_order_status_invalid_ticket", order_id=order_id)
            return None

        self.ensure_connected()
        try:
            orders = self._require_mt5_result(
                "orders_get",
                mt5.orders_get(ticket=order_id),
            )
        except (OverflowError, SystemError) as exc:
            log.error(
                "mt5_orders_get_failed",
                order_id=order_id,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            return None

        if orders and len(orders) > 0:
            return map_open_order_status(orders[0])

        try:
            positions = self._require_mt5_result(
                "positions_get",
                mt5.positions_get(ticket=order_id),
            )
        except (OverflowError, SystemError) as exc:
            log.error(
                "mt5_positions_get_failed",
                order_id=order_id,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            return None

        if positions and len(positions) > 0:
            return map_position_status(positions[0])

        deals = self._require_mt5_result(
            "history_deals_get.ticket",
            mt5.history_deals_get(ticket=order_id),
        )
        if len(deals) == 0:
            start = datetime.now(timezone.utc) - timedelta(days=30)
            now = datetime.now(timezone.utc)
            deals = self._require_mt5_result(
                "history_deals_get.range_ticket",
                mt5.history_deals_get(start, now, ticket=order_id),
            )

        if deals and len(deals) > 0:
            mapped_deal = map_deal_status(mt5, order_id, deals)
            if mapped_deal is not None:
                return mapped_deal

        history_orders = self._require_mt5_result(
            "history_orders_get.ticket",
            mt5.history_orders_get(ticket=order_id),
        )
        if len(history_orders) == 0:
            start = datetime.now(timezone.utc) - timedelta(days=30)
            now = datetime.now(timezone.utc)
            history_orders = self._require_mt5_result(
                "history_orders_get.range_ticket",
                mt5.history_orders_get(start, now, ticket=order_id),
            )

        if history_orders and len(history_orders) > 0:
            history_order = next(
                (
                    order for order in history_orders
                    if int(getattr(order, "ticket", 0) or 0) == order_id
                ),
                None,
            )
            if history_order is not None:
                return map_history_order_status(history_order)

        return None

    # -- Helpers ---------------------------------------------------------------

    def _find_position(self, ticket: int) -> Any:
        positions = self._require_mt5_result(
            "positions_get",
            mt5.positions_get(ticket=ticket),
        )
        if positions and len(positions) > 0:
            return positions[0]
        return None

    def _find_open_order(self, ticket: int) -> Any:
        orders = self._require_mt5_result(
            "orders_get",
            mt5.orders_get(ticket=ticket),
        )
        if orders and len(orders) > 0:
            return orders[0]
        return None

    def _resolve_filling_mode(self, symbol: str) -> int:
        """Pick a fill mode the broker supports for this symbol.

        symbol_info().filling_mode is a bitmask:
            bit 0 (1) = ORDER_FILLING_FOK
            bit 1 (2) = ORDER_FILLING_IOC
            bit 2 (4) = ORDER_FILLING_BOC (book-or-cancel)
        We prefer IOC > FOK > RETURN as the fallback order.
        """
        info = self._require_mt5_result("symbol_info", mt5.symbol_info(symbol))

        return resolve_filling_mode(mt5, info.filling_mode)
