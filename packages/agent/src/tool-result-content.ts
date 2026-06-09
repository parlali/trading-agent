export const MAX_MODEL_TOOL_RESULT_CHARS = 8_000

export function normalizeModelToolResultContent(content: string): string {
    return content.length > MAX_MODEL_TOOL_RESULT_CHARS
        ? `${content.slice(0, MAX_MODEL_TOOL_RESULT_CHARS)}\n...[truncated from ${content.length} chars]`
        : content
}
