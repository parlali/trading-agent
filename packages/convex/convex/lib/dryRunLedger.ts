export function isDryRunLedgerMetadata(metadata: string | undefined): boolean {
    if (!metadata) {
        return false
    }

    try {
        const parsed = JSON.parse(metadata) as Record<string, unknown>
        return parsed.dryRunLedger === true
    } catch {
        return false
    }
}
