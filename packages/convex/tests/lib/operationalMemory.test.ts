import { beforeEach, describe, expect, it } from "vitest"
import type { StrategyOperationalMemory } from "@valiq-trading/core"
import {
    buildStrategyOperationalMemoryFromRun,
    isStrategyOperationalMemoryApplicable,
} from "../../convex/lib/operationalMemory"
import { getApplicableStrategyOperationalMemory } from "../../convex/lib/queries/operationalMemory"
import { refreshStrategyOperationalMemoryFromRun } from "../../convex/lib/mutations/operationalMemory"
import { buildStrategyOperationalMemoryProjection } from "../../convex/lib/operationalMemoryProjection"
import {
    callRegisteredQuery,
    type FakeRow,
} from "./fakeQueryDb"
import {
    FakeMutationDb,
    callRegistered,
} from "./fakeMutationDb"

const now = Date.parse("2026-04-20T10:00:00.000Z")

describe("strategy operational memory", () => {
    beforeEach(() => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
    })

    it("derives typed strategy memory from completed run evidence", () => {
        const memories = buildStrategyOperationalMemoryFromRun(createCompletedRunEvidence())
        const types = memories.map((memory) => memory.type)

        expect(types).toContain("run_handoff_fact")
        expect(types).toContain("tool_argument_failure")
        expect(types).toContain("tool_invocation_success")
        expect(types).toContain("external_tool_discovery")
        expect(types).toContain("provider_truth_warning")
        expect(types).toContain("run_diagnostic")

        const failure = memories.find((memory) => memory.type === "tool_argument_failure")
        expect(failure).toMatchObject({
            strategyId: "strategy-1",
            app: "polymarket",
            accountId: "account-1",
            scope: {
                toolName: "propose_order",
                schemaHash: "b".repeat(64),
            },
            evidence: {
                failureCount: 1,
            },
        })
        expect(failure?.lesson.requiredArgumentShape).toMatchObject({
            requiredFields: ["limitPrice"],
        })

        const handoff = memories.find((memory) => memory.type === "run_handoff_fact")
        expect(handoff?.ranking.expiresAt).toBe(now + 24 * 60 * 60 * 1000)
        expect(handoff?.lesson.providerTruth).toBe("stale")
    })

    it("derives MCP argument failures from deployed Invalid tool arguments validationIssues", () => {
        const completed = createCompletedRunEvidence()
        const memories = buildStrategyOperationalMemoryFromRun({
            ...completed,
            run: {
                ...completed.run,
                summary: undefined,
                systemContextDigest: undefined,
                mcpToolDiagnostics: [],
                toolManifest: [{
                    name: "mcp_macro_rates",
                    schemaHash: "a".repeat(64),
                    category: "research",
                    contractOwner: "mcp:macro",
                }],
            },
            agentLogs: [{
                _id: "log-mcp-validation",
                runId: "run-1",
                strategyId: "strategy-1",
                sequence: 1,
                role: "tool",
                toolName: "mcp_macro_rates",
                toolInput: JSON.stringify({ query: 123 }),
                toolOutput: JSON.stringify({
                    error: "Invalid tool arguments",
                    validationIssues: [{
                        path: ["query"],
                        code: "invalid_type",
                        expected: "string",
                        message: "Expected string, received number",
                    }],
                }),
                content: JSON.stringify({ error: "Invalid tool arguments" }),
                timestamp: now,
            }],
        })

        expect(memories.map((memory) => memory.type)).toEqual(["tool_argument_failure"])
        expect(memories[0]).toMatchObject({
            scope: {
                providerId: "macro",
                toolName: "mcp_macro_rates",
                schemaHash: "a".repeat(64),
            },
            lesson: {
                requiredArgumentShape: {
                    requiredFields: ["query"],
                    issues: [{
                        path: "query",
                        code: "invalid_type",
                        expected: "string",
                        message: "Expected string, received number",
                    }],
                },
            },
        })
    })

    it("does not derive trusted memory from failed or running runs", () => {
        const completed = createCompletedRunEvidence()

        expect(buildStrategyOperationalMemoryFromRun({
            ...completed,
            run: {
                ...completed.run,
                status: "failed",
            },
        })).toEqual([])
        expect(buildStrategyOperationalMemoryFromRun({
            ...completed,
            run: {
                ...completed.run,
                status: "running",
            },
        })).toEqual([])
    })

    it("filters stale schema hashes, expired entries, and wrong account scope", () => {
        const memory = createMemory({
            memoryKey: "memory-active",
            strategyId: "strategy-1",
            accountId: "account-1",
            toolName: "propose_order",
            schemaHash: "a".repeat(64),
            expiresAt: now + 1_000,
        })

        expect(isStrategyOperationalMemoryApplicable({
            memory,
            app: "polymarket",
            accountId: "account-1",
            toolManifest: [{
                name: "propose_order",
                schemaHash: "a".repeat(64),
            }],
            now,
        })).toBe(true)
        expect(isStrategyOperationalMemoryApplicable({
            memory,
            app: "polymarket",
            accountId: "account-1",
            toolManifest: [{
                name: "propose_order",
                schemaHash: "b".repeat(64),
            }],
            now,
        })).toBe(false)
        expect(isStrategyOperationalMemoryApplicable({
            memory,
            app: "polymarket",
            accountId: "account-2",
            toolManifest: [{
                name: "propose_order",
                schemaHash: "a".repeat(64),
            }],
            now,
        })).toBe(false)
        expect(isStrategyOperationalMemoryApplicable({
            memory,
            app: "polymarket",
            accountId: "account-1",
            toolManifest: [{
                name: "propose_order",
                schemaHash: "a".repeat(64),
            }],
            now: now + 2_000,
        })).toBe(false)
    })

    it("query returns only bounded applicable memory for the requested strategy", async () => {
        const rows = {
            strategy_operational_memories: [
                createMemory({
                    memoryKey: "memory-critical",
                    strategyId: "strategy-1",
                    accountId: "account-1",
                    type: "provider_truth_warning",
                    severity: "critical",
                    score: 100,
                }),
                createMemory({
                    memoryKey: "memory-schema-stale",
                    strategyId: "strategy-1",
                    accountId: "account-1",
                    toolName: "propose_order",
                    schemaHash: "stale",
                }),
                createMemory({
                    memoryKey: "memory-other-strategy",
                    strategyId: "strategy-2",
                    accountId: "account-1",
                }),
                {
                    ...createMemory({
                        memoryKey: "memory-superseded",
                        strategyId: "strategy-1",
                        accountId: "account-1",
                    }),
                    status: "superseded",
                },
            ] satisfies FakeRow[],
        }

        const result = await callRegisteredQuery(getApplicableStrategyOperationalMemory, rows, {
            strategyId: "strategy-1",
            app: "polymarket",
            accountId: "account-1",
            toolManifest: [{
                name: "propose_order",
                schemaHash: "current",
            }],
            now,
            limit: 5,
        }) as StrategyOperationalMemory[]

        expect(result.map((memory) => memory.memoryKey)).toEqual(["memory-critical"])
    })

    it("query returns the same applicable memory through projected indexes", async () => {
        const rows = {
            strategy_operational_memories: [
                projectMemory(createMemory({
                    memoryKey: "memory-critical",
                    strategyId: "strategy-1",
                    accountId: "account-1",
                    type: "provider_truth_warning",
                    severity: "critical",
                    score: 100,
                })),
                projectMemory(createMemory({
                    memoryKey: "memory-schema-current",
                    strategyId: "strategy-1",
                    accountId: "account-1",
                    toolName: "propose_order",
                    schemaHash: "current",
                    score: 80,
                })),
                projectMemory(createMemory({
                    memoryKey: "memory-provider-current",
                    strategyId: "strategy-1",
                    accountId: "account-1",
                    providerId: "macro",
                    toolName: "propose_order",
                    schemaHash: "current",
                    score: 85,
                })),
                projectMemory(createMemory({
                    memoryKey: "memory-other-provider",
                    strategyId: "strategy-1",
                    accountId: "account-1",
                    providerId: "other",
                    toolName: "propose_order",
                    schemaHash: "current",
                    score: 95,
                })),
                projectMemory(createMemory({
                    memoryKey: "memory-schema-stale",
                    strategyId: "strategy-1",
                    accountId: "account-1",
                    toolName: "propose_order",
                    schemaHash: "stale",
                    score: 90,
                })),
                projectMemory(createMemory({
                    memoryKey: "memory-other-strategy",
                    strategyId: "strategy-2",
                    accountId: "account-1",
                    score: 200,
                })),
            ] satisfies FakeRow[],
        }

        const result = await callRegisteredQuery(getApplicableStrategyOperationalMemory, rows, {
            strategyId: "strategy-1",
            app: "polymarket",
            accountId: "account-1",
            toolManifest: [{
                name: "propose_order",
                schemaHash: "current",
                contractOwner: "mcp:macro",
            }],
            now,
            limit: 5,
        }) as StrategyOperationalMemory[]

        expect(result.map((memory) => memory.memoryKey)).toEqual([
            "memory-critical",
            "memory-provider-current",
            "memory-schema-current",
        ])
    })

    it("mutation upserts completed run memory from canonical persisted rows", async () => {
        const db = new FakeMutationDb({
            strategies: [{
                _id: "strategy-1",
                app: "polymarket",
                accountId: "account-1",
            }],
            strategy_runs: [{
                _id: "run-1",
                strategyId: "strategy-1",
                app: "polymarket",
                accountId: "account-1",
                status: "completed",
                startedAt: now - 1_000,
                endedAt: now,
                summary: "Watch the market but verify current prices.",
                toolManifest: [{
                    name: "mcp_macro_rates",
                    schemaHash: "a".repeat(64),
                    category: "research",
                    contractOwner: "mcp:macro",
                }],
            }],
            agent_logs: [{
                _id: "log-1",
                runId: "run-1",
                strategyId: "strategy-1",
                sequence: 1,
                role: "tool",
                toolName: "mcp_macro_rates",
                toolInput: JSON.stringify({ topic: "rates" }),
                toolOutput: JSON.stringify({ ok: true }),
                content: JSON.stringify({ ok: true }),
                timestamp: now,
            }],
            strategy_operational_memories: [],
        })
        const ctx = {
            db,
        }

        const result = await callRegistered(refreshStrategyOperationalMemoryFromRun, ctx as never, {
            serviceToken: "test-token",
            runId: "run-1",
        }) as { upserted: number }

        expect(result.upserted).toBeGreaterThan(0)
        expect(db.rows.strategy_operational_memories?.map((row) => row.type)).toEqual(expect.arrayContaining([
            "run_handoff_fact",
            "tool_invocation_success",
            "external_tool_discovery",
        ]))
    })
})

