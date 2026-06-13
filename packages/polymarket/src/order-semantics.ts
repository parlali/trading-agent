import type { OrderIntent } from "@valiq-trading/core"

export type PolymarketProviderOrderType = "GTC" | "FOK" | "FAK"

export function getPolymarketOrderSemanticsError(intent: OrderIntent): string | undefined {
    if (intent.orderType !== "market" && intent.orderType !== "limit") {
        return `Polymarket supports only market and limit orders, received ${intent.orderType}`
    }

    if (intent.stopPrice !== undefined) {
        return "Polymarket does not support stopPrice on this adapter path"
    }

    if (intent.timeInForce === "day") {
        return "Polymarket does not support timeInForce=day on this adapter path"
    }

    if (intent.timeInForce !== "gtc" && intent.timeInForce !== "ioc" && intent.timeInForce !== "fok") {
        return `Polymarket supports only gtc, ioc, or fok timeInForce, received ${intent.timeInForce}`
    }

    if (intent.orderType === "market" && intent.timeInForce === "gtc") {
        return "Polymarket market orders require ioc or fok timeInForce"
    }

    return undefined
}

export function mapPolymarketProviderOrderType(intent: OrderIntent): PolymarketProviderOrderType {
    const error = getPolymarketOrderSemanticsError(intent)
    if (error) {
        throw new Error(error)
    }

    switch (intent.timeInForce) {
        case "gtc":
            return "GTC"
        case "ioc":
            return "FAK"
        case "fok":
            return "FOK"
    }

    throw new Error(`Unsupported Polymarket timeInForce ${intent.timeInForce}`)
}
