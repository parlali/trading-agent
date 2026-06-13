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
        createHttpMcpToolBindings: vi.fn(async ({ providers }: {
            providers: Array<{ id: string; category?: string }>
        }) =>
            providers.map((provider: { id: string; category?: string }) => ({
                name: `mcp_${provider.id}_research`,
                description: "Remote research",
                parameters: { safeParse: (value: unknown) => ({ success: true, data: value }) },
                category: provider.category ?? "research",
                handler: vi.fn(),
            }))
        ),
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
            "MCP_PROVIDER_1_ID",
            "MCP_PROVIDER_1_URL",
            "MCP_PROVIDER_1_TOKEN",
            "MCP_PROVIDER_1_CATEGORY",
            "MCP_PROVIDER_1_TIMEOUT_MS",
            "MCP_PROVIDER_1_MAX_TOOLS",
            "MCP_PROVIDER_2_ID",
            "MCP_PROVIDER_2_URL",
            "MCP_PROVIDER_2_TOKEN",
            "MCP_PROVIDER_2_CATEGORY",
            "MCP_PROVIDER_2_TIMEOUT_MS",
            "MCP_PROVIDER_2_MAX_TOOLS",
            "MCP_PROVIDER_3_ID",
            "MCP_PROVIDER_3_URL",
            "MCP_PROVIDER_3_TOKEN",
            "MCP_PROVIDER_3_CATEGORY",
            "MCP_PROVIDER_3_TIMEOUT_MS",
            "MCP_PROVIDER_3_MAX_TOOLS",
            "MCP_PROVIDER_4_ID",
            "MCP_PROVIDER_4_URL",
            "MCP_PROVIDER_4_TOKEN",
            "MCP_PROVIDER_4_CATEGORY",
            "MCP_PROVIDER_4_TIMEOUT_MS",
            "MCP_PROVIDER_4_MAX_TOOLS",
            "MCP_PROVIDER_5_ID",
            "MCP_PROVIDER_5_URL",
            "MCP_PROVIDER_5_TOKEN",
            "MCP_PROVIDER_5_CATEGORY",
            "MCP_PROVIDER_5_TIMEOUT_MS",
            "MCP_PROVIDER_5_MAX_TOOLS",
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

    it("registers MCP tools from generic single-provider config", async () => {
        const runLogger = createTestLogger()

        const tools = await createMcpTools({
            secrets: {
                MCP_SERVER_URL: "https://mcp.example",
                MCP_SERVER_TOKEN: "token",
            },
            runLogger,
        })

        expect(tools.map((tool) => tool.name)).toEqual(["mcp_default_research"])
        expect(tools[0]?.category).toBe("research")
    })

    it("rejects duplicate MCP provider ids instead of choosing a silent fallback", async () => {
        const runLogger = createTestLogger()

        await expect(createMcpTools({
            secrets: {
                MCP_SERVER_URL: "https://mcp.example",
                MCP_PROVIDER_1_ID: "default",
                MCP_PROVIDER_1_URL: "https://other.example",
            },
            runLogger,
        })).rejects.toThrow("Duplicate MCP provider id configured: default")
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
