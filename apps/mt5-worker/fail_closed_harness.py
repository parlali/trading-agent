from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Callable

from worker_test_stubs import install_dependency_stubs

install_dependency_stubs()
import mt5_client
from mt5_client import MT5Client, MT5ConnectionError


class FakeMT5:
    def terminal_info(self) -> object:
        return object()

    def last_error(self) -> tuple[int, str]:
        return (-10002, "IPC recv failed")

    def account_info(self) -> None:
        return None

    def positions_get(self, *args: object, **kwargs: object) -> None:
        return None

    def orders_get(self, *args: object, **kwargs: object) -> None:
        return None

    def history_deals_get(self, *args: object, **kwargs: object) -> None:
        return None

    def symbol_select(self, symbol: str, enabled: bool) -> bool:
        return True

    def symbol_info(self, symbol: str) -> None:
        return None


class FakeTransientSymbolSelectMT5(FakeMT5):
    def last_error(self) -> tuple[int, str]:
        return (-1, "Terminal: Call failed")

    def symbol_select(self, symbol: str, enabled: bool) -> bool:
        return False


class FakeMissingSymbolMT5(FakeMT5):
    def last_error(self) -> tuple[int, str]:
        return (4302, "Symbol not found")

    def symbol_select(self, symbol: str, enabled: bool) -> bool:
        return False


class FakeOrder:
    ticket = 101


class FakePosition:
    ticket = 202


class FakeCancelOrder:
    ticket = 303
    symbol = "XAUUSD"
    magic = 123


class FakeOrderSendResult:
    retcode = 10009
    retcode_external = 0
    order = 303
    deal = 0
    volume = 0.0
    price = 0.0
    comment = "Request executed"
    bid = 0.0
    ask = 0.0


class FakePendingModifyOrder:
    ticket = 404
    symbol = "XAUUSD"
    price_open = 4715.5
    sl = 4700.0
    tp = 4730.0


class FakeHistoryStatusOrder:
    ticket = 505
    symbol = "XAGUSD"
    type = 1
    volume_initial = 0.01
    volume_current = 0.0
    price_open = 62.048
    sl = 62.105
    tp = 61.51
    state = 4
    time_done_msc = 1_782_203_000_000
    time_done = 1_782_203_000


class FakeInvalidTicketHistoryMT5(FakeMT5):
    def last_error(self) -> tuple[int, str]:
        return (-2, "Terminal: Invalid params")

    def orders_get(self, *args: object, **kwargs: object) -> tuple[object, ...]:
        return ()

    def positions_get(self, *args: object, **kwargs: object) -> tuple[object, ...]:
        return ()

    def history_deals_get(self, *args: object, **kwargs: object) -> tuple[object, ...] | None:
        if "ticket" in kwargs and len(args) == 0:
            return None

        return ()

    def history_orders_get(self, *args: object, **kwargs: object) -> tuple[FakeHistoryStatusOrder, ...] | None:
        if "ticket" in kwargs and len(args) == 0:
            return None

        return (FakeHistoryStatusOrder(),)


class FakeFutureCloseDeal:
    ticket = 606
    order = 707
    position_id = 808
    symbol = "XAUUSD"
    type = 1
    entry = 1
    volume = 0.01
    price = 4024.37
    profit = -1.35
    swap = 0.0
    commission = 0.0
    fee = 0.0
    comment = "[sl 4024.55]"
    time_msc = 1_782_765_531_000
    time = 1_782_765_531
    reason = 4


class FakeFutureHistoryMT5(FakeMT5):
    DEAL_TYPE_BUY = 0
    DEAL_TYPE_SELL = 1
    DEAL_ENTRY_IN = 0
    DEAL_ENTRY_OUT = 1
    DEAL_ENTRY_INOUT = 3
    DEAL_ENTRY_OUT_BY = 4

    def last_error(self) -> tuple[int, str]:
        return (1, "Success")

    def history_deals_get(self, *args: object, **kwargs: object) -> tuple[FakeFutureCloseDeal, ...]:
        if len(args) >= 2 and isinstance(args[1], datetime):
            end = args[1]
            if end > datetime.now(timezone.utc) + timedelta(hours=1):
                return (FakeFutureCloseDeal(),)

        return ()


