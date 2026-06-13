from __future__ import annotations

import asyncio
import time
from typing import Any

from worker_test_stubs import install_dependency_stubs

install_dependency_stubs()
import main
import mt5_client
from mt5_client import MT5Client, MT5ConnectionError


class FakeAccountClient:
    def __init__(self, login: int, server: str):
        self.login = login
        self.server = server
        self._connected = True
        self.sdk_login = login
        self.position_calls = 0
        self.login_assertions: list[int] = []

    def assert_session_login(self, expected_login: int) -> None:
        self.login_assertions.append(int(expected_login))
        if int(self.sdk_login) != int(expected_login):
            self._connected = False
            raise MT5ConnectionError(
                f"MT5 active session login {self.sdk_login} does not match requested login {expected_login}",
                error_type="session_login_mismatch",
                retryable=False,
            )

    def get_account_info(self) -> dict[str, Any]:
        return {"login": self.sdk_login, "equity": 1000.0}

    def get_positions(self) -> list[dict[str, Any]]:
        self.position_calls += 1
        return [{"ticket": 1000 + int(self.login), "sessionLogin": int(self.sdk_login)}]

    def disconnect(self) -> None:
        self._connected = False


class SlowAccountClient(FakeAccountClient):
    def get_positions(self) -> list[dict[str, Any]]:
        time.sleep(0.05)
        active = main.runtime.client
        assert active is self, "MT5 session was swapped while an account operation was in flight"
        return super().get_positions()


def credentials(login: int, server: str, password: str = "pw") -> Any:
    return main.AccountScopedRequest(login=login, password=password, server=server)


def install_fake_connect(target_login_to_client: dict[int, FakeAccountClient]) -> list[tuple[int, str, str]]:
    calls: list[tuple[int, str, str]] = []

    async def fake_connect(login: int, password: str, server: str) -> dict[str, Any]:
        calls.append((int(login), password, server))
        client = target_login_to_client.get(int(login))
        if client is None:
            return {
                "success": False,
                "error": f"no terminal for login {login}",
                "errorType": "login_failed",
                "retryable": False,
            }
        main.runtime.client = client
        return {
            "success": True,
            "accountInfo": {"login": int(client.sdk_login)},
        }

    main.runtime.connect = fake_connect
    return calls


async def expect_http_error(coro: Any, error_type: str) -> Any:
    try:
        await coro
    except main.HTTPException as exc:
        assert exc.status_code == 503
        assert isinstance(exc.detail, dict)
        assert exc.detail["errorType"] == error_type, exc.detail
        return exc.detail

    raise AssertionError(f"Expected HTTP 503 with errorType {error_type}")


async def assert_reconnects_and_serves_requested_login() -> None:
    main.runtime.reset_state()
    client_a = FakeAccountClient(1, "Broker-A")
    client_b = FakeAccountClient(2, "Broker-B")
    main.runtime.client = client_b
    calls = install_fake_connect({1: client_a})

    rows = await main.get_positions(credentials(1, "Broker-A", "pw-a"))

    assert calls == [(1, "pw-a", "Broker-A")]
    assert rows == [{"ticket": 1001, "sessionLogin": 1}]
    assert client_a.login_assertions == [1]
    assert client_b.position_calls == 0


async def assert_serves_without_reconnect_when_login_matches() -> None:
    main.runtime.reset_state()
    client_a = FakeAccountClient(1, "Broker-A")
    main.runtime.client = client_a
    calls = install_fake_connect({})

    rows = await main.get_positions(credentials(1, "Broker-A"))

    assert calls == []
    assert rows == [{"ticket": 1001, "sessionLogin": 1}]
    assert client_a.login_assertions == [1]


async def assert_fails_closed_when_reconnect_lands_on_wrong_login() -> None:
    main.runtime.reset_state()
    wrong_client = FakeAccountClient(2, "Broker-A")
    main.runtime.client = None

    async def wrong_login_connect(login: int, password: str, server: str) -> dict[str, Any]:
        main.runtime.client = wrong_client
        return {
            "success": True,
            "accountInfo": {"login": int(wrong_client.sdk_login)},
        }

    main.runtime.connect = wrong_login_connect

    detail = await expect_http_error(
        main.get_positions(credentials(1, "Broker-A")),
        "session_login_mismatch",
    )

    assert detail["retryable"] is False
    assert wrong_client.position_calls == 0


async def assert_fails_closed_when_reconnect_fails() -> None:
    main.runtime.reset_state()
    main.runtime.client = FakeAccountClient(2, "Broker-B")
    install_fake_connect({})

    detail = await expect_http_error(
        main.get_positions(credentials(1, "Broker-A")),
        "login_failed",
    )

    assert detail["retryable"] is False


async def assert_fails_closed_on_sdk_login_drift() -> None:
    main.runtime.reset_state()
    drifted = FakeAccountClient(1, "Broker-A")
    drifted.sdk_login = 2
    main.runtime.client = drifted
    install_fake_connect({})

    detail = await expect_http_error(
        main.get_positions(credentials(1, "Broker-A")),
        "session_login_mismatch",
    )

    assert detail["retryable"] is False
    assert drifted.position_calls == 0


async def assert_concurrent_accounts_serialize_without_crosstalk() -> None:
    main.runtime.reset_state()
    client_a = SlowAccountClient(1, "Broker-A")
    client_b = SlowAccountClient(2, "Broker-B")
    main.runtime.client = None
    install_fake_connect({1: client_a, 2: client_b})

    rows_a, rows_b = await asyncio.gather(
        main.get_positions(credentials(1, "Broker-A")),
        main.get_positions(credentials(2, "Broker-B")),
    )

    assert rows_a == [{"ticket": 1001, "sessionLogin": 1}]
    assert rows_b == [{"ticket": 1002, "sessionLogin": 2}]
    assert client_a.position_calls == 1
    assert client_b.position_calls == 1


def assert_real_client_login_verification() -> None:
    class FakeInfo:
        login = 2

    class FakeSDK:
        def terminal_info(self) -> object:
            return object()

        def account_info(self) -> FakeInfo:
            return FakeInfo()

        def last_error(self) -> tuple[int, str]:
            return (0, "ok")

    original_sdk = mt5_client.mt5
    mt5_client.mt5 = FakeSDK()
    try:
        client = MT5Client(login=2, password="pw", server="Broker")
        client._connected = True
        client.assert_session_login(2)
        assert client._connected is True

        try:
            client.assert_session_login(1)
        except MT5ConnectionError as exc:
            assert exc.error_type == "session_login_mismatch"
            assert exc.retryable is False
            assert client._connected is False
        else:
            raise AssertionError("Expected session_login_mismatch for drifted SDK login")
    finally:
        mt5_client.mt5 = original_sdk


async def run_harness() -> None:
    original_connect = main.runtime.connect

    try:
        await assert_reconnects_and_serves_requested_login()
        await assert_serves_without_reconnect_when_login_matches()
        await assert_fails_closed_when_reconnect_lands_on_wrong_login()
        await assert_fails_closed_when_reconnect_fails()
        await assert_fails_closed_on_sdk_login_drift()
        await assert_concurrent_accounts_serialize_without_crosstalk()
        assert_real_client_login_verification()
    finally:
        main.runtime.connect = original_connect
        main.runtime.client = None
        main.runtime.shutdown()


if __name__ == "__main__":
    asyncio.run(run_harness())
    print("session_identity_harness passed")
