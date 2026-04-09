"""MT5 Python worker -- FastAPI HTTP server exposing MT5 broker operations.

Architecture: The backend runtime (apps/backend/) calls this worker over HTTP.
This worker is stateless apart from the MT5 terminal session. It runs on a
Windows machine where the MetaTrader 5 SDK is available.
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
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


def get_client() -> MT5Client:
    if _client is None or not _client._connected:
        raise HTTPException(status_code=503, detail="MT5 not connected. Call POST /connect first.")
    return _client


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------

def verify_access_key(x_worker_key: str = Header(default="")) -> None:
    key = settings.worker_access_key.strip()
    if key and x_worker_key.strip() != key:
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
    orderId: int


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
    log.info("mt5_worker_starting", port=settings.worker_port)
    yield
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
    connected = _client is not None and _client._connected
    return {
        "status": "ok",
        "connected": connected,
        "login": _client.login if _client else None,
    }


@app.post("/connect", dependencies=[Depends(verify_access_key)])
async def connect(req: ConnectRequest) -> dict[str, Any]:
    """Initialize MT5 connection for a specific account."""
    global _client

    # Disconnect existing session if any
    if _client is not None:
        _client.disconnect()
        _client = None

    client = MT5Client(login=req.login, password=req.password, server=req.server)

    try:
        client.connect()
    except MT5ConnectionError as exc:
        return {
            "success": False,
            "error": str(exc),
            "errorType": exc.error_type,
            "retryable": exc.retryable,
        }

    _client = client
    account_info = client.get_account_info()

    return {
        "success": True,
        "accountInfo": account_info,
    }


@app.post("/disconnect", dependencies=[Depends(verify_access_key)])
async def disconnect() -> dict[str, Any]:
    global _client
    if _client is not None:
        _client.disconnect()
        _client = None
    return {"success": True}


@app.get("/account", dependencies=[Depends(verify_access_key)])
async def get_account(client: MT5Client = Depends(get_client)) -> dict[str, Any]:
    return client.get_account_info()


@app.get("/positions", dependencies=[Depends(verify_access_key)])
async def get_positions(client: MT5Client = Depends(get_client)) -> list[dict[str, Any]]:
    return client.get_positions()


@app.get("/orders", dependencies=[Depends(verify_access_key)])
async def get_orders(client: MT5Client = Depends(get_client)) -> list[dict[str, Any]]:
    return client.get_open_orders()


@app.post("/order/submit", dependencies=[Depends(verify_access_key)])
async def submit_order(
    req: SubmitOrderRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    try:
        result = client.submit_order(
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
        )
        return result
    except (ValueError, MT5ConnectionError) as exc:
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
        result = client.modify_position(
            ticket=req.ticket,
            stop_loss=req.stopLoss,
            take_profit=req.takeProfit,
        )
        return result
    except (ValueError, MT5ConnectionError) as exc:
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
        result = client.cancel_order(req.ticket)
        return result
    except (ValueError, MT5ConnectionError) as exc:
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
        results = client.cancel_all_orders()
        return {
            "cancelled": sum(1 for result in results if result.get("success")),
            "results": results,
        }
    except MT5ConnectionError as exc:
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
        result = client.close_position(
            ticket=req.ticket,
            volume=req.volume,
            deviation=req.deviation,
        )
        return result
    except (ValueError, MT5ConnectionError) as exc:
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
    results = client.close_all_positions()
    return {
        "closed": len(results),
        "results": results,
    }


@app.post("/symbol/info", dependencies=[Depends(verify_access_key)])
async def get_symbol_info(
    req: SymbolInfoRequest,
    client: MT5Client = Depends(get_client),
) -> list[dict[str, Any]]:
    return client.get_symbol_info_batch(req.symbols)


@app.post("/order/status", dependencies=[Depends(verify_access_key)])
async def get_order_status(
    req: GetOrderRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    result = client.get_order(req.orderId)
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