function createCompletedRunEvidence() {
    return {
        run: {
            _id: "run-1",
            strategyId: "strategy-1",
            app: "polymarket" as const,
            accountId: "account-1",
            status: "completed" as const,
            startedAt: now - 60_000,
            endedAt: now,
            summary: "Prior summary with market thesis.",
            systemContextDigest: {
                risk: {
                    unresolvedExecutionFaultCount: 1,
                    cooldownActive: false,
                    blockedInstruments: [],
                },
            },
            mcpToolDiagnostics: [{
                providerId: "macro",
                registeredName: "mcp_macro_rates",
                reason: "schema_changed",
                message: "schema changed",
            }],
            toolManifest: [{
                name: "propose_order",
                schemaHash: "b".repeat(64),
                category: "execution",
                contractBoundary: "venue-owned",
            }, {
                name: "mcp_macro_rates",
                schemaHash: "a".repeat(64),
                category: "research",
                contractOwner: "mcp:macro",
            }],
        },
        strategy: {
            _id: "strategy-1",
            app: "polymarket" as const,
            accountId: "account-1",
        },
        agentLogs: [{
            _id: "log-failure",
            runId: "run-1",
            strategyId: "strategy-1",
            sequence: 1,
            role: "tool",
            toolName: "propose_order",
            toolInput: JSON.stringify({ tokenHandle: "pm_1234" }),
            toolOutput: JSON.stringify({
                error: "Parameter validation failed",
                details: {
                    issues: [{
                        path: ["limitPrice"],
                        code: "invalid_type",
                        expected: "number",
                        message: "Required",
                    }],
                },
            }),
            content: JSON.stringify({ error: "Parameter validation failed" }),
            timestamp: now - 1_000,
        }, {
            _id: "log-success",
            runId: "run-1",
            strategyId: "strategy-1",
            sequence: 2,
            role: "tool",
            toolName: "mcp_macro_rates",
            toolInput: JSON.stringify({ topic: "rates" }),
            toolOutput: JSON.stringify({ ok: true }),
            content: JSON.stringify({ ok: true }),
            timestamp: now,
        }],
        now,
    }
}

