export interface CodexPreflightToolEvidence {
    toolName?: string
    toolInput?: string
    toolOutput?: string
}

export function assertCodexPreflightToolEvidence(records: CodexPreflightToolEvidence[]): void {
    const matches = records.filter((record) => record.toolName === "preflight_echo")

    if (matches.length !== 1) {
        throw new Error(`Codex preflight failed: expected exactly one preflight_echo tool call, got ${matches.length}`)
    }

    const match = matches[0]!
    const input = readJsonRecord(match.toolInput, "preflight_echo input")
    const output = readJsonRecord(match.toolOutput, "preflight_echo output")

    if (input.value !== "mcp-ready") {
        throw new Error(`Codex preflight failed: preflight_echo input value was ${formatValue(input.value)}, expected mcp-ready`)
    }
    if (output.echoed !== "mcp-ready") {
        throw new Error(`Codex preflight failed: preflight_echo output echoed was ${formatValue(output.echoed)}, expected mcp-ready`)
    }
}

function readJsonRecord(value: string | undefined, label: string): Record<string, unknown> {
    if (!value) {
        throw new Error(`Codex preflight failed: ${label} is missing`)
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(value)
    } catch {
        throw new Error(`Codex preflight failed: ${label} is not valid JSON`)
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Codex preflight failed: ${label} is not a JSON object`)
    }

    return parsed as Record<string, unknown>
}

function formatValue(value: unknown): string {
    return typeof value === "string"
        ? value
        : JSON.stringify(value)
}
