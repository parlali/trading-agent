from __future__ import annotations

from pydantic import BaseModel, Field


class ConnectRequest(BaseModel):
    login: int
    password: str
    server: str


class SubmitOrderRequest(BaseModel):
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
