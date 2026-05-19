import type { ExecutionSafetyFaultCategory } from "@valiq-trading/core"

export interface ExecutionSafetyToolCallbacks {
    onExecutionSafetyFault?: (args: {
        instrument: string
        category: ExecutionSafetyFaultCategory
        message: string
        providerPayload?: string
        canonicalOrderId?: string
        providerOrderId?: string
        providerClientOrderId?: string
        providerOrderAliases?: string[]
        submitAttemptId?: string
        submitAttemptSequence?: number
        venue?: string
        recoveryProbeEvidence?: Record<string, unknown>
    }) => Promise<void>
    onExecutionSafetyRecovered?: (args: {
        instrument: string
        resolutionNote: string
    }) => Promise<void>
}