class FakeCancelRequestMT5(FakeMT5):
    TRADE_ACTION_REMOVE = 8
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_DONE_PARTIAL = 10010

    def __init__(self) -> None:
        self.requests: list[dict[str, object]] = []

    def orders_get(self, *args: object, **kwargs: object) -> tuple[FakeCancelOrder, ...] | None:
        if kwargs.get("ticket") == FakeCancelOrder.ticket:
            return (FakeCancelOrder(),)

        return ()

    def order_send(self, request: dict[str, object]) -> FakeOrderSendResult:
        self.requests.append(request)
        return FakeOrderSendResult()


class FakeModifyPendingOrderMT5(FakeMT5):
    TRADE_ACTION_MODIFY = 5
    ORDER_TIME_GTC = 0
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_DONE_PARTIAL = 10010

    def __init__(self) -> None:
        self.requests: list[dict[str, object]] = []

    def orders_get(self, *args: object, **kwargs: object) -> tuple[FakePendingModifyOrder, ...]:
        if kwargs.get("ticket") == FakePendingModifyOrder.ticket:
            return (FakePendingModifyOrder(),)

        return ()

    def positions_get(self, *args: object, **kwargs: object) -> tuple[object, ...]:
        return ()

    def order_send(self, request: dict[str, object]) -> FakeOrderSendResult:
        self.requests.append(request)
        return FakeOrderSendResult()


ROUTE_CREDENTIALS = {
    "login": 1,
    "password": "secret",
    "server": "broker",
}


class FakeRouteClient:
    login = 1
    server = "broker"

    def __init__(self, error: Exception):
        self.error = error
        self._connected = True
        self.login_assertions: list[int] = []

    def assert_session_login(self, expected_login: int) -> None:
        self.login_assertions.append(int(expected_login))
        assert int(expected_login) == int(self.login)

    def submit_order(self, **kwargs: object) -> object:
        raise self.error

    def close_position(self, **kwargs: object) -> object:
        raise self.error

    def get_positions(self) -> object:
        raise self.error

    def disconnect(self) -> None:
        self._connected = False


def assert_query_failure(call: Callable[[], object]) -> None:
    try:
        call()
    except MT5ConnectionError as exc:
        assert exc.error_type == "query_failed"
        assert "IPC recv failed" in str(exc)
        return

    raise AssertionError("Expected MT5ConnectionError")


def assert_transient_symbol_select_failure(client: MT5Client, call: Callable[[], object]) -> None:
    client._connected = True
    try:
        call()
    except MT5ConnectionError as exc:
        assert exc.error_type == "query_failed"
        assert exc.retryable is True
        assert "Terminal: Call failed" in str(exc)
        assert client._connected is False
        return

    raise AssertionError("Expected transient MT5ConnectionError")


def assert_missing_symbol_failure(client: MT5Client, call: Callable[[], object]) -> None:
    client._connected = True
    try:
        call()
    except MT5ConnectionError as exc:
        assert exc.error_type == "symbol_unavailable"
        assert exc.retryable is False
        assert "Symbol not found" in str(exc)
        assert client._connected is True
        return

    raise AssertionError("Expected symbol_unavailable MT5ConnectionError")


async def assert_route_http_error(call: Callable[[], object]) -> None:
    import main

    try:
        await call()
    except main.HTTPException as exc:
        assert exc.status_code == 503
        assert isinstance(exc.detail, dict)
        assert exc.detail["errorType"] == "query_failed"
        assert "IPC recv failed" in exc.detail["error"]
        return

    raise AssertionError("Expected structured HTTP 503")


