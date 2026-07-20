import type {
    DecisionRecord,
    DecisionRecordDecision,
    DecisionRecordDirection,
    DecisionRecordForecast,
} from "@valiq-trading/core"

const DECISION_VALUES = new Set<DecisionRecordDecision>([
    "trade",
    "no_trade",
    "manage_only",
])

const DIRECTION_VALUES = new Set<DecisionRecordDirection>([
    "long",
    "short",
    "neutral",
])

export function parseDecisionRecordOutput(output: string): DecisionRecord {
    const errors: string[] = []
    const forecast = parseForecast(output, errors)
    const block = parseDecisionRecordBlock(output, errors)
    const record: DecisionRecord = {}

    if (forecast) {
        record.forecast = forecast
    }
    if (block) {
        if (block.decision) {
            record.decision = block.decision
        }
        if (block.detail) {
            record.detail = block.detail
        }
        record.rulesApplied = block.rulesApplied
        record.notInText = block.notInText
    }
    if (errors.length > 0) {
        record.parseError = errors.join("; ")
    }

    return record
}

function parseForecast(output: string, errors: string[]): DecisionRecordForecast | undefined {
    const match = output.match(/^\s*FORECAST\s*\|([^\r\n]*)/im)
    if (!match) {
        errors.push("FORECAST line not found")
        return undefined
    }

    const fields = parseDelimitedFields(match[1] ?? "")
    const forecast: DecisionRecordForecast = {}
    const direction = readField(fields, "direction")
    const probability = readField(fields, "p")
    const expectedMove = readField(fields, "expected_move") ?? readField(fields, "expectedMove")
    const horizon = readField(fields, "horizon")
    const invalidation = readField(fields, "invalidation")

    if (direction !== undefined) {
        const normalized = direction.toLowerCase()
        if (DIRECTION_VALUES.has(normalized as DecisionRecordDirection)) {
            forecast.direction = normalized as DecisionRecordDirection
        } else {
            errors.push("FORECAST direction is invalid")
        }
    }
    if (probability !== undefined) {
        const parsed = Number(probability)
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
            forecast.p = parsed
        } else {
            errors.push("FORECAST p is invalid")
        }
    }
    if (expectedMove !== undefined) {
        forecast.expectedMove = expectedMove
    }
    if (horizon !== undefined) {
        forecast.horizon = horizon
    }
    if (invalidation !== undefined) {
        forecast.invalidation = invalidation
    }

    return Object.keys(forecast).length > 0
        ? forecast
        : undefined
}

function parseDelimitedFields(line: string): Map<string, string> {
    const fields = new Map<string, string>()

    for (const part of line.split("|")) {
        const separatorIndex = part.indexOf("=")
        if (separatorIndex < 0) {
            continue
        }
        const key = part.slice(0, separatorIndex).trim()
        const value = part.slice(separatorIndex + 1).trim()
        if (key.length > 0 && value.length > 0) {
            fields.set(key.toLowerCase(), value)
        }
    }

    return fields
}

function readField(fields: Map<string, string>, key: string): string | undefined {
    return fields.get(key.toLowerCase())
}

function parseDecisionRecordBlock(output: string, errors: string[]): {
    decision?: DecisionRecordDecision
    detail?: string
    rulesApplied: string[]
    notInText: string[]
} | undefined {
    const match = output.match(/^\s*DECISION_RECORD\s*$([\s\S]*?)^\s*END_DECISION_RECORD\s*$/im)
    if (!match) {
        errors.push("DECISION_RECORD block not found")
        return undefined
    }

    const body = match[1] ?? ""
    const lines = body.split(/\r?\n/)
    const decision = parseDecision(lines, errors)
    const detail = parseLineField(lines, "detail")
    const { rulesApplied, notInText } = parseRulesApplied(lines)

    return {
        decision,
        detail,
        rulesApplied,
        notInText,
    }
}

function parseDecision(lines: string[], errors: string[]): DecisionRecordDecision | undefined {
    const rawDecision = parseLineField(lines, "decision")
    if (rawDecision === undefined) {
        errors.push("DECISION_RECORD decision field not found")
        return undefined
    }

    const normalized = rawDecision.toLowerCase()
    if (!DECISION_VALUES.has(normalized as DecisionRecordDecision)) {
        errors.push("DECISION_RECORD decision is invalid")
        return undefined
    }

    return normalized as DecisionRecordDecision
}

function parseLineField(lines: string[], field: string): string | undefined {
    const pattern = new RegExp(`^\\s*${escapeRegex(field)}\\s*:\\s*(.+?)\\s*$`, "i")
    for (const line of lines) {
        const match = line.match(pattern)
        if (match?.[1]) {
            return match[1].trim()
        }
    }

    return undefined
}

function parseRulesApplied(lines: string[]): {
    rulesApplied: string[]
    notInText: string[]
} {
    const rulesApplied: string[] = []
    const notInText: string[] = []
    let inRules = false

    for (const line of lines) {
        if (/^\s*rules_applied\s*:\s*$/i.test(line)) {
            inRules = true
            continue
        }
        if (inRules && /^\s*(decision|detail)\s*:/i.test(line)) {
            inRules = false
        }
        if (!inRules) {
            continue
        }

        const entry = parseRuleLine(line)
        if (!entry) {
            continue
        }
        if (entry.kind === "not_in_text") {
            notInText.push(entry.value)
        } else {
            rulesApplied.push(entry.value)
        }
    }

    return {
        rulesApplied,
        notInText,
    }
}

function parseRuleLine(line: string): { kind: "rule" | "not_in_text"; value: string } | undefined {
    const bullet = line.match(/^\s*-\s*(.+?)\s*$/)
    const raw = bullet?.[1]?.trim()
    if (!raw) {
        return undefined
    }

    const notInTextMatch = raw.match(/^NOT IN TEXT\s*:\s*(.+?)\s*$/i)
    if (notInTextMatch?.[1]) {
        return {
            kind: "not_in_text",
            value: notInTextMatch[1].trim(),
        }
    }

    return {
        kind: "rule",
        value: unwrapQuotedRule(raw),
    }
}

function unwrapQuotedRule(value: string): string {
    const trimmed = value.trim()
    if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
        return trimmed.slice(1, -1)
    }

    return trimmed
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
