import { describe, expect, it } from "vitest"
import { deleteOrphanedStrategyHistoryBatch, setStrategyMcpToolWhitelist } from "../../convex/lib/mutations/strategies"
import { getStrategyMcpToolWhitelist } from "../../convex/lib/queries/strategies"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"
import { callRegisteredQuery } from "./fakeQueryDb"

describe("strategy MCP tool whitelist persistence", () => {
    it("persists a deterministic per-strategy MCP tool whitelist", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb(createSeed())

        await callRegistered(setStrategyMcpToolWhitelist, { db } as never, {
            serviceToken: "test-token",
            strategyId: "strategy-1",
            discoveryTools: [
                {
                    providerId: "macro",
                    toolName: "discover_tools",
                    input: { category: "rates" },
                },
                {
                    providerId: "macro",
                    toolName: "discover_tools",
                    input: { category: "calendar" },
                },
            ],
            tools: [
                {
                    providerId: "macro",
                    toolName: "rates",
                    registeredName: "mcp_macro_rates",
                    schemaHash: "b".repeat(64),
                    description: "Rates lookup",
                    source: "tools/list",
                    inputSchema: {
                        type: "object",
                        properties: {},
                    },
                    annotations: {
                        openWorldHint: true,
                    },
                    approvedAt: 100,
                    approvedBy: "user-1",
                    approvalReason: "dashboard_mcp_tools",
                },
                {
                    providerId: "macro",
                    toolName: "calendar",
                    registeredName: "mcp_macro_calendar",
                    schemaHash: "a".repeat(64),
                },
            ],
        })

        expect(db.rows.strategy_mcp_tool_whitelists).toHaveLength(1)
        expect(db.rows.strategy_mcp_tool_whitelists?.[0]).toMatchObject({
            strategyId: "strategy-1",
            discoveryTools: [
                {
                    providerId: "macro",
                    toolName: "discover_tools",
                    input: { category: "calendar" },
                },
                {
                    providerId: "macro",
                    toolName: "discover_tools",
                    input: { category: "rates" },
                },
            ],
            tools: [
                {
                    providerId: "macro",
                    toolName: "calendar",
                    registeredName: "mcp_macro_calendar",
                    schemaHash: "a".repeat(64),
                },
                {
                    providerId: "macro",
                    toolName: "rates",
                    registeredName: "mcp_macro_rates",
                    schemaHash: "b".repeat(64),
                    description: "Rates lookup",
                    source: "tools/list",
                    inputSchema: {
                        type: "object",
                        properties: {},
                    },
                    annotations: {
                        openWorldHint: true,
                    },
                    approvedAt: 100,
                    approvedBy: "user-1",
                    approvalReason: "dashboard_mcp_tools",
                },
            ],
        })
    })

    it("rejects duplicate provider tool entries", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb(createSeed())

        await expect(callRegistered(setStrategyMcpToolWhitelist, { db } as never, {
            serviceToken: "test-token",
            strategyId: "strategy-1",
            tools: [
                {
                    providerId: "macro",
                    toolName: "rates",
                    registeredName: "mcp_macro_rates",
                    schemaHash: "a".repeat(64),
                },
                {
                    providerId: "macro",
                    toolName: "rates",
                    registeredName: "mcp_macro_rates",
                    schemaHash: "a".repeat(64),
                },
            ],
        })).rejects.toThrow("Duplicate MCP whitelist tool: macro:rates")

        expect(db.rows.strategy_mcp_tool_whitelists).toEqual([])
    })

    it("reads the persisted whitelist through the dashboard and service query", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const row = {
            _id: "whitelist-1",
            _creationTime: 1,
            strategyId: "strategy-1",
            tools: [{
                providerId: "macro",
                toolName: "rates",
                registeredName: "mcp_macro_rates",
                schemaHash: "a".repeat(64),
            }],
            createdAt: 1,
            updatedAt: 1,
        }

        const result = await callRegisteredQuery(getStrategyMcpToolWhitelist, {
            strategy_mcp_tool_whitelists: [row],
        }, {
            strategyId: "strategy-1",
        })

        expect(result).toEqual(row)
    })

    it("removes orphaned strategy MCP whitelist rows during orphan cleanup", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const db = new FakeDb({
            strategies: [{
                _id: "strategy-1",
                app: "alpaca-options",
                accountId: "acct-1",
            }],
            strategy_mcp_tool_whitelists: [
                {
                    _id: "whitelist-valid",
                    strategyId: "strategy-1",
                    tools: [],
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    _id: "whitelist-orphan",
                    strategyId: "missing-strategy",
                    tools: [],
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            control_plane_metrics: [],
        })

        const result = await callRegistered(deleteOrphanedStrategyHistoryBatch, { db } as never, {
            serviceToken: "test-token",
            batchSize: 10,
        })

        expect(result).toMatchObject({
            strategyMcpToolWhitelists: 1,
            hasMore: true,
        })
        expect(db.rows.strategy_mcp_tool_whitelists).toEqual([expect.objectContaining({
            _id: "whitelist-valid",
            strategyId: "strategy-1",
        })])
    })
})

function createSeed() {
    return {
        strategies: [{
            _id: "strategy-1",
            app: "alpaca-options",
            accountId: "acct-1",
        }],
        strategy_mcp_tool_whitelists: [],
    }
}
