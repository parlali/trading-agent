from __future__ import annotations

from pydantic import BaseModel, Field


class AccountScopedRequest(BaseModel):
    login: int
    password: str
    server: str


class ConnectRequest(AccountScopedRequest):
    pass


class SubmitOrderRequest(AccountScopedRequest):
    symbol: str
    side: str
    volume: float
    orderType: str = "market"
    price: float | None = None
    stopLoss: float | None = None
    takeProfit: float | None = None
    magic: int = 0
    comment: str = ""
    deviation: int = 20


class ModifyOrderRequest(AccountScopedRequest):
    ticket: int
    price: float | None = None
    stopLoss: float | None = None
    takeProfit: float | None = None


class CancelOrderRequest(AccountScopedRequest):
    ticket: int


class ClosePositionRequest(AccountScopedRequest):
    ticket: int
    volume: float | None = None
    deviation: int = 20
    comment: str = "close"


class SymbolInfoRequest(AccountScopedRequest):
    symbols: list[str]


class GetOrderRequest(AccountScopedRequest):
    orderId: int = Field(gt=0)


class PositionClosuresRequest(AccountScopedRequest):
    lookbackHours: int = Field(default=24, ge=1, le=168)


class AccountPnlEventsRequest(AccountScopedRequest):
    lookbackHours: int = Field(default=24, ge=1, le=168)