async def run_endpoint_harness() -> None:
    import main

    main.runtime.reset_state()
    submit_client = FakeRouteClient(MT5ConnectionError("IPC recv failed", error_type="query_failed"))
    main.runtime.client = submit_client

    await assert_route_http_error(lambda: main.submit_order(
        main.SubmitOrderRequest(symbol="XAUUSD", side="buy", volume=0.01, **ROUTE_CREDENTIALS),
    ))
    assert submit_client.login_assertions == [1, 1]

    main.runtime.client = FakeRouteClient(MT5ConnectionError("IPC recv failed", error_type="query_failed"))
    await assert_route_http_error(lambda: main.get_positions(
        main.AccountScopedRequest(**ROUTE_CREDENTIALS),
    ))

    main.runtime.client = FakeRouteClient(ValueError("Position 202 not found"))
    try:
        result = await main.close_position(
            main.ClosePositionRequest(ticket=202, **ROUTE_CREDENTIALS),
        )
        assert result["success"] is False
        assert result["orderId"] == ""
        assert "Position 202 not found" in result["retcodeDescription"]
    finally:
        main.runtime.client = None

    main.runtime.shutdown()


def run_harness() -> None:
    original_mt5 = mt5_client.mt5
    mt5_client.mt5 = FakeMT5()
    client = MT5Client(login=1, password="secret", server="broker")
    client._connected = True

    try:
        assert_query_failure(client.get_account_info)
        assert_query_failure(client.get_positions)
        assert_query_failure(client.get_open_orders)
        assert_query_failure(client.get_position_closures)
        assert_query_failure(lambda: client.get_symbol_info("XAUUSD"))

        mt5_client.mt5 = FakeTransientSymbolSelectMT5()
        assert_transient_symbol_select_failure(client, lambda: client.get_symbol_info("XAUUSD"))
        assert_transient_symbol_select_failure(client, lambda: client.submit_order(
            symbol="XAUUSD",
            side="buy",
            volume=0.01,
        ))

        mt5_client.mt5 = FakeMissingSymbolMT5()
        assert_missing_symbol_failure(client, lambda: client.get_symbol_info("DOESNOTEXIST"))
        assert_missing_symbol_failure(client, lambda: client.submit_order(
            symbol="DOESNOTEXIST",
            side="buy",
            volume=0.01,
        ))

        mt5_client.mt5 = FakeInvalidTicketHistoryMT5()
        status = client.get_order(FakeHistoryStatusOrder.ticket)
        assert status["ticket"] == FakeHistoryStatusOrder.ticket
        assert status["symbol"] == "XAGUSD"
        assert status["state"] == "filled"

        mt5_client.mt5 = FakeFutureHistoryMT5()
        original_future_buffer = mt5_client.settings.mt5_history_future_buffer_hours
        mt5_client.settings.mt5_history_future_buffer_hours = 12
        try:
            closures = client.get_position_closures(24)
        finally:
            mt5_client.settings.mt5_history_future_buffer_hours = original_future_buffer
        assert len(closures) == 1
        assert closures[0]["positionId"] == FakeFutureCloseDeal.position_id
        assert closures[0]["profit"] == FakeFutureCloseDeal.profit

        cancel_mt5 = FakeCancelRequestMT5()
        mt5_client.mt5 = cancel_mt5
        cancel_result = client.cancel_order(FakeCancelOrder.ticket)
        assert cancel_result["success"] is True
        assert cancel_mt5.requests == [{
            "action": cancel_mt5.TRADE_ACTION_REMOVE,
            "order": FakeCancelOrder.ticket,
        }]

        modify_mt5 = FakeModifyPendingOrderMT5()
        mt5_client.mt5 = modify_mt5
        modify_result = client.modify_order(
            FakePendingModifyOrder.ticket,
            price=4716.0,
            stop_loss=4705.0,
            take_profit=4735.0,
        )
        assert modify_result["success"] is True
        assert modify_mt5.requests == [{
            "action": modify_mt5.TRADE_ACTION_MODIFY,
            "order": FakePendingModifyOrder.ticket,
            "symbol": FakePendingModifyOrder.symbol,
            "price": 4716.0,
            "sl": 4705.0,
            "tp": 4735.0,
            "type_time": modify_mt5.ORDER_TIME_GTC,
        }]

    finally:
        mt5_client.mt5 = original_mt5

    asyncio.run(run_endpoint_harness())


if __name__ == "__main__":
    run_harness()
