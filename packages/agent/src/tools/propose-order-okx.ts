import type { OKXVenueAdapter } from "@valiq-trading/okx"
import type { ExecutionPipeline, OKXPolicy } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import { createToolDefinition } from "../tool-contracts"
import {
    prepareOKXOrder,
    type OKXOrderParams,
} from "./okx-order-helpers"
import type { ExecutionSafetyToolCallbacks } from "./execution-safety"

export function createOKXProposeOrderTool(
    pipeline: ExecutionPipeline,
    venue: OKXVenueAdapter,
    policy: OKXPolicy,
    options?: ExecutionSafetyToolCallbacks
): ToolDefinition {
    return createToolDefinition({
        name: "propose_order",
        venue: "okx-swap",
        handler: async (params) => {
            const validated = params as OKXOrderParams
            return await prepareOKXOrder(validated, pipeline, venue, policy, "entry", {
                recordFault: options?.onExecutionSafetyFault,
                resolveFaults: options?.onExecutionSafetyRecovered,
            })
        },
    })
}
