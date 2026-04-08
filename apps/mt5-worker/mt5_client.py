"""MT5 SDK wrapper -- handles connection, account queries, and order execution."""

from __future__ import annotations

import os
import shutil
import time
from datetime import datetime, timezone
from typing import Any

import structlog

try:
    import MetaTrader5 as mt5  # type: ignore[import-untyped]
except ImportError:
    mt5 = None  # Allow import on non-Windows for type checking

from config import settings

log = structlog.get_logger()


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------

class MT5ConnectionError(Exception):
    def __init__(self, message: str, error_type: str = "unknown", retryable: bool = True):
        super().__init__(message)
        self.error_type = error_type
        self.retryable = retryable


def _classify_mt5_error(err: tuple[Any, Any] | None) -> dict[str, Any]:
    """Classify MT5 SDK error into actionable categories."""
    code = 0
    message = "MT5 connection failed"

    if isinstance(err, tuple) and len(err) >= 2:
        code = err[0]
        message = str(err[1]).strip() if isinstance(err[1], str) else message

    normalized = message.lower()

    if code == -6 or "authorization failed" in normalized:
        return {
            "code": code,
            "message": "MT5 rejected credentials. Check login, password, and server.",
            "error_type": "auth_failed",
            "retryable": False,
            "raw_message": message,
        }

    if "timeout" in normalized:
        return {
            "code": code,
            "message": f"MT5 connection timed out: {message}",
            "error_type": "timeout",
            "retryable": True,
            "raw_message": message,
        }

    if "connect" in normalized or "server" in normalized:
        return {
            "code": code,
            "message": f"MT5 server unreachable: {message}",
            "error_type": "server_unreachable",
            "retryable": True,
            "raw_message": message,
        }

    return {
        "code": code,
        "message": message,
        "error_type": "unknown",
        "retryable": True,
        "raw_message": message,
    }


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
        servers_src = os.path.join(os.path.dirname(__file__), "servers.dat")
        if os.path.isfile(servers_src) and not os.path.isfile(servers_dst):
            shutil.copy2(servers_src, servers_dst)

        return path

    def connect(self) -> bool:
        """Initialize MT5 SDK and log in to the account."""
        if mt5 is None:
            raise MT5ConnectionError(
                "MetaTrader5 package is not available (requires Windows)",
                error_type="platform_unsupported",
                retryable=False,
            )

        portable_dir = self._ensure_portable_dir()
        terminal_exe = os.path.join(portable_dir, "terminal64.exe")

        log.info(
            "mt5_connecting",
            login=self.login,
            server=self.server,
            timeout_ms=settings.mt5_initialize_timeout_ms,
        )

        ok = mt5.initialize(
            terminal_exe,
            login=self.login,
            password=self.password,
            server=self.server,
            timeout=settings.mt5_initialize_timeout_ms,
            portable=True,
        )

        if ok:
            self._connected = True
            self._log_account_info()
            return True

        err = mt5.last_error()
        failure = _classify_mt5_error(err)
        mt5.shutdown()

        # Retry once if retryable
        if failure["retryable"]:
            log.warning(
                "mt5_first_attempt_failed_retrying",
                error_type=failure["error_type"],
                message=failure["message"],
            )
            time.sleep(settings.reconnect_delay_seconds)

            ok = mt5.initialize(
                terminal_exe,
                login=self.login,
                password=self.password,
                server=self.server,
                timeout=settings.mt5_initialize_timeout_ms,
                portable=True,
            )

            if ok:
                self._connected = True
                self._log_account_info()
                return True

            err = mt5.last_error()
            failure = _classify_mt5_error(err)
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
        """Reconnect if the session dropped."""
        if not self._connected:
            self.connect()
            return

        # Quick health check -- try to read terminal info
        info = mt5.terminal_info()
        if info is None:
            log.warning("mt5_session_lost_reconnecting", login=self.login)
            self._connected = False
            mt5.shutdown()
            self.connect()

    def _log_account_info(self) -> None:
        info = mt5.account_info()
        if info:
            log.info(
                "mt5_connected",
                login=self.login,
                server=info.server,
                name=info.name,
                balance=info.balance,
                equity=info.equity,
                currency=info.currency,
                leverage=info.leverage,
            )

    # -- Account & positions ---------------------------------------------------

    def get_account_info(self) -> dict[str, Any]:
        self.ensure_connected()
        info = mt5.account_info()
        if info is None:
            raise MT5ConnectionError("Failed to fetch account info", error_type="query_failed")

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
        }

    def get_positions(self) -> list[dict[str, Any]]:
        self.ensure_connected()
        positions = mt5.positions_get()

        if positions is None:
            return []

        result: list[dict[str, Any]] = []
        for pos in positions:
            result.append({
                "ticket": int(pos.ticket),
                "symbol": pos.symbol,
                "type": "buy" if pos.type == mt5.ORDER_TYPE_BUY else "sell",
                "volume": float(pos.volume),
                "openPrice": float(pos.price_open),
                "currentPrice": float(pos.price_current),
                "stopLoss": float(pos.sl),
                "takeProfit": float(pos.tp),
                "profit": float(pos.profit),
                "swap": float(pos.swap),
                "commission": float(getattr(pos, "commission", 0.0)),
                "magic": int(pos.magic),
                "comment": pos.comment,
                "openTime": int(pos.time) * 1000,  # to ms
                "identifier": int(pos.identifier),
            })

        return result

    def get_open_orders(self) -> list[dict[str, Any]]:
        self.ensure_connected()
        orders = mt5.orders_get()

        if orders is None:
            return []

        result: list[dict[str, Any]] = []
        for order in orders:
            result.append({
                "ticket": int(order.ticket),
                "symbol": order.symbol,
                "type": self._order_type_str(order.type),
                "volumeInitial": float(order.volume_initial),
                "volumeCurrent": float(order.volume_current),
                "priceOpen": float(order.price_open),
                "stopLoss": float(order.sl),
                "takeProfit": float(order.tp),
                "state": self._order_state_str(order.state),
                "comment": order.comment,
                "magic": int(order.magic),
                "timeSetup": int(order.time_setup) * 1000 if order.time_setup else 0,
                "timeDone": int(order.time_done) * 1000 if order.time_done else 0,
            })

        return result

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

        # Ensure symbol is enabled
        selected = mt5.symbol_select(symbol, True)
        if not selected:
            raise ValueError(f"Symbol {symbol} not available or could not be selected")

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise ValueError(f"Could not get tick data for {symbol}")

        # Determine order type and fill price
        mt5_type = self._resolve_order_type(side, order_type)
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
            err = mt5.last_error()
            raise MT5ConnectionError(
                f"order_send returned None: {err}",
                error_type="order_failed",
            )

        return self._map_order_result(result)

    def modify_position(
        self,
        ticket: int,
        stop_loss: float | None = None,
        take_profit: float | None = None,
    ) -> dict[str, Any]:
        """Modify an existing position's SL/TP."""
        self.ensure_connected()

        pos = self._find_position(ticket)
        if pos is None:
            raise ValueError(f"Position {ticket} not found")

        request: dict[str, Any] = {
            "action": mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol": pos.symbol,
            "sl": stop_loss if stop_loss is not None else pos.sl,
            "tp": take_profit if take_profit is not None else pos.tp,
        }

        result = mt5.order_send(request)
        if result is None:
            err = mt5.last_error()
            raise MT5ConnectionError(
                f"modify position failed: {err}",
                error_type="order_failed",
            )

        return self._map_order_result(result)

    def close_position(
        self,
        ticket: int,
        volume: float | None = None,
        deviation: int = 20,
    ) -> dict[str, Any]:
        """Close an existing position (fully or partially)."""
        self.ensure_connected()

        pos = self._find_position(ticket)
        if pos is None:
            raise ValueError(f"Position {ticket} not found")

        close_volume = volume if volume is not None else pos.volume
        close_side = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY

        tick = mt5.symbol_info_tick(pos.symbol)
        if tick is None:
            raise ValueError(f"Could not get tick for {pos.symbol}")

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
            "comment": "close",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": self._resolve_filling_mode(pos.symbol),
        }

        result = mt5.order_send(request)
        if result is None:
            err = mt5.last_error()
            raise MT5ConnectionError(
                f"close position failed: {err}",
                error_type="order_failed",
            )

        return self._map_order_result(result)

    def close_all_positions(self, deviation: int = 20) -> list[dict[str, Any]]:
        """Emergency flatten -- close every open position."""
        positions = mt5.positions_get()
        if not positions:
            return []

        results: list[dict[str, Any]] = []
        for pos in positions:
            try:
                result = self.close_position(int(pos.ticket), deviation=deviation)
                results.append(result)
            except Exception as exc:
                log.error("emergency_close_failed", ticket=pos.ticket, error=str(exc))
                results.append({
                    "ticket": int(pos.ticket),
                    "retcode": -1,
                    "retcodeDescription": str(exc),
                    "retcodeExternal": None,
                    "orderId": "",
                    "volume": 0.0,
                    "price": 0.0,
                    "comment": str(exc),
                    "bid": None,
                    "ask": None,
                })

        return results

    # -- Symbol info -----------------------------------------------------------

    def get_symbol_info(self, symbol: str) -> dict[str, Any] | None:
        self.ensure_connected()
        mt5.symbol_select(symbol, True)
        info = mt5.symbol_info(symbol)
        if info is None:
            return None

        point = 10 ** (-info.digits) if info.digits > 0 else 1.0
        pip_size = point * 10 if info.digits in (3, 5) else point

        tick = mt5.symbol_info_tick(symbol)
        bid = float(tick.bid) if tick else 0.0
        ask = float(tick.ask) if tick else 0.0

        return {
            "symbol": info.name,
            "digits": info.digits,
            "point": point,
            "pipSize": pip_size,
            "tickValue": float(info.trade_tick_value),
            "contractSize": float(info.trade_contract_size),
            "currency": info.currency_profit,
            "description": info.description,
            "spread": info.spread,
            "volumeMin": float(info.volume_min),
            "volumeMax": float(info.volume_max),
            "volumeStep": float(info.volume_step),
            "fillingMode": info.filling_mode,
            "bid": bid,
            "ask": ask,
        }

    def get_symbol_info_batch(self, symbols: list[str]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for symbol in symbols:
            info = self.get_symbol_info(symbol)
            if info:
                result.append(info)
        return result

    # -- Order status ----------------------------------------------------------

    def get_order(self, order_id: int) -> dict[str, Any] | None:
        """Get pending order status."""
        self.ensure_connected()
        orders = mt5.orders_get(ticket=order_id)
        if orders and len(orders) > 0:
            order = orders[0]
            return {
                "ticket": int(order.ticket),
                "symbol": order.symbol,
                "type": self._order_type_str(order.type),
                "volume": float(order.volume_current),
                "price": float(order.price_open),
                "stopLoss": float(order.sl),
                "takeProfit": float(order.tp),
                "state": self._order_state_str(order.state),
                "timeDone": int(order.time_done) * 1000 if order.time_done else 0,
            }

        deals = mt5.history_deals_get(ticket=order_id)
        if not deals:
            epoch = datetime(2020, 1, 1, tzinfo=timezone.utc)
            now = datetime.now(timezone.utc)
            deals = mt5.history_deals_get(epoch, now, ticket=order_id)

        if deals and len(deals) > 0:
            deal = deals[0]
            deal_type_map = {
                mt5.DEAL_TYPE_BUY: "buy",
                mt5.DEAL_TYPE_SELL: "sell",
                mt5.DEAL_TYPE_BALANCE: "balance",
                mt5.DEAL_TYPE_CREDIT: "credit",
                mt5.DEAL_TYPE_CHARGE: "charge",
                mt5.DEAL_TYPE_CORRECTION: "correction",
                mt5.DEAL_TYPE_BONUS: "bonus",
                mt5.DEAL_TYPE_COMMISSION: "commission",
                mt5.DEAL_TYPE_COMMISSION_DAILY: "commission_daily",
                mt5.DEAL_TYPE_COMMISSION_MONTHLY: "commission_monthly",
                mt5.DEAL_TYPE_COMMISSION_AGENT_DAILY: "commission_agent_daily",
                mt5.DEAL_TYPE_COMMISSION_AGENT_MONTHLY: "commission_agent_monthly",
                mt5.DEAL_TYPE_INTEREST: "interest",
                mt5.DEAL_TYPE_BUY_CANCELED: "buy_canceled",
                mt5.DEAL_TYPE_SELL_CANCELED: "sell_canceled",
            }
            return {
                "ticket": int(deal.order),
                "symbol": deal.symbol,
                "type": deal_type_map.get(deal.type, f"unknown_{deal.type}"),
                "volume": float(deal.volume),
                "price": float(deal.price),
                "profit": float(deal.profit),
                "state": "filled",
                "timeDone": int(deal.time) * 1000,
            }

        return None

    # -- Helpers ---------------------------------------------------------------

    def _find_position(self, ticket: int) -> Any:
        positions = mt5.positions_get(ticket=ticket)
        if positions and len(positions) > 0:
            return positions[0]
        return None

    def _resolve_order_type(self, side: str, order_type: str) -> int:
        if order_type == "market":
            return mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
        if order_type == "limit":
            return mt5.ORDER_TYPE_BUY_LIMIT if side == "buy" else mt5.ORDER_TYPE_SELL_LIMIT
        if order_type == "stop":
            return mt5.ORDER_TYPE_BUY_STOP if side == "buy" else mt5.ORDER_TYPE_SELL_STOP
        if order_type == "stop_limit":
            return mt5.ORDER_TYPE_BUY_STOP_LIMIT if side == "buy" else mt5.ORDER_TYPE_SELL_STOP_LIMIT
        return mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL

    def _resolve_filling_mode(self, symbol: str) -> int:
        """Pick a fill mode the broker supports for this symbol.

        symbol_info().filling_mode is a bitmask:
            bit 0 (1) = ORDER_FILLING_FOK
            bit 1 (2) = ORDER_FILLING_IOC
            bit 2 (4) = ORDER_FILLING_BOC (book-or-cancel)
        We prefer IOC > FOK > RETURN as the fallback order.
        """
        info = mt5.symbol_info(symbol)
        if info is None:
            return mt5.ORDER_FILLING_IOC

        mask = info.filling_mode
        if mask & 2:
            return mt5.ORDER_FILLING_IOC
        if mask & 1:
            return mt5.ORDER_FILLING_FOK
        return mt5.ORDER_FILLING_RETURN

    def _map_order_result(self, result: Any) -> dict[str, Any]:
        retcode = int(result.retcode)
        return {
            "retcode": retcode,
            "retcodeDescription": self._retcode_description(retcode),
            "retcodeExternal": int(getattr(result, "retcode_external", 0)) if hasattr(result, "retcode_external") else None,
            "orderId": str(result.order) if result.order else "",
            "dealId": str(result.deal) if result.deal else "",
            "volume": float(result.volume),
            "price": float(result.price),
            "comment": result.comment if hasattr(result, "comment") else "",
            "bid": float(getattr(result, "bid", 0.0)) if hasattr(result, "bid") else None,
            "ask": float(getattr(result, "ask", 0.0)) if hasattr(result, "ask") else None,
            "success": retcode == mt5.TRADE_RETCODE_DONE,
        }

    @staticmethod
    def _retcode_description(retcode: int) -> str:
        descriptions: dict[int, str] = {
            10004: "Requote",
            10006: "Request rejected",
            10007: "Request cancelled by trader",
            10008: "Order placed",
            10009: "Request completed",
            10010: "Request partially completed",
            10011: "Request processing error",
            10012: "Request cancelled by timeout",
            10013: "Invalid request",
            10014: "Invalid volume",
            10015: "Invalid price",
            10016: "Invalid stops",
            10017: "Trade disabled",
            10018: "Market closed",
            10019: "Insufficient funds",
            10020: "Prices changed",
            10021: "No quotes",
            10022: "Invalid expiration",
            10023: "Order state changed",
            10024: "Too many requests",
            10025: "No changes",
            10026: "Autotrading disabled",
            10027: "Protection triggered",
            10028: "Modification failed (locked)",
            10029: "Order/position frozen",
            10030: "Invalid fill mode",
            10031: "Connection problem",
            10032: "Only real accounts allowed",
            10033: "Pending orders limit reached",
            10034: "Volume limit for orders/positions reached",
            10035: "Invalid or prohibited order type",
            10036: "Position already closed",
            10038: "Close volume exceeds position volume",
            10039: "Close order already exists for position",
            10040: "Limit orders reached",
            10041: "Pending volume limit reached",
            10042: "Order prohibited (only long allowed)",
            10043: "Order prohibited (only short allowed)",
            10044: "Order prohibited (only close allowed)",
            10045: "Position close not allowed by FIFO",
        }
        return descriptions.get(retcode, f"Unknown retcode {retcode}")

    @staticmethod
    def _order_type_str(order_type: int) -> str:
        mapping = {
            0: "buy",
            1: "sell",
            2: "buy_limit",
            3: "sell_limit",
            4: "buy_stop",
            5: "sell_stop",
            6: "buy_stop_limit",
            7: "sell_stop_limit",
        }
        return mapping.get(order_type, f"unknown_{order_type}")

    @staticmethod
    def _order_state_str(state: int) -> str:
        mapping = {
            0: "started",
            1: "placed",
            2: "canceled",
            3: "partial",
            4: "filled",
            5: "rejected",
            6: "expired",
            7: "request_add",
            8: "request_modify",
            9: "request_cancel",
        }
        return mapping.get(state, f"unknown_{state}")
