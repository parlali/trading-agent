from __future__ import annotations

import unittest
import sys
import types
from types import SimpleNamespace

structlog_stub = types.ModuleType("structlog")
structlog_stub.get_logger = lambda: SimpleNamespace(warning=lambda *args, **kwargs: None)
sys.modules.setdefault("structlog", structlog_stub)

from mt5_mappers import map_position_closures


class FakeMT5:
    DEAL_TYPE_BUY = 0
    DEAL_TYPE_SELL = 1
    DEAL_ENTRY_IN = 0
    DEAL_ENTRY_OUT = 1
    DEAL_ENTRY_INOUT = 3
    DEAL_ENTRY_OUT_BY = 4


def deal(**overrides: object) -> SimpleNamespace:
    payload = {
        "ticket": 1,
        "order": 10,
        "position_id": 100,
        "symbol": "XAUUSD",
        "type": FakeMT5.DEAL_TYPE_BUY,
        "entry": FakeMT5.DEAL_ENTRY_IN,
        "volume": 1.0,
        "price": 4700.0,
        "profit": 0.0,
        "swap": 0.0,
        "commission": 0.0,
        "fee": 0.0,
        "time_msc": 1_000,
        "time": 1,
        "reason": 0,
    }
    payload.update(overrides)
    return SimpleNamespace(**payload)


class MT5MapperTests(unittest.TestCase):
    def test_inout_reversal_uses_previous_exposure_as_closed_volume(self) -> None:
        closures = map_position_closures(FakeMT5, [
            deal(ticket=1, entry=FakeMT5.DEAL_ENTRY_IN, volume=1.0, time_msc=1_000),
            deal(
                ticket=2,
                order=11,
                entry=FakeMT5.DEAL_ENTRY_INOUT,
                volume=1.5,
                price=4710.0,
                profit=25.0,
                time_msc=2_000,
            ),
        ])

        self.assertEqual(len(closures), 1)
        self.assertEqual(closures[0]["ticket"], 2)
        self.assertEqual(closures[0]["volume"], 1.0)
        self.assertEqual(closures[0]["profit"], 25.0)

    def test_inout_reversal_without_prior_exposure_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "Cannot determine closed volume"):
            map_position_closures(FakeMT5, [
                deal(
                    ticket=2,
                    order=11,
                    entry=FakeMT5.DEAL_ENTRY_INOUT,
                    volume=1.5,
                    time_msc=2_000,
                ),
            ])


if __name__ == "__main__":
    unittest.main()
