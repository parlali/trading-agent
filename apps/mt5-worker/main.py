"""MT5 Python worker -- FastAPI HTTP server exposing MT5 broker operations.

Architecture: The backend runtime (apps/backend/) calls this worker over HTTP.
This worker is stateless apart from the MT5 terminal session. It runs on a
Windows machine where the MetaTrader 5 SDK is available.
"""

from __future__ import annotations

import asyncio
import os
import socket
import sys
import threading
import time
from contextlib import asynccontextmanager
from secrets import compare_digest
from typing import Any

import structlog
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from config import settings
from mt5_client import MT5Client, MT5ConnectionError

log = structlog.get_logger()

# ---------------------------------------------------------------------------
# Global client -- one active MT5 connection at a time
# ---------------------------------------------------------------------------

_client: MT5Client | None = None
_watchdog_stop: threading.Event | None = None
_watchdog_thread: threading.Thread | None = None
_operation_lock: asyncio.Lock | None = None
_connect_lock: asyncio.Lock | None = None
_terminal_blocked = False
_worker_state: dict[str, Any] = {
    "status": "disconnected",
    "activeOperation": None,
    "lastError": None,
    "lastStartedAt": None,
    "lastFinishedAt": None,
}


class BlockingOperationTimeout(Exception):
    def __init__(self, operation: str, timeout_seconds: float):
        super().__init__(f"MT5 {operation} timed out after {timeout_seconds:.1f}s")
        self.operation = operation
        self.timeout_seconds = timeout_seconds


def assert_expected_repo_path() -> None:
    if os.name != "nt":
        return

    expected_suffix = settings.worker_expected_repo_suffix.strip()
    if not expected_suffix:
        return

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    expected_parts = tuple(part.lower() for part in expected_suffix.replace("/", "\\").split("\\") if part)
    root_parts = tuple(part.lower() for part in repo_root.replace("/", "\\").split("\\") if part)

    if expected_parts and root_parts[-len(expected_parts):] != expected_parts:
        terminate_for_restart(
            "worker_repo_path_mismatch",
            {
                "repoRoot": repo_root,
                "expectedSuffix": expected_suffix,
            },
        )


def terminate_for_restart(reason: str, details: dict[str, Any] | None = None) -> None:
    log.critical(
        "mt5_worker_restart_required",
        reason=reason,
        **(details or {}),
    )
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(70)


def install_loop_exception_handler() -> None:
    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()

    def handle_exception(
        active_loop: asyncio.AbstractEventLoop,
        context: dict[str, Any],
    ) -> None:
        if is_worker_accept_socket_failure(context):
            exception = context.get("exception")
            terminate_for_restart(
                "worker_accept_socket_failed",
                {
                    "message": str(context.get("message", "")),
                    "exceptionType": type(exception).__name__ if exception else None,
                    "exception": str(exception) if exception else None,
                    "port": settings.worker_port,
                },
            )

        if previous_handler:
            previous_handler(active_loop, context)
        else:
            active_loop.default_exception_handler(context)

    loop.set_exception_handler(handle_exception)


def is_worker_accept_socket_failure(context: dict[str, Any]) -> bool:
    message = str(context.get("message", ""))
    if "Accept failed on a socket" not in message:
        return False

    socket_obj = context.get("socket")
    if socket_obj is None:
        return True

    try:
        local_address = socket_obj.getsockname()
    except OSError:
        return True

    if not isinstance(local_address, tuple) or len(local_address) < 2:
        return True

    return int(local_address[1]) == settings.worker_port


def start_listener_watchdog() -> None:
    global _watchdog_stop, _watchdog_thread

    if not settings.worker_listener_watchdog_enabled:
        log.info("mt5_listener_watchdog_disabled")
        return

    if _watchdog_thread is not None:
        return

    stop_event = threading.Event()
    thread = threading.Thread(
        target=run_listener_watchdog,
        args=(stop_event,),
        name="mt5-listener-watchdog",
        daemon=True,
    )
    _watchdog_stop = stop_event
    _watchdog_thread = thread
    thread.start()


def stop_listener_watchdog() -> None:
    global _watchdog_stop, _watchdog_thread

    if _watchdog_stop is not None:
        _watchdog_stop.set()

    if _watchdog_thread is not None:
        _watchdog_thread.join(timeout=2.0)

    _watchdog_stop = None
    _watchdog_thread = None


