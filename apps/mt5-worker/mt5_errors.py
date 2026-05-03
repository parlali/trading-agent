from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class MT5ErrorDetails:
    code: int
    message: str
    raw: Any


class MT5ConnectionError(Exception):
    def __init__(self, message: str, error_type: str = "unknown", retryable: bool = True):
        super().__init__(message)
        self.error_type = error_type
        self.retryable = retryable


def read_mt5_error_details(mt5_module: Any) -> MT5ErrorDetails:
    err = mt5_module.last_error()
    code = 0
    message = "unknown MT5 SDK error"

    if isinstance(err, tuple) and len(err) >= 2:
        try:
            code = int(err[0])
        except (TypeError, ValueError):
            code = 0
        message = str(err[1]).strip() or message

    return MT5ErrorDetails(code=code, message=message, raw=err)


def classify_connection_error(err: tuple[Any, Any] | None) -> dict[str, Any]:
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