function createMemory(args: {
    memoryKey: string
    strategyId: string
    accountId: string
    type?: StrategyOperationalMemory["type"]
    severity?: StrategyOperationalMemory["severity"]
    score?: number
    providerId?: string
    toolName?: string
    schemaHash?: string
    expiresAt?: number
}): StrategyOperationalMemory & FakeRow {
    return {
        _id: args.memoryKey,
        schemaVersion: 1,
        memoryKey: args.memoryKey,
        strategyId: args.strategyId,
        app: "polymarket",
        accountId: args.accountId,
        type: args.type ?? "tool_argument_failure",
        status: "active",
        severity: args.severity ?? "medium",
        confidence: 0.9,
        scope: {
            app: "polymarket",
            accountId: args.accountId,
            providerId: args.providerId,
            toolName: args.toolName,
            schemaHash: args.schemaHash,
        },
        sources: [{
            runId: "run-1",
            timestamp: now,
        }],
        evidence: {
            attemptCount: 1,
            successCount: 0,
            failureCount: 1,
        },
        lesson: {
            summary: "test memory",
            providerTruth: "not_verified",
        },
        ranking: {
            score: args.score ?? 50,
            expiresAt: args.expiresAt ?? now + 60_000,
        },
        createdAt: now,
        updatedAt: now,
    }
}

function projectMemory(
    memory: StrategyOperationalMemory & FakeRow
): StrategyOperationalMemory & FakeRow {
    return {
        ...memory,
        ...buildStrategyOperationalMemoryProjection(memory),
    }
}
