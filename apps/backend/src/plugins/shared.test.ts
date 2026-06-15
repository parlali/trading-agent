import { afterEach, describe, expect, it, vi } from "vitest"
import type { Logger, Position, WorkingOrder } from "@valiq-trading/core"
import {
    appendMcpSecretKeys,
    createMcpTools,
    executeSessionFlatIfNeeded,
} from "./shared"

vi.mock("@valiq-trading/agent", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@valiq-trading/agent")>()
    return {
        ...actual,
        createHttpMcpToolBindingResolution: vi.fn(async ({ providers }: {
            providers: Array<{ id: string; category?: string }>
        }) => ({
            bindings: providers.map((provider: { id: string; category?: string }) => ({
                name: `mcp_${provider.id}_research`,
                description: "Remote research",
                parameters: { safeParse: (value: unknown) => ({ success: true, data: value }) },
                category: provider.category ?? "research",
                handler: vi.fn(),
            })),
            inventory: [],
            diagnostics: [],
        })),
    }
})

function createTestLogger(): Logger {
    const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
    } as unknown as Logger

    const childMock = logger.child as ReturnType<typeof vi.fn>
    childMock.mockReturnValue(logger)

    return logger
}

function createSessionFlatPolicy() {
    return {
        tradingHours: {
            end: "23:59",
            timezone: "UTC",
        },
        safety: {
            sessionFlat: {
                enabled: true,
                closeBufferMinutes: 15,
                timezone: "UTC",
            },
        },
    }
}

function createPendingWorkingOrder(args: {
    orderId: string
    instrument: string
    quantity: number
}): WorkingOrder {
    const now = Date.now()
    const expiresAt = now + 3_600_000

    return {
        orderId: args.orderId,
        instrument: args.instrument,
        status: "pending",
        quantity: args.quantity,
        filledQuantity: 0,
        remainingQuantity: args.quantity,
        submittedAt: now,
        updatedAt: now,
        cancelAt: expiresAt,
    }
}

describe("backend plugin shared helpers", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("appends canonical MCP secret keys once while preserving venue keys", () => {
        expect(appendMcpSecretKeys([
            "OKX_API_KEY",
            "MCP_SERVER_URL",
        ])).toEqual([
            "OKX_API_KEY",
            "MCP_SERVER_URL",
            "MCP_PROVIDER_CONFIGS",
            "MCP_SERVER_TOKEN",
            "MCP_SERVER_ALLOWED_TOOLS",
        ])
    })

    it("returns no MCP tools when no generic provider is configured", async () => {
        const runLogger = createTestLogger()

        const tools = await createMcpTools({
            secrets: {},
            runLogger,
        })

        expect(tools).toEqual([])
        expect(runLogger.warn).not.toHaveBeenCalled()
    })

    it("fails closed when generic MCP providers have no persisted strategy whitelist", async () => {
        const runLogger = createTestLogger()

        const tools = await createMcpTools({
            secrets: {
                MCP_SERVER_URL: "https://mcp.example",
                MCP_SERVER_TOKEN: "token",
            },
            runLogger,
        })

        expect(tools).toEqual([])
        expect(runLogger.warn).toHaveBeenCalledWith(
            "MCP tool skipped by strategy scope",
            expect.objectContaining({
                providerId: "default",
                reason: "strategy_whitelist_missing",
            })
        )
    })

    it("registers MCP tools from generic single-provider config and persisted strategy whitelist", async () => {
        const runLogger = createTestLogger()

        const tools = await createMcpTools({
            secrets: {
                MCP_SERVER_URL: "https://mcp.example",
                MCP_SERVER_TOKEN: "token",
            },
            runLogger,
            mcpToolWhitelist: {
                _id: "whitelist-1" as never,
                _creationTime: 1,
                strategyId: "strategy-1" as never,
                tools: [{
                    providerId: "default",
                    toolName: "research",
                    registeredName: "mcp_default_research",
                    schemaHash: "a".repeat(64),
                }],
                createdAt: 1,
                updatedAt: 1,
            },
        })

        expect(tools.map((tool) => tool.name)).toEqual(["mcp_default_research"])
        expect(tools[0]?.category).toBe("research")
    })

    it("rejects duplicate MCP provider ids instead of choosing a silent fallback", async () => {
        const runLogger = createTestLogger()

        await expect(createMcpTools({
            secrets: {
                MCP_SERVER_URL: "https://mcp.example",
                MCP_PROVIDER_CONFIGS: JSON.stringify([{
                    id: "default",
                    url: "https://other.example",
                }]),
            },
            runLogger,
        })).rejects.toThrow("Duplicate MCP provider id configured: default")
    })

    it("rejects MCP market-data category because remote providers are advisory research", async () => {
        const runLogger = createTestLogger()

        await expect(createMcpTools({
            secrets: {
                MCP_PROVIDER_CONFIGS: JSON.stringify([{
                    id: "macro",
                    url: "https://mcp.example",
                    category: "market-data",
                }]),
            },
            runLogger,
        })).rejects.toThrow("MCP_PROVIDER_CONFIGS[0].category must be research")
    })

    it("fails closed when session-flat triggers without the audited executor", async () => {
        vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-27T23:50:00.000Z"))

        const logger = createTestLogger()
        const createAlert = vi.fn(async () => {})
        const position: Position = {
            instrument: "BTC-USDT-SWAP",
            side: "long",
            quantity: 0.1,
            entryPrice: 80_000,
        }
        const workingOrder = createPendingWorkingOrder({
            orderId: "order-btc",
            instrument: "BTC-USDT-SWAP",
            quantity: 0.1,
        })

        await expect(executeSessionFlatIfNeeded({
            app: "okx-swap",
            strategyId: "strategy-btc",
            policy: createSessionFlatPolicy(),
            config: {
                logger,
                createAlert,
                ownedPositions: [position],
                ownedWorkingOrders: [workingOrder],
            },
            unavailableMessage: "Audited session-flat executor is unavailable for OKX",
            triggeredLogMessage: "OKX end-of-session flatten triggered",
            completedLogMessage: "OKX end-of-session flatten completed",
        })).rejects.toThrow("Audited session-flat executor is unavailable for OKX")

        expect(logger.warn).toHaveBeenCalledWith(
            "OKX end-of-session flatten triggered",
            expect.objectContaining({
                strategyId: "strategy-btc",
                openPositions: 1,
                workingOrders: 1,
            })
        )
        expect(createAlert).toHaveBeenCalledTimes(1)
    })
})
