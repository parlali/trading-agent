export const INFERRED_FILL_ACCOUNTING_FAULT_PREFIX = "Provider reconciliation inferred a filled"
export const REFRESHED_FILL_ACCOUNTING_FAULT_MESSAGE = "Provider reconciliation refreshed a filled working order without provider accounting metadata"

export function isInferredFillAccountingFaultMessage(message: string): boolean {
    return message.startsWith(INFERRED_FILL_ACCOUNTING_FAULT_PREFIX) ||
        message === REFRESHED_FILL_ACCOUNTING_FAULT_MESSAGE
}
