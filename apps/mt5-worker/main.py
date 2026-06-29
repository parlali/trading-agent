from __future__ import annotations

from contextlib import asynccontextmanager
from secrets import compare_digest
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException

from config import settings
from worker_contracts import rejected_order_result
from worker_models import (
    AccountScopedRequest,
    AccountPnlEventsRequest,
    CancelOrderRequest,
    ClosePositionRequest,
    ConnectRequest,
    GetOrderRequest,
    ModifyOrderRequest,
    PositionClosuresRequest,
    SubmitOrderRequest,
    SymbolInfoRequest,
)
from worker_runtime import MT5WorkerRuntime

runtime = MT5WorkerRuntime(settings)


def verify_access_key(x_worker_key: str = Header(default="")) -> None:
    key = settings.worker_access_key.strip()
    supplied_key = x_worker_key.strip()
    if not key or not supplied_key or not compare_digest(supplied_key, key):
        raise HTTPException(status_code=401, detail="Unauthorized")


@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
    runtime.startup()
    yield
    runtime.shutdown()


app = FastAPI(
    title="MT5 Trading Worker",
    description="HTTP server exposing MetaTrader 5 broker operations",
    lifespan=lifespan,
)


@app.get("/health", dependencies=[Depends(verify_access_key)])
async def health() -> dict[str, Any]:
    return runtime.health()


@app.post("/connect", dependencies=[Depends(verify_access_key)])
async def connect(req: ConnectRequest) -> dict[str, Any]:
    return await runtime.connect(req.login, req.password, req.server)


@app.post("/disconnect", dependencies=[Depends(verify_access_key)])
async def disconnect() -> dict[str, Any]:
    return await runtime.disconnect()


@app.post("/account", dependencies=[Depends(verify_access_key)])
async def get_account(req: AccountScopedRequest) -> dict[str, Any]:
    return await runtime.run_account_operation("account", req, lambda client: client.get_account_info())


@app.post("/positions", dependencies=[Depends(verify_access_key)])
async def get_positions(req: AccountScopedRequest) -> list[dict[str, Any]]:
    return await runtime.run_account_operation("positions", req, lambda client: client.get_positions())


@app.post("/orders", dependencies=[Depends(verify_access_key)])
async def get_orders(req: AccountScopedRequest) -> list[dict[str, Any]]:
    return await runtime.run_account_operation("orders", req, lambda client: client.get_open_orders())


@app.post("/order/submit", dependencies=[Depends(verify_access_key)])
async def submit_order(
    req: SubmitOrderRequest,
) -> dict[str, Any]:
    try:
        return await runtime.run_account_operation(
            "order_submit",
            req,
            lambda client: client.submit_order(
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
    except ValueError as exc:
        return rejected_order_result(exc)


@app.post("/order/modify", dependencies=[Depends(verify_access_key)])
async def modify_order(
    req: ModifyOrderRequest,
) -> dict[str, Any]:
    try:
        return await runtime.run_account_operation(
            "order_modify",
            req,
            lambda client: client.modify_order(
                ticket=req.ticket,
                price=req.price,
                stop_loss=req.stopLoss,
                take_profit=req.takeProfit,
            ),
        )
    except ValueError as exc:
        return rejected_order_result(exc)


@app.post("/order/cancel", dependencies=[Depends(verify_access_key)])
async def cancel_order(
    req: CancelOrderRequest,
) -> dict[str, Any]:
    try:
        return await runtime.run_account_operation(
            "order_cancel",
            req,
            lambda client: client.cancel_order(req.ticket),
        )
    except ValueError as exc:
        return rejected_order_result(exc, str(req.ticket))


@app.post("/position/close", dependencies=[Depends(verify_access_key)])
async def close_position(
    req: ClosePositionRequest,
) -> dict[str, Any]:
    try:
        return await runtime.run_account_operation(
            "position_close",
            req,
            lambda client: client.close_position(
                ticket=req.ticket,
                volume=req.volume,
                deviation=req.deviation,
                comment=req.comment,
            ),
        )
    except ValueError as exc:
        return rejected_order_result(exc)


@app.post("/position/closures", dependencies=[Depends(verify_access_key)])
async def get_position_closures(
    req: PositionClosuresRequest,
) -> list[dict[str, Any]]:
    return await runtime.run_account_operation(
        "position_closures",
        req,
        lambda client: client.get_position_closures(req.lookbackHours),
    )


@app.post("/account/pnl-events", dependencies=[Depends(verify_access_key)])
async def get_account_pnl_events(
    req: AccountPnlEventsRequest,
) -> list[dict[str, Any]]:
    return await runtime.run_account_operation(
        "account_pnl_events",
        req,
        lambda client: client.get_account_pnl_events(req.lookbackHours),
    )


@app.post("/symbol/info", dependencies=[Depends(verify_access_key)])
async def get_symbol_info(
    req: SymbolInfoRequest,
) -> list[dict[str, Any]]:
    return await runtime.run_account_operation(
        "symbol_info",
        req,
        lambda client: client.get_symbol_info_batch(req.symbols),
    )


@app.post("/order/status", dependencies=[Depends(verify_access_key)])
async def get_order_status(
    req: GetOrderRequest,
) -> dict[str, Any]:
    result = await runtime.run_account_operation(
        "order_status",
        req,
        lambda client: client.get_order(req.orderId),
    )
    if result is None:
        raise HTTPException(status_code=404, detail=f"Order {req.orderId} not found")
    return result


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.worker_host,
        port=settings.worker_port,
        log_level="info",
    )
