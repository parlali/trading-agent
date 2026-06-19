import type { ExecutionPipeline, MT5Policy } from "@valiq-trading/core"
import type { MT5VenueAdapter } from "@valiq-trading/mt5"
import type { ToolBinding } from "../tool-registry"
import { createToolBinding } from "../tool-contracts"
import {
    prepareMT5Order,
    type MT5OrderParams,
} from "./mt5-order-helpers"
import { assertToolNotAborted } from "../tool-registry"
import { withMT5SymbolAllowList } from "./mt5-symbol-allow-list"

export function createMT5ProposeAdjustmentTool(
    pipeline: ExecutionPipeline,
    venue: MT5VenueAdapter,
    policy: MT5Policy,
    allowedSymbols: readonly string[] = []
): ToolBinding {
    return withMT5SymbolAllowList(createToolBinding({
        name: "propose_adjustment",
        venue: "mt5",
        handler: async (params, context) => {
            const validated = params as MT5OrderParams
            assertToolNotAborted(context?.signal)
            return await prepareMT5Order(validated, pipeline, venue, policy, "adjustment", allowedSymbols)
        },
    }), "instrument", allowedSymbols)
}
