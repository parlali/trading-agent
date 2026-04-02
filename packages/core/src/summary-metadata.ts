export interface SummaryMetadata {
    nextRunInMinutes?: number
}

const METADATA_START = "---METADATA---"
const METADATA_END = "---END METADATA---"
const MIN_CALLBACK_MINUTES = 2
const MAX_CALLBACK_MINUTES = 240

export function parseSummaryMetadata(summary: string): SummaryMetadata | null {
    const startIdx = summary.indexOf(METADATA_START)
    if (startIdx === -1) return null

    const endIdx = summary.indexOf(METADATA_END, startIdx)
    if (endIdx === -1) return null

    const jsonStr = summary
        .slice(startIdx + METADATA_START.length, endIdx)
        .trim()

    try {
        const parsed = JSON.parse(jsonStr)
        if (typeof parsed !== "object" || parsed === null) return null

        if ("nextRunInMinutes" in parsed) {
            const val = parsed.nextRunInMinutes
            if (
                typeof val !== "number" ||
                !Number.isFinite(val) ||
                val < MIN_CALLBACK_MINUTES ||
                val > MAX_CALLBACK_MINUTES
            ) {
                return null
            }
            return { nextRunInMinutes: val }
        }

        return null
    } catch {
        return null
    }
}

export function stripMetadataBlock(summary: string): string {
    const startIdx = summary.indexOf(METADATA_START)
    if (startIdx === -1) return summary

    const endIdx = summary.indexOf(METADATA_END, startIdx)
    if (endIdx === -1) return summary

    const before = summary.slice(0, startIdx)
    const after = summary.slice(endIdx + METADATA_END.length)

    return (before + after).trim()
}
