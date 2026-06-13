from __future__ import annotations

import time
from typing import Any

import structlog

log = structlog.get_logger()
MAX_PROVIDER_FUTURE_SKEW_MS = 60_000


def read_mt5_timestamp_ms(payload: Any, millis_attr: str, seconds_attr: str) -> int:
    raw_millis = getattr(payload, millis_attr, 0) or 0
    if raw_millis:
        return normalize_timestamp_ms(int(raw_millis))

    raw_seconds = getattr(payload, seconds_attr, 0) or 0
    if raw_seconds:
        return normalize_timestamp_ms(int(raw_seconds) * 1000)

    return 0


def normalize_timestamp_ms(timestamp_ms: int) -> int:
    if timestamp_ms <= 0:
        return 0

    now_ms = int(time.time() * 1000)
    if timestamp_ms > now_ms + MAX_PROVIDER_FUTURE_SKEW_MS:
        log.warning(
            "mt5_future_timestamp_clamped",
            timestamp_ms=timestamp_ms,
            now_ms=now_ms,
        )
        return now_ms

    return timestamp_ms


def map_position(mt5_module: Any, pos: Any) -> dict[str, Any]:
    return {
        "ticket": int(pos.ticket),
        "symbol": pos.symbol,
        "type": "buy" if pos.type == mt5_module.ORDER_TYPE_BUY else "sell",
        "volume": float(pos.volume),
        "openPrice": float(pos.price_open),
        "currentPrice": float(pos.price_current),
        "stopLoss": float(pos.sl),
        "takeProfit": float(pos.tp),
        "profit": float(pos.profit),
        "swap": float(pos.swap),
        "commission": float(getattr(pos, "commission", 0.0)),
        "magic": int(pos.magic),
        "comment": pos.comment,
        "openTime": read_mt5_timestamp_ms(pos, "time_msc", "time"),
        "identifier": int(pos.identifier),
    }


def map_open_order(order: Any) -> dict[str, Any]:
    return {
        "ticket": int(order.ticket),
        "symbol": order.symbol,
        "type": order_type_str(order.type),
        "volumeInitial": float(order.volume_initial),
        "volumeCurrent": float(order.volume_current),
        "priceOpen": float(order.price_open),
        "stopLoss": float(order.sl),
        "takeProfit": float(order.tp),
        "state": order_state_str(order.state),
        "comment": order.comment,
        "magic": int(order.magic),
        "timeSetup": read_mt5_timestamp_ms(order, "time_setup_msc", "time_setup"),
        "timeDone": read_mt5_timestamp_ms(order, "time_done_msc", "time_done"),
    }


