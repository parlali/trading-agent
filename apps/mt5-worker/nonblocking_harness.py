from __future__ import annotations

import asyncio
import time

from worker_test_stubs import install_dependency_stubs

install_dependency_stubs()
import main


class RestartRequested(Exception):
    def __init__(self, reason: str, details: dict[str, object] | None):
        super().__init__(reason)
        self.reason = reason
        self.details = details or {}


class FakeConnectedClient:
    login = 1

    def __init__(self) -> None:
        self._connected = True

    def disconnect(self) -> None:
        self._connected = False


async def run_harness() -> None:
    main.runtime.reset_state()

    def fake_terminate(reason: str, details: dict[str, object] | None = None) -> None:
        raise RestartRequested(reason, details)

    original_terminate = main.runtime.terminate_for_restart
    main.runtime.terminate_for_restart = fake_terminate

    preserved_client = FakeConnectedClient()
    main.runtime.client = preserved_client
    operation_lock = main.runtime._operation_lock_instance()
    await operation_lock.acquire()
    try:
        try:
            await main.runtime.connect(1, "secret", "broker")
        except main.HTTPException as exc:
            assert exc.status_code == 503
            assert exc.detail["errorType"] == "operation_in_progress"
        else:
            raise AssertionError("Expected connect to fail while operation lock is held")

        assert main.runtime.client is preserved_client
        assert preserved_client._connected is True

        try:
            await main.runtime.disconnect()
        except main.HTTPException as exc:
            assert exc.status_code == 503
            assert exc.detail["errorType"] == "operation_in_progress"
        else:
            raise AssertionError("Expected disconnect to fail while operation lock is held")

        assert main.runtime.client is preserved_client
        assert preserved_client._connected is True
    finally:
        operation_lock.release()
        main.runtime.client = None

    async def wedged_call() -> None:
        try:
            await main.runtime.run_operation(
                "connect",
                lambda: time.sleep(2),
                timeout_seconds=0.05,
            )
        except RestartRequested as exc:
            assert exc.reason == "mt5_sdk_operation_timeout"
            assert exc.details["operation"] == "connect"
            return

        raise AssertionError("Expected worker restart request")

    task = asyncio.create_task(wedged_call())
    await asyncio.sleep(0.01)
    during = await main.health()

    assert during["workerState"]["activeOperation"] == "connect"
    assert during["status"] == "ok"

    await task
    after = await main.health()

    assert after["status"] == "degraded"
    assert after["connected"] is False
    assert after["workerState"]["terminalBlocked"] is True
    main.runtime.terminate_for_restart = original_terminate
    main.runtime.shutdown()


if __name__ == "__main__":
    asyncio.run(run_harness())
