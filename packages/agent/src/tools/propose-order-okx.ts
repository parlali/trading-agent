import type { OKXVenueAdapter } from "@valiq-trading/okx"
import type { ExecutionPipeline, OKXPolicy } from "@valiq-trading/core"
import type { ToolBinding } from "../tool-registry"
import { createToolBinding } from "../tool-contracts"
import {
    prepareOKXOrder,
    type OKXOrderParams,
} from "./okx-order-helpers"
import type { ExecutionSafetyToolCallbacks } from "./execution-safety"
import { assertToolNotAborted } from "../tool-registry"

export function createOKXProposeOrderTool(
    pipeline: ExecutionPipeline,
    venue: OKXVenueAdapter,
    policy: OKXPolicy,
    options?: ExecutionSafetyToolCallbacks
): ToolBinding {
    return createToolBinding({
        name: "propose_order",
        venue: "okx-swap",
        handler: async (params, context) => {
            const validated = params as OKXOrderParams
            assertToolNotAborted(context?.signal)
            return await prepareOKXOrder(validated, pipeline, venue, policy, "entry", {
                recordFault: options?.onExecutionSafetyFault,
                resolveFaults: options?.onExecutionSafetyRecovered,
            })
        },
    })
}
