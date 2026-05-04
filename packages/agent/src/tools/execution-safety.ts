import type { ExecutionSafetyFaultCategory } from "@valiq-trading/core"

export interface ExecutionSafetyToolCallbacks {
    onExecutionSafetyFault?: (args: {
        instrument: string
        category: ExecutionSafetyFaultCategory
        message: string
        providerPayload?: string
    }) => Promise<void>
    onExecutionSafetyRecovered?: (args: {
        instrument: string
        resolutionNote: string
    }) => Promise<void>
}
