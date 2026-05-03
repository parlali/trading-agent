from __future__ import annotations

from typing import Any, NoReturn

from fastapi import HTTPException

from mt5_errors import MT5ConnectionError


class BlockingOperationTimeout(Exception):
    def __init__(self, operation: str, timeout_seconds: float):
        super().__init__(f"MT5 {operation} timed out after {timeout_seconds:.1f}s")
        self.operation = operation
        self.timeout_seconds = timeout_seconds


def raise_worker_http_error(
    error: str,
    error_type: str,
    retryable: bool,
    status_code: int = 503,
    details: dict[str, Any] | None = None,
) -> NoReturn:
    payload: dict[str, Any] = {
        "error": error,
        "errorType": error_type,
        "retryable": retryable,
    }
    if details:
        payload.update(details)

    raise HTTPException(status_code=status_code, detail=payload)


def raise_mt5_connection_http_error(exc: MT5ConnectionError) -> NoReturn:
    try:
        raise_worker_http_error(
            str(exc),
            exc.error_type,
            exc.retryable,
        )
    except HTTPException as http_exc:
        raise http_exc from exc


def raise_blocking_operation_http_error(exc: BlockingOperationTimeout) -> NoReturn:
    try:
        raise_worker_http_error(
            str(exc),
            "timeout",
            False,
            details={
                "operation": exc.operation,
                "timeoutSeconds": exc.timeout_seconds,
            },
        )
    except HTTPException as http_exc:
        raise http_exc from exc


def rejected_order_result(exc: Exception, order_id: str = "") -> dict[str, Any]:
    return {
        "success": False,
        "retcode": -1,
        "retcodeDescription": str(exc),
        "retcodeExternal": None,
        "orderId": order_id,
        "volume": 0.0,
        "price": 0.0,
        "comment": str(exc),
        "bid": None,
        "ask": None,
    }
