export const ORDER_SIDES = ["buy", "sell"] as const
export type OrderSide = typeof ORDER_SIDES[number]

export const ORDER_LEG_SIDES = [
    "buy",
    "sell",
    "buy_to_open",
    "sell_to_open",
    "buy_to_close",
    "sell_to_close",
] as const
export type OrderLegSide = typeof ORDER_LEG_SIDES[number]

export interface OrderIntent {
    instrument: string
    side: OrderSide
    quantity: number
    orderType: "market" | "limit" | "stop" | "stop_limit"
    limitPrice?: number
    stopPrice?: number
    timeInForce: "day" | "gtc" | "ioc" | "fok"
    legs?: OrderLeg[]
    metadata?: Record<string, unknown>
}

export interface OrderLeg {
    instrument: string
    side: OrderLegSide
    quantity: number
    limitPrice?: number
}
