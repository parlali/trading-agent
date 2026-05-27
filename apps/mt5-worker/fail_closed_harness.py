from __future__ import annotations

import asyncio
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


class FakeBulkCancelMT5(FakeMT5):
    def orders_get(self, *args: object, **kwargs: object) -> tuple[FakeOrder, ...] | None:
        if "ticket" in kwargs:
            return None

        return (FakeOrder(),)


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


class FakeBulkCloseMT5(FakeMT5):
    def positions_get(self, *args: object, **kwargs: object) -> tuple[FakePosition, ...] | None:
        if "ticket" in kwargs:
            return None

        return (FakePosition(),)


class FakeRouteClient:
    login = 1

    def __init__(self, error: Exception):
        self.error = error
        self._connected = True

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
    main.runtime.client = FakeRouteClient(MT5ConnectionError("IPC recv failed", error_type="query_failed"))

    await assert_route_http_error(lambda: main.submit_order(
        main.SubmitOrderRequest(symbol="XAUUSD", side="buy", volume=0.01),
    ))

    main.runtime.client = FakeRouteClient(MT5ConnectionError("IPC recv failed", error_type="query_failed"))
    await assert_route_http_error(lambda: main.get_positions())

    main.runtime.client = FakeRouteClient(ValueError("Position 202 not found"))
    try:
        result = await main.close_position(
            main.ClosePositionRequest(ticket=202),
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

        mt5_client.mt5 = FakeBulkCancelMT5()
        assert_query_failure(client.cancel_all_orders)

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

        mt5_client.mt5 = FakeBulkCloseMT5()
        assert_query_failure(client.close_all_positions)

        def failing_close(ticket: int, deviation: int = 20) -> object:
            raise ValueError(f"Position {ticket} not found")

        client.close_position = failing_close
        results = client.close_all_positions()
        assert results[0]["success"] is False
        assert "Position 202 not found" in results[0]["retcodeDescription"]
    finally:
        mt5_client.mt5 = original_mt5

    asyncio.run(run_endpoint_harness())


if __name__ == "__main__":
    run_harness()