def run_listener_watchdog(stop_event: threading.Event) -> None:
    if stop_event.wait(settings.worker_listener_watchdog_startup_grace_seconds):
        return

    failures = 0
    threshold = max(1, settings.worker_listener_watchdog_failure_threshold)

    while not stop_event.is_set():
        if can_connect_worker_listener():
            if failures > 0:
                log.info("mt5_listener_watchdog_recovered", failures=failures)
            failures = 0
        else:
            failures += 1
            log.error(
                "mt5_listener_watchdog_failed",
                failures=failures,
                threshold=threshold,
                host=resolve_listener_probe_host(),
                port=settings.worker_port,
            )
            if failures >= threshold:
                terminate_for_restart(
                    "worker_listener_not_accepting",
                    {
                        "failures": failures,
                        "threshold": threshold,
                        "host": resolve_listener_probe_host(),
                        "port": settings.worker_port,
                    },
                )

        stop_event.wait(settings.worker_listener_watchdog_interval_seconds)


def can_connect_worker_listener() -> bool:
    try:
        with socket.create_connection(
            (resolve_listener_probe_host(), settings.worker_port),
            timeout=settings.worker_listener_watchdog_timeout_seconds,
        ):
            return True
    except OSError:
        return False


def resolve_listener_probe_host() -> str:
    host = settings.worker_host.strip()
    if host in {"", "0.0.0.0", "::", "[::]"}:
        return "127.0.0.1"
    return host


def get_client() -> MT5Client:
    if _terminal_blocked:
        raise HTTPException(status_code=503, detail="MT5 terminal IPC is blocked after a timed-out SDK operation. Restart the worker before trading.")
    if _client is None or not _client._connected:
        raise HTTPException(status_code=503, detail="MT5 not connected. Call POST /connect first.")
    return _client


def get_operation_lock() -> asyncio.Lock:
    global _operation_lock
    if _operation_lock is None:
        _operation_lock = asyncio.Lock()
    return _operation_lock


def get_connect_lock() -> asyncio.Lock:
    global _connect_lock
    if _connect_lock is None:
        _connect_lock = asyncio.Lock()
    return _connect_lock


async def run_blocking_mt5_operation(
    operation: str,
    func,
    timeout_seconds: float | None = None,
):
    global _terminal_blocked

    if _terminal_blocked:
        raise HTTPException(status_code=503, detail="MT5 terminal IPC is blocked after a timed-out SDK operation. Restart the worker before trading.")

    lock = get_operation_lock()
    if lock.locked():
        raise HTTPException(status_code=503, detail=f"MT5 operation already in progress: {_worker_state.get('activeOperation')}")

    timeout = timeout_seconds if timeout_seconds is not None else settings.mt5_operation_timeout_seconds
    async with lock:
        started_at = time.time()
        _worker_state.update({
            "status": "busy",
            "activeOperation": operation,
            "lastError": None,
            "lastStartedAt": started_at,
            "lastFinishedAt": None,
        })
        try:
            result = await asyncio.wait_for(asyncio.to_thread(func), timeout=timeout)
            _worker_state.update({
                "status": "connected" if _client is not None and _client._connected else "disconnected",
                "activeOperation": None,
                "lastFinishedAt": time.time(),
            })
            return result
        except TimeoutError as exc:
            _terminal_blocked = True
            _worker_state.update({
                "status": "degraded",
                "activeOperation": None,
                "lastError": f"{operation} timed out after {timeout:.1f}s",
                "lastFinishedAt": time.time(),
            })
            log.error(
                "mt5_blocking_operation_timeout",
                operation=operation,
                timeout_seconds=timeout,
                elapsed_seconds=time.time() - started_at,
            )
            raise BlockingOperationTimeout(operation, timeout) from exc
        except Exception as exc:
            _worker_state.update({
                "status": "connected" if _client is not None and _client._connected else "disconnected",
                "activeOperation": None,
                "lastError": str(exc),
                "lastFinishedAt": time.time(),
            })
            raise


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------

def verify_access_key(x_worker_key: str = Header(default="")) -> None:
    key = settings.worker_access_key.strip()
    supplied_key = x_worker_key.strip()
    if not key or not supplied_key or not compare_digest(supplied_key, key):
        raise HTTPException(status_code=401, detail="Unauthorized")


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ConnectRequest(BaseModel):
    login: int
    password: str
    server: str


class SubmitOrderRequest(BaseModel):
    symbol: str
    side: str  # "buy" | "sell"
    volume: float
    orderType: str = "market"  # "market" | "limit" | "stop" | "stop_limit"
    price: float | None = None
    stopLoss: float | None = None
    takeProfit: float | None = None
    magic: int = 0
    comment: str = ""
    deviation: int = 20


class ModifyPositionRequest(BaseModel):
    ticket: int
    stopLoss: float | None = None
    takeProfit: float | None = None


