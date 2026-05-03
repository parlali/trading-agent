from __future__ import annotations

from contextlib import asynccontextmanager
from secrets import compare_digest
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException

from config import settings
from mt5_client import MT5Client
from worker_contracts import rejected_order_result
from worker_models import (
    CancelOrderRequest,
    ClosePositionRequest,
    ConnectRequest,
    GetOrderRequest,
    ModifyPositionRequest,
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


def get_client() -> MT5Client:
    return runtime.require_client()


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


@app.get("/account", dependencies=[Depends(verify_access_key)])
async def get_account(client: MT5Client = Depends(get_client)) -> dict[str, Any]:
    return await runtime.run_http_operation("account", client.get_account_info)


@app.get("/positions", dependencies=[Depends(verify_access_key)])
async def get_positions(client: MT5Client = Depends(get_client)) -> list[dict[str, Any]]:
    return await runtime.run_http_operation("positions", client.get_positions)


@app.get("/orders", dependencies=[Depends(verify_access_key)])
async def get_orders(client: MT5Client = Depends(get_client)) -> list[dict[str, Any]]:
    return await runtime.run_http_operation("orders", client.get_open_orders)


@app.post("/order/submit", dependencies=[Depends(verify_access_key)])
async def submit_order(
    req: SubmitOrderRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    try:
        return await runtime.run_http_operation(
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
    except ValueError as exc:
        return rejected_order_result(exc)


@app.post("/order/modify", dependencies=[Depends(verify_access_key)])
async def modify_position(
    req: ModifyPositionRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    try:
        return await runtime.run_http_operation(
            "order_modify",
            lambda: client.modify_position(
                ticket=req.ticket,
                stop_loss=req.stopLoss,
                take_profit=req.takeProfit,
            ),
        )
    except ValueError as exc:
        return rejected_order_result(exc)


@app.post("/order/cancel", dependencies=[Depends(verify_access_key)])
async def cancel_order(
    req: CancelOrderRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    try:
        return await runtime.run_http_operation(
            "order_cancel",
            lambda: client.cancel_order(req.ticket),
        )
    except ValueError as exc:
        return rejected_order_result(exc, str(req.ticket))


@app.post("/order/cancel-all", dependencies=[Depends(verify_access_key)])
async def cancel_all_orders(
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    results = await runtime.run_http_operation(
        "order_cancel_all",
        client.cancel_all_orders,
    )
    return {
        "cancelled": sum(1 for result in results if result.get("success")),
        "results": results,
    }


@app.post("/position/close", dependencies=[Depends(verify_access_key)])
async def close_position(
    req: ClosePositionRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    try:
        return await runtime.run_http_operation(
            "position_close",
            lambda: client.close_position(
                ticket=req.ticket,
                volume=req.volume,
                deviation=req.deviation,
            ),
        )
    except ValueError as exc:
        return rejected_order_result(exc)


@app.post("/position/close-all", dependencies=[Depends(verify_access_key)])
async def close_all_positions(
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    results = await runtime.run_http_operation(
        "position_close_all",
        client.close_all_positions,
    )
    return {
        "closed": sum(1 for result in results if result.get("success")),
        "results": results,
    }


@app.post("/position/closures", dependencies=[Depends(verify_access_key)])
async def get_position_closures(
    req: PositionClosuresRequest,
    client: MT5Client = Depends(get_client),
) -> list[dict[str, Any]]:
    return await runtime.run_http_operation(
        "position_closures",
        lambda: client.get_position_closures(req.lookbackHours),
    )


@app.post("/symbol/info", dependencies=[Depends(verify_access_key)])
async def get_symbol_info(
    req: SymbolInfoRequest,
    client: MT5Client = Depends(get_client),
) -> list[dict[str, Any]]:
    return await runtime.run_http_operation(
        "symbol_info",
        lambda: client.get_symbol_info_batch(req.symbols),
    )


@app.post("/order/status", dependencies=[Depends(verify_access_key)])
async def get_order_status(
    req: GetOrderRequest,
    client: MT5Client = Depends(get_client),
) -> dict[str, Any]:
    result = await runtime.run_http_operation(
        "order_status",
        lambda: client.get_order(req.orderId),
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