def map_position_closures(mt5_module: Any, deals: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    position_volumes: dict[int, float] = {}

    for deal in sorted(deals, key=lambda item: (
        read_mt5_timestamp_ms(item, "time_msc", "time"),
        int(getattr(item, "ticket", 0) or 0),
    )):
        deal_type = getattr(deal, "type", None)
        if deal_type not in (mt5_module.DEAL_TYPE_BUY, mt5_module.DEAL_TYPE_SELL):
            continue

        position_id = int(getattr(deal, "position_id", 0) or 0)
        if position_id <= 0:
            continue

        entry = int(getattr(deal, "entry", -1))
        deal_volume = abs(float(getattr(deal, "volume", 0.0)))
        if entry == mt5_module.DEAL_ENTRY_IN:
            position_volumes[position_id] = position_volumes.get(position_id, 0.0) + deal_volume
            continue

        if entry in (mt5_module.DEAL_ENTRY_OUT, mt5_module.DEAL_ENTRY_OUT_BY):
            mapped = map_position_closure(mt5_module, deal, deal_volume)
            if mapped is not None:
                result.append(mapped)
            position_volumes[position_id] = max(position_volumes.get(position_id, 0.0) - deal_volume, 0.0)
            continue

        if entry == mt5_module.DEAL_ENTRY_INOUT:
            previous_volume = position_volumes.get(position_id, 0.0)
            if previous_volume <= 0:
                raise ValueError(f"Cannot determine closed volume for MT5 INOUT reversal deal {int(getattr(deal, 'ticket', 0) or 0)}")

            mapped = map_position_closure(mt5_module, deal, previous_volume)
            if mapped is not None:
                result.append(mapped)
            position_volumes[position_id] = max(deal_volume - previous_volume, 0.0)

    return result


def map_position_closure(mt5_module: Any, deal: Any, closed_volume: float | None = None) -> dict[str, Any] | None:
    deal_type = getattr(deal, "type", None)
    if deal_type not in (mt5_module.DEAL_TYPE_BUY, mt5_module.DEAL_TYPE_SELL):
        return None

    entry = int(getattr(deal, "entry", -1))
    if entry not in (
        mt5_module.DEAL_ENTRY_OUT,
        mt5_module.DEAL_ENTRY_OUT_BY,
        mt5_module.DEAL_ENTRY_INOUT,
    ):
        return None

    position_id = int(getattr(deal, "position_id", 0) or 0)
    if position_id <= 0:
        return None

    volume = closed_volume if closed_volume is not None else abs(float(deal.volume))

    return {
        "ticket": int(getattr(deal, "ticket", 0)),
        "orderId": int(getattr(deal, "order", 0) or 0),
        "positionId": position_id,
        "symbol": deal.symbol,
        "side": "short" if deal_type == mt5_module.DEAL_TYPE_BUY else "long",
        "volume": volume,
        "price": float(deal.price),
        "profit": float(getattr(deal, "profit", 0.0)),
        "swap": float(getattr(deal, "swap", 0.0)),
        "commission": float(getattr(deal, "commission", 0.0)),
        "fee": float(getattr(deal, "fee", 0.0)),
        "timeDone": read_mt5_timestamp_ms(deal, "time_msc", "time"),
        "entry": entry,
        "reason": int(getattr(deal, "reason", -1)),
    }


def map_account_pnl_event(mt5_module: Any, deal: Any, currency: str) -> dict[str, Any] | None:
    deal_type = getattr(deal, "type", None)
    ticket = int(getattr(deal, "ticket", 0) or 0)
    time_done = read_mt5_timestamp_ms(deal, "time_msc", "time")
    if deal_type is None:
        return None

    if deal_type in (mt5_module.DEAL_TYPE_BUY, mt5_module.DEAL_TYPE_SELL):
        entry = int(getattr(deal, "entry", -1))
        if entry in (
            mt5_module.DEAL_ENTRY_OUT,
            mt5_module.DEAL_ENTRY_OUT_BY,
            mt5_module.DEAL_ENTRY_INOUT,
        ):
            return None

        commission = float(getattr(deal, "commission", 0.0))
        fee = float(getattr(deal, "fee", 0.0))
        swap = float(getattr(deal, "swap", 0.0))
        amount = commission + fee + swap
        if amount == 0:
            return None

        return {
            "providerEventId": f"mt5-deal:{ticket}:entry-charges",
            "eventType": "fee" if commission + fee != 0 else "adjustment",
            "instrument": getattr(deal, "symbol", "") or None,
            "amount": amount,
            "currency": currency,
            "occurredAt": time_done,
            "metadata": {
                "source": "mt5_history_deals",
                "dealTicket": ticket,
                "orderId": int(getattr(deal, "order", 0) or 0),
                "positionId": int(getattr(deal, "position_id", 0) or 0),
                "entry": entry,
                "dealType": int(deal_type),
                "commission": commission,
                "fee": fee,
                "swap": swap,
            },
        }

    balance_types = {
        getattr(mt5_module, "DEAL_TYPE_BALANCE", None),
        getattr(mt5_module, "DEAL_TYPE_CREDIT", None),
        getattr(mt5_module, "DEAL_TYPE_CHARGE", None),
        getattr(mt5_module, "DEAL_TYPE_CORRECTION", None),
        getattr(mt5_module, "DEAL_TYPE_BONUS", None),
        getattr(mt5_module, "DEAL_TYPE_COMMISSION", None),
        getattr(mt5_module, "DEAL_TYPE_COMMISSION_DAILY", None),
        getattr(mt5_module, "DEAL_TYPE_COMMISSION_MONTHLY", None),
        getattr(mt5_module, "DEAL_TYPE_DIVIDEND", None),
        getattr(mt5_module, "DEAL_TYPE_DIVIDEND_FRANKED", None),
        getattr(mt5_module, "DEAL_TYPE_TAX", None),
    }
    balance_types.discard(None)
    if deal_type not in balance_types:
        return None

    amount = float(getattr(deal, "profit", 0.0))
    if amount == 0:
        return None

    return {
        "providerEventId": f"mt5-deal:{ticket}:balance",
        "eventType": "fee" if deal_type in (
            getattr(mt5_module, "DEAL_TYPE_CHARGE", None),
            getattr(mt5_module, "DEAL_TYPE_COMMISSION", None),
            getattr(mt5_module, "DEAL_TYPE_COMMISSION_DAILY", None),
            getattr(mt5_module, "DEAL_TYPE_COMMISSION_MONTHLY", None),
            getattr(mt5_module, "DEAL_TYPE_TAX", None),
        ) else "adjustment",
        "instrument": getattr(deal, "symbol", "") or None,
        "amount": amount,
        "currency": currency,
        "occurredAt": time_done,
        "metadata": {
            "source": "mt5_history_deals",
            "dealTicket": ticket,
            "orderId": int(getattr(deal, "order", 0) or 0),
            "dealType": int(deal_type),
            "comment": getattr(deal, "comment", ""),
        },
    }


def map_symbol_info(info: Any, tick: Any) -> dict[str, Any]:
    point = 10 ** (-info.digits) if info.digits > 0 else 1.0
    pip_size = point * 10 if info.digits in (3, 5) else point

    return {
        "symbol": info.name,
        "digits": info.digits,
        "point": point,
        "pipSize": pip_size,
        "tickValue": float(info.trade_tick_value),
        "contractSize": float(info.trade_contract_size),
        "currency": info.currency_profit,
        "description": info.description,
        "spread": info.spread,
        "volumeMin": float(info.volume_min),
        "volumeMax": float(info.volume_max),
        "volumeStep": float(info.volume_step),
        "fillingMode": info.filling_mode,
        "bid": float(tick.bid),
        "ask": float(tick.ask),
    }


def map_order_result(mt5_module: Any, result: Any, fallback_order_id: int | None = None) -> dict[str, Any]:
    retcode = int(result.retcode)
    success_retcodes = {
        mt5_module.TRADE_RETCODE_DONE,
        mt5_module.TRADE_RETCODE_PLACED,
        mt5_module.TRADE_RETCODE_DONE_PARTIAL,
    }

    return {
        "retcode": retcode,
        "retcodeDescription": retcode_description(retcode),
        "retcodeExternal": int(getattr(result, "retcode_external", 0)) if hasattr(result, "retcode_external") else None,
        "orderId": str(result.order) if result.order else (str(fallback_order_id) if fallback_order_id is not None else ""),
        "dealId": str(result.deal) if result.deal else "",
        "volume": float(result.volume),
        "price": float(result.price),
        "comment": result.comment if hasattr(result, "comment") else "",
        "bid": float(getattr(result, "bid", 0.0)) if hasattr(result, "bid") else None,
        "ask": float(getattr(result, "ask", 0.0)) if hasattr(result, "ask") else None,
        "success": retcode in success_retcodes,
    }


def failed_order_result(message: str, order_id: str = "", ticket: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "retcode": -1,
        "retcodeDescription": message,
        "retcodeExternal": None,
        "orderId": order_id,
        "dealId": "",
        "volume": 0.0,
        "price": 0.0,
        "comment": message,
        "bid": None,
        "ask": None,
        "success": False,
    }
    if ticket is not None:
        result["ticket"] = ticket
    return result


def map_open_order_status(order: Any) -> dict[str, Any]:
    return map_order_status_payload(order, float(order.volume_current))


def map_position_status(pos: Any) -> dict[str, Any]:
    volume = float(pos.volume)
    return order_status_payload(
        ticket=int(pos.ticket),
        symbol=pos.symbol,
        order_type=order_type_str(pos.type),
        volume=volume,
        volume_initial=volume,
        price=float(pos.price_open),
        stop_loss=float(pos.sl),
        take_profit=float(pos.tp),
        state="filled",
        time_done=read_mt5_timestamp_ms(pos, "time_msc", "time"),
    )


def map_deal_status(mt5_module: Any, order_id: int, deals: Any) -> dict[str, Any] | None:
    order_deals = [
        deal for deal in deals
        if int(getattr(deal, "order", 0)) == order_id and deal.type in (mt5_module.DEAL_TYPE_BUY, mt5_module.DEAL_TYPE_SELL)
    ]
    if not order_deals:
        return None

    total_volume = sum(abs(float(deal.volume)) for deal in order_deals)
    if total_volume <= 0:
        return None

    weighted_price = sum(abs(float(deal.volume)) * float(deal.price) for deal in order_deals)
    profit = sum(float(getattr(deal, "profit", 0.0)) for deal in order_deals)
    commission = sum(float(getattr(deal, "commission", 0.0)) for deal in order_deals)
    swap = sum(float(getattr(deal, "swap", 0.0)) for deal in order_deals)
    fee = sum(float(getattr(deal, "fee", 0.0)) for deal in order_deals)
    latest_deal = max(order_deals, key=lambda deal: int(getattr(deal, "time", 0)))

    return {
        "ticket": int(latest_deal.order),
        "symbol": latest_deal.symbol,
        "type": "buy" if latest_deal.type == mt5_module.DEAL_TYPE_BUY else "sell",
        "volume": total_volume,
        "volumeInitial": total_volume,
        "price": weighted_price / total_volume,
        "profit": profit,
        "commission": commission,
        "swap": swap,
        "fee": fee,
        "state": "filled",
        "timeDone": read_mt5_timestamp_ms(latest_deal, "time_msc", "time"),
    }


def map_history_order_status(order: Any) -> dict[str, Any]:
    volume = float(order.volume_current if hasattr(order, "volume_current") else order.volume_initial)
    return map_order_status_payload(order, volume)


def map_order_status_payload(order: Any, volume: float) -> dict[str, Any]:
    return order_status_payload(
        ticket=int(order.ticket),
        symbol=order.symbol,
        order_type=order_type_str(order.type),
        volume=volume,
        volume_initial=float(order.volume_initial),
        price=float(order.price_open),
        stop_loss=float(order.sl),
        take_profit=float(order.tp),
        state=order_state_str(order.state),
        time_done=read_mt5_timestamp_ms(order, "time_done_msc", "time_done"),
    )


def order_status_payload(
    *,
    ticket: int,
    symbol: str,
    order_type: str,
    volume: float,
    volume_initial: float,
    price: float,
    stop_loss: float,
    take_profit: float,
    state: str,
    time_done: int,
) -> dict[str, Any]:
    return {
        "ticket": ticket,
        "symbol": symbol,
        "type": order_type,
        "volume": volume,
        "volumeInitial": volume_initial,
        "price": price,
        "stopLoss": stop_loss,
        "takeProfit": take_profit,
        "state": state,
        "timeDone": time_done,
    }


def resolve_order_type(mt5_module: Any, side: str, order_type: str) -> int:
    if order_type == "market":
        return mt5_module.ORDER_TYPE_BUY if side == "buy" else mt5_module.ORDER_TYPE_SELL
    if order_type == "limit":
        return mt5_module.ORDER_TYPE_BUY_LIMIT if side == "buy" else mt5_module.ORDER_TYPE_SELL_LIMIT
    if order_type == "stop":
        return mt5_module.ORDER_TYPE_BUY_STOP if side == "buy" else mt5_module.ORDER_TYPE_SELL_STOP
    if order_type == "stop_limit":
        return mt5_module.ORDER_TYPE_BUY_STOP_LIMIT if side == "buy" else mt5_module.ORDER_TYPE_SELL_STOP_LIMIT
    return mt5_module.ORDER_TYPE_BUY if side == "buy" else mt5_module.ORDER_TYPE_SELL


def resolve_filling_mode(mt5_module: Any, filling_mode: int) -> int:
    if filling_mode & 2:
        return mt5_module.ORDER_FILLING_IOC
    if filling_mode & 1:
        return mt5_module.ORDER_FILLING_FOK
    return mt5_module.ORDER_FILLING_RETURN


def retcode_description(retcode: int) -> str:
    descriptions: dict[int, str] = {
        10004: "Requote",
        10006: "Request rejected",
        10007: "Request cancelled by trader",
        10008: "Order placed",
        10009: "Request completed",
        10010: "Request partially completed",
        10011: "Request processing error",
        10012: "Request cancelled by timeout",
        10013: "Invalid request",
        10014: "Invalid volume",
        10015: "Invalid price",
        10016: "Invalid stops",
        10017: "Trade disabled",
        10018: "Market closed",
        10019: "Insufficient funds",
        10020: "Prices changed",
        10021: "No quotes",
        10022: "Invalid expiration",
        10023: "Order state changed",
        10024: "Too many requests",
        10025: "No changes",
        10026: "Autotrading disabled",
        10027: "Protection triggered",
        10028: "Modification failed (locked)",
        10029: "Order/position frozen",
        10030: "Invalid fill mode",
        10031: "Connection problem",
        10032: "Only real accounts allowed",
        10033: "Pending orders limit reached",
        10034: "Volume limit for orders/positions reached",
        10035: "Invalid or prohibited order type",
        10036: "Position already closed",
        10038: "Close volume exceeds position volume",
        10039: "Close order already exists for position",
        10040: "Limit orders reached",
        10041: "Pending volume limit reached",
        10042: "Order prohibited (only long allowed)",
        10043: "Order prohibited (only short allowed)",
        10044: "Order prohibited (only close allowed)",
        10045: "Position close not allowed by FIFO",
    }
    return descriptions.get(retcode, f"Unknown retcode {retcode}")


def order_type_str(order_type: int) -> str:
    mapping = {
        0: "buy",
        1: "sell",
        2: "buy_limit",
        3: "sell_limit",
        4: "buy_stop",
        5: "sell_stop",
        6: "buy_stop_limit",
        7: "sell_stop_limit",
    }
    return mapping.get(order_type, f"unknown_{order_type}")


def order_state_str(state: int) -> str:
    mapping = {
        0: "started",
        1: "placed",
        2: "canceled",
        3: "partial",
        4: "filled",
        5: "rejected",
        6: "expired",
        7: "request_add",
        8: "request_modify",
        9: "request_cancel",
    }
    return mapping.get(state, f"unknown_{state}")
