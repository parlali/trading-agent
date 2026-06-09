export const MAX_RUN_EVIDENCE_ROWS = 5000

export function assertWithinRunEvidenceRowLimit<T>(
    rows: T[],
    label: string,
    limit = MAX_RUN_EVIDENCE_ROWS
): T[] {
    if (rows.length > limit) {
        throw new Error(`${label} exceeds run evidence row limit ${limit}`)
    }

    return rows
}
