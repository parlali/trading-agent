from __future__ import annotations

import asyncio
import time

import main


async def run_harness() -> None:
    main._terminal_blocked = False
    main._worker_state.update({
        "status": "disconnected",
        "activeOperation": None,
        "lastError": None,
        "lastStartedAt": None,
        "lastFinishedAt": None,
    })

    async def wedged_call() -> None:
        try:
            await main.run_blocking_mt5_operation(
                "connect",
                lambda: time.sleep(2),
                timeout_seconds=0.05,
            )
        except main.BlockingOperationTimeout:
            return

        raise AssertionError("Expected timed-out blocking operation")

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


if __name__ == "__main__":
    asyncio.run(run_harness())
