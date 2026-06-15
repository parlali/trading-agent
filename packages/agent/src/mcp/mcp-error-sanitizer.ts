import { McpProviderRequestError } from "./http-client"

const SAFE_MCP_ERROR_PATTERNS = [
    /^MCP provider [^\s]+ returned a non-JSON-RPC response for [a-z/]+$/,
    /^MCP provider [^\s]+ [a-z/]+ failed with JSON-RPC error -?\d+$/,
    /^MCP provider [^\s]+ request failed with HTTP \d+$/,
    /^MCP provider [^\s]+ tools\/list exceeded max page count \d+$/,
    /^MCP provider [^\s]+ tools\/list returned repeated cursor$/,
    /^MCP provider [^\s]+ exposed more than configured maxTools \d+$/,
    /^MCP provider [^\s]+ returned malformed tools\/list result$/,
    /^MCP provider [^\s]+ returned malformed tools\/list tools$/,
    /^MCP provider [^\s]+ returned malformed tools\/discover result$/,
    /^MCP provider [^\s]+ returned malformed tools\/discover tools$/,
    /^MCP provider [^\s]+ returned malformed tools\/call result for [A-Za-z0-9_-]+$/,
    /^MCP provider [^\s]+ returned malformed tools\/call content for [A-Za-z0-9_-]+$/,
    /^MCP provider [^\s]+ returned malformed tools\/call isError for [A-Za-z0-9_-]+$/,
    /^MCP event-stream response did not include a matching JSON-RPC response$/,
    /^MCP JSON response id did not match request id$/,
    /^MCP provider request failed$/,
]

export function sanitizeMcpError(error: unknown): string {
    if (error instanceof McpProviderRequestError) {
        return redactSensitiveFragments(error.message)
    }

    if (error instanceof SyntaxError) {
        return "MCP provider returned malformed JSON"
    }

    if (error instanceof Error) {
        const redacted = redactSensitiveFragments(error.message)
        if (SAFE_MCP_ERROR_PATTERNS.some((pattern) => pattern.test(redacted))) {
            return redacted
        }

        if (error.name === "AbortError" || redacted.toLowerCase().includes("abort")) {
            return "MCP provider request was aborted"
        }
    }

    return "MCP provider request failed"
}

function redactSensitiveFragments(value: string): string {
    return value
        .replace(/https?:\/\/[^\s)]+/gi, "[redacted-url]")
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
        .replace(/\b(token|api[_-]?key|secret|password)=([^&\s]+)/gi, "$1=[redacted]")
        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]")
}
