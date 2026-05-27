from __future__ import annotations

from contextlib import asynccontextmanager
from secrets import compare_digest
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException

from config import settings
from worker_contracts import rejected_order_result
from worker_models import (
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


@app.get("/account", dependencies=[Depends(verify_access_key)])
async def get_account() -> dict[str, Any]:
    return await runtime.run_client_http_operation("account", lambda client: client.get_account_info())


@app.get("/positions", dependencies=[Depends(verify_access_key)])
async def get_positions() -> list[dict[str, Any]]:
    return await runtime.run_client_http_operation("positions", lambda client: client.get_positions())


@app.get("/orders", dependencies=[Depends(verify_access_key)])
async def get_orders() -> list[dict[str, Any]]:
    return await runtime.run_client_http_operation("orders", lambda client: client.get_open_orders())


@app.post("/order/submit", dependencies=[Depends(verify_access_key)])
async def submit_order(
    req: SubmitOrderRequest,
) -> dict[str, Any]:
    try:
        return await runtime.run_client_http_operation(
            "order_submit",
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
        return await runtime.run_client_http_operation(
            "order_modify",
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
        return await runtime.run_client_http_operation(
            "order_cancel",
            lambda client: client.cancel_order(req.ticket),
        )
    except ValueError as exc:
        return rejected_order_result(exc, str(req.ticket))


@app.post("/order/cancel-all", dependencies=[Depends(verify_access_key)])
async def cancel_all_orders() -> dict[str, Any]:
    results = await runtime.run_client_http_operation(
        "order_cancel_all",
        lambda client: client.cancel_all_orders(),
    )
    return {
        "cancelled": sum(1 for result in results if result.get("success")),
        "results": results,
    }


@app.post("/position/close", dependencies=[Depends(verify_access_key)])
async def close_position(
    req: ClosePositionRequest,
) -> dict[str, Any]:
    try:
        return await runtime.run_client_http_operation(
            "position_close",
            lambda client: client.close_position(
                ticket=req.ticket,
                volume=req.volume,
                deviation=req.deviation,
            ),
        )
    except ValueError as exc:
        return rejected_order_result(exc)


@app.post("/position/close-all", dependencies=[Depends(verify_access_key)])
async def close_all_positions() -> dict[str, Any]:
    results = await runtime.run_client_http_operation(
        "position_close_all",
        lambda client: client.close_all_positions(),
    )
    return {
        "closed": sum(1 for result in results if result.get("success")),
        "results": results,
    }


@app.post("/position/closures", dependencies=[Depends(verify_access_key)])
async def get_position_closures(
    req: PositionClosuresRequest,
) -> list[dict[str, Any]]:
    return await runtime.run_client_http_operation(
        "position_closures",
        lambda client: client.get_position_closures(req.lookbackHours),
    )


@app.post("/symbol/info", dependencies=[Depends(verify_access_key)])
async def get_symbol_info(
    req: SymbolInfoRequest,
) -> list[dict[str, Any]]:
    return await runtime.run_client_http_operation(
        "symbol_info",
        lambda client: client.get_symbol_info_batch(req.symbols),
    )


@app.post("/order/status", dependencies=[Depends(verify_access_key)])
async def get_order_status(
    req: GetOrderRequest,
) -> dict[str, Any]:
    result = await runtime.run_client_http_operation(
        "order_status",
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
