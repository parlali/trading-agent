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

const SANITIZED_SUMMARY_FALLBACK = "Summary unavailable after sanitization because the model returned internal reasoning instead of an operational handoff."

export function sanitizeRunSummary(summary: string): string {
    const withoutMetadata = stripMetadataBlock(summary)
    const withoutTaggedBlocks = withoutMetadata
        .replace(/```(?:analysis|thinking|thought)[\s\S]*?```/gi, "")
        .replace(/<(analysis|thinking|thought)>[\s\S]*?<\/\1>/gi, "")

    const lines = withoutTaggedBlocks.split("\n")
    const sanitizedLines: string[] = []
    let skippingLeadingReasoning = true

    for (const rawLine of lines) {
        const line = rawLine.trim()

        if (line.length === 0) {
            if (!skippingLeadingReasoning && sanitizedLines.at(-1) !== "") {
                sanitizedLines.push("")
            }
            continue
        }

        if (isInternalReasoningLine(line)) {
            continue
        }

        skippingLeadingReasoning = false
        sanitizedLines.push(rawLine)
    }

    const sanitized = sanitizedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
    return sanitized.length > 0 ? sanitized : SANITIZED_SUMMARY_FALLBACK
}

function isInternalReasoningLine(line: string): boolean {
    return /^(thought|thinking|analysis|reasoning|scratchpad|chain[- ]of[- ]thought)\s*:/i.test(line) ||
        /^<\/?(thought|thinking|analysis)>$/i.test(line) ||
        /^assistant to=/i.test(line)
}
