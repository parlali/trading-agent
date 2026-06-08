import { describe, expect, it } from "vitest"
import { assertCodexPreflightToolEvidence } from "./codex-preflight-evidence"

describe("assertCodexPreflightToolEvidence", () => {
    it("accepts exactly one matching preflight echo call with canonical input and output", () => {
        expect(() => assertCodexPreflightToolEvidence([{
            toolName: "preflight_echo",
            toolInput: "{\"value\":\"mcp-ready\"}",
            toolOutput: "{\"echoed\":\"mcp-ready\"}",
        }])).not.toThrow()
    })

    it("rejects missing or duplicate preflight echo calls", () => {
        expect(() => assertCodexPreflightToolEvidence([])).toThrow("expected exactly one preflight_echo")
        expect(() => assertCodexPreflightToolEvidence([
            {
                toolName: "preflight_echo",
                toolInput: "{\"value\":\"mcp-ready\"}",
                toolOutput: "{\"echoed\":\"mcp-ready\"}",
            },
            {
                toolName: "preflight_echo",
                toolInput: "{\"value\":\"mcp-ready\"}",
                toolOutput: "{\"echoed\":\"mcp-ready\"}",
            },
        ])).toThrow("expected exactly one preflight_echo")
    })

    it("rejects malformed or non-canonical preflight payloads", () => {
        expect(() => assertCodexPreflightToolEvidence([{
            toolName: "preflight_echo",
            toolInput: "{",
            toolOutput: "{\"echoed\":\"mcp-ready\"}",
        }])).toThrow("input is not valid JSON")
        expect(() => assertCodexPreflightToolEvidence([{
            toolName: "preflight_echo",
            toolInput: "{\"value\":\"wrong\"}",
            toolOutput: "{\"echoed\":\"mcp-ready\"}",
        }])).toThrow("input value was wrong")
        expect(() => assertCodexPreflightToolEvidence([{
            toolName: "preflight_echo",
            toolInput: "{\"value\":\"mcp-ready\"}",
            toolOutput: "{\"echoed\":\"wrong\"}",
        }])).toThrow("output echoed was wrong")
    })
})