class CancelOrderRequest(BaseModel):
    ticket: int


class ClosePositionRequest(BaseModel):
    ticket: int
    volume: float | None = None
    deviation: int = 20


class SymbolInfoRequest(BaseModel):
    symbols: list[str]


class GetOrderRequest(BaseModel):
    orderId: int = Field(gt=0)


class PositionClosuresRequest(BaseModel):
    lookbackHours: int = Field(default=24, ge=1, le=168)


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
    assert_expected_repo_path()
    log.info("mt5_worker_starting", port=settings.worker_port)
    install_loop_exception_handler()
    start_listener_watchdog()
    yield
    stop_listener_watchdog()
    # Disconnect on shutdown
    global _client
    if _client is not None:
        _client.disconnect()
        _client = None
    log.info("mt5_worker_stopped")


app = FastAPI(
    title="MT5 Trading Worker",
    description="HTTP server exposing MetaTrader 5 broker operations",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", dependencies=[Depends(verify_access_key)])
async def health() -> dict[str, Any]:
    connected = _client is not None and _client._connected and not _terminal_blocked
    return {
        "status": "degraded" if _terminal_blocked else "ok",
        "connected": connected,
        "login": _client.login if _client else None,
        "workerState": {
            **_worker_state,
            "terminalBlocked": _terminal_blocked,
        },
    }


@app.post("/connect", dependencies=[Depends(verify_access_key)])
async def connect(req: ConnectRequest) -> dict[str, Any]:
    """Initialize MT5 connection for a specific account."""
    connect_lock = get_connect_lock()
    if connect_lock.locked():
        return {
            "success": False,
            "error": "MT5 connect already in progress",
            "errorType": "connect_in_progress",
            "retryable": True,
        }

    async with connect_lock:
        def connect_blocking() -> dict[str, Any]:
            global _client

            if _client is not None:
                _client.disconnect()
                _client = None

            client = MT5Client(login=req.login, password=req.password, server=req.server)
            client.connect()
            _client = client
            return client.get_account_info()

        try:
            account_info = await run_blocking_mt5_operation(
                "connect",
                connect_blocking,
                settings.mt5_connect_timeout_seconds,
            )
        except MT5ConnectionError as exc:
            return {
                "success": False,
                "error": str(exc),
                "errorType": exc.error_type,
                "retryable": exc.retryable,
            }
        except BlockingOperationTimeout as exc:
            return {
                "success": False,
                "error": str(exc),
                "errorType": "timeout",
                "retryable": False,
            }

        return {
            "success": True,
            "accountInfo": account_info,
        }


@app.post("/disconnect", dependencies=[Depends(verify_access_key)])
async def disconnect() -> dict[str, Any]:
    global _client
    def disconnect_blocking() -> None:
        global _client
        if _client is not None:
            _client.disconnect()
            _client = None

    await run_blocking_mt5_operation("disconnect", disconnect_blocking)
    return {"success": True}


@app.get("/account", dependencies=[Depends(verify_access_key)])
async def get_account(client: MT5Client = Depends(get_client)) -> dict[str, Any]:
    return await run_blocking_mt5_operation("account", client.get_account_info)


@app.get("/positions", dependencies=[Depends(verify_access_key)])
async def get_positions(client: MT5Client = Depends(get_client)) -> list[dict[str, Any]]:
    return await run_blocking_mt5_operation("positions", client.get_positions)


@app.get("/orders", dependencies=[Depends(verify_access_key)])
async def get_orders(client: MT5Client = Depends(get_client)) -> list[dict[str, Any]]:
    return await run_blocking_mt5_operation("orders", client.get_open_orders)


@app.post("/order/submit", dependencies=[Depends(verify_access_key)])
async def submit_order(
    req: SubmitOrderRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    try:
        result = await run_blocking_mt5_operation(
            "order_submit",
            lambda: client.submit_order(
                symbol=req.symbol,
                side=req.side,
                volume=req.volume,
                order_type=req.orderType,
                price=req.price,
                stop_loss=req.stopLoss,
                take_profit=req.takeProfit,
                magic=req.magic,
                comment=req.comment,
                deviation=req.deviation,
            ),
        )
        return result
    except (ValueError, MT5ConnectionError, BlockingOperationTimeout) as exc:
        return {
            "success": False,
            "retcode": -1,
            "retcodeDescription": str(exc),
            "retcodeExternal": None,
            "orderId": "",
            "volume": 0.0,
            "price": 0.0,
            "comment": str(exc),
            "bid": None,
            "ask": None,
        }


@app.post("/order/modify", dependencies=[Depends(verify_access_key)])
async def modify_position(
    req: ModifyPositionRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    try:
        result = await run_blocking_mt5_operation(
            "order_modify",
            lambda: client.modify_position(
                ticket=req.ticket,
                stop_loss=req.stopLoss,
                take_profit=req.takeProfit,
            ),
        )
        return result
    except (ValueError, MT5ConnectionError, BlockingOperationTimeout) as exc:
        return {
            "success": False,
            "retcode": -1,
            "retcodeDescription": str(exc),
            "retcodeExternal": None,
            "orderId": "",
            "volume": 0.0,
            "price": 0.0,
            "comment": str(exc),
            "bid": None,
            "ask": None,
        }


@app.post("/order/cancel", dependencies=[Depends(verify_access_key)])
async def cancel_order(
    req: CancelOrderRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    try:
        result = await run_blocking_mt5_operation(
            "order_cancel",
            lambda: client.cancel_order(req.ticket),
        )
        return result
    except (ValueError, MT5ConnectionError, BlockingOperationTimeout) as exc:
        return {
            "success": False,
            "retcode": -1,
            "retcodeDescription": str(exc),
            "retcodeExternal": None,
            "orderId": str(req.ticket),
            "volume": 0.0,
            "price": 0.0,
            "comment": str(exc),
            "bid": None,
            "ask": None,
        }


@app.post("/order/cancel-all", dependencies=[Depends(verify_access_key)])
async def cancel_all_orders(
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    try:
        results = await run_blocking_mt5_operation(
            "order_cancel_all",
            client.cancel_all_orders,
        )
        return {
            "cancelled": sum(1 for result in results if result.get("success")),
            "results": results,
        }
    except (MT5ConnectionError, BlockingOperationTimeout) as exc:
        return {
            "cancelled": 0,
            "results": [{
                "success": False,
                "retcode": -1,
                "retcodeDescription": str(exc),
                "retcodeExternal": None,
                "orderId": "",
                "dealId": "",
                "volume": 0.0,
                "price": 0.0,
                "comment": str(exc),
                "bid": None,
                "ask": None,
            }],
        }


@app.post("/position/close", dependencies=[Depends(verify_access_key)])
async def close_position(
    req: ClosePositionRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    try:
        result = await run_blocking_mt5_operation(
            "position_close",
            lambda: client.close_position(
                ticket=req.ticket,
                volume=req.volume,
                deviation=req.deviation,
            ),
        )
        return result
    except (ValueError, MT5ConnectionError, BlockingOperationTimeout) as exc:
        return {
            "success": False,
            "retcode": -1,
            "retcodeDescription": str(exc),
            "retcodeExternal": None,
            "orderId": "",
            "volume": 0.0,
            "price": 0.0,
            "comment": str(exc),
            "bid": None,
            "ask": None,
        }


@app.post("/position/close-all", dependencies=[Depends(verify_access_key)])
async def close_all_positions(
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    try:
        results = await run_blocking_mt5_operation(
            "position_close_all",
            client.close_all_positions,
        )
        return {
            "closed": len(results),
            "results": results,
        }
    except (MT5ConnectionError, BlockingOperationTimeout) as exc:
        return {
            "closed": 0,
            "results": [{
                "success": False,
                "retcode": -1,
                "retcodeDescription": str(exc),
                "retcodeExternal": None,
                "orderId": "",
                "dealId": "",
                "volume": 0.0,
                "price": 0.0,
                "comment": str(exc),
                "bid": None,
                "ask": None,
            }],
        }


@app.post("/position/closures", dependencies=[Depends(verify_access_key)])
async def get_position_closures(
    req: PositionClosuresRequest,
    client: MT5Client = Depends(get_client),
) -> list[dict[str, Any]]:
    return await run_blocking_mt5_operation(
        "position_closures",
        lambda: client.get_position_closures(req.lookbackHours),
    )


@app.post("/symbol/info", dependencies=[Depends(verify_access_key)])
async def get_symbol_info(
    req: SymbolInfoRequest,
    client: MT5Client = Depends(get_client),
) -> list[dict[str, Any]]:
    return await run_blocking_mt5_operation(
        "symbol_info",
        lambda: client.get_symbol_info_batch(req.symbols),
    )


@app.post("/order/status", dependencies=[Depends(verify_access_key)])
async def get_order_status(
    req: GetOrderRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    result = await run_blocking_mt5_operation(
        "order_status",
        lambda: client.get_order(req.orderId),
    )
    if result is None:
        raise HTTPException(status_code=404, detail=f"Order {req.orderId} not found")
    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.worker_host,
        port=settings.worker_port,
        log_level="info",
    )
