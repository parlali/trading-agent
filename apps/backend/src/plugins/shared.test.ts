import { afterEach, describe, expect, it, vi } from "vitest"
import type { Logger, Position, WorkingOrder } from "@valiq-trading/core"
import {
    appendValiqDataSecretKeys,
    appendValiqSecretKeys,
    createValiqTools,
    executeSessionFlatIfNeeded,
} from "./shared"

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

function createStandardValiqSecrets(): Record<string, string | null> {
    return {
        VALIQ_API_URL: "https://valiq.example",
        VALIQ_AUTH_URL: "https://auth.example",
        VALIQ_OAUTH_CLIENT_ID: "client-id",
        VALIQ_OAUTH_CLIENT_SECRET: "client-secret",
        VALIQ_OAUTH_USER_UUID: "user-uuid",
        VALIQ_DATA_API_URL: "https://data.example",
        VALIQ_DATA_API: "data-api-key",
    }
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

    it("appends canonical Valiq secret keys once while preserving venue keys", () => {
        expect(appendValiqSecretKeys([
            "OKX_API_KEY",
            "VALIQ_API_URL",
        ])).toEqual([
            "OKX_API_KEY",
            "VALIQ_API_URL",
            "VALIQ_AUTH_URL",
            "VALIQ_OAUTH_CLIENT_ID",
            "VALIQ_OAUTH_CLIENT_SECRET",
            "VALIQ_OAUTH_USER_UUID",
            "VALIQ_DATA_API_URL",
            "VALIQ_DATA_API",
        ])

        expect(appendValiqDataSecretKeys([
            "POLYMARKET_PRIVATE_KEY",
            "VALIQ_DATA_API",
        ])).toEqual([
            "POLYMARKET_PRIVATE_KEY",
            "VALIQ_DATA_API",
            "VALIQ_DATA_API_URL",
        ])
    })

    it("registers requested Valiq tools only from complete canonical credentials", () => {
        const runLogger = createTestLogger()

        const tools = createValiqTools({
            secrets: createStandardValiqSecrets(),
            runLogger,
        }, {
            research: true,
            data: true,
            breakingNews: true,
        })

        expect(tools.map((tool) => tool.name)).toEqual([
            "query_valiq_research",
            "query_valiq_data",
            "get_breaking_news",
        ])
        expect(runLogger.warn).not.toHaveBeenCalled()
    })

    it("logs bounded missing-secret reasons instead of partially registering Valiq tools", () => {
        const runLogger = createTestLogger()

        const tools = createValiqTools({
            secrets: {
                ...createStandardValiqSecrets(),
                VALIQ_OAUTH_CLIENT_SECRET: null,
                VALIQ_DATA_API: null,
            },
            runLogger,
        }, {
            research: true,
            data: true,
        })

        expect(tools).toEqual([])
        expect(runLogger.warn).toHaveBeenCalledWith(
            "Valiq research tool NOT registered: missing secrets",
            { missing: ["VALIQ_OAUTH_CLIENT_SECRET"] }
        )
        expect(runLogger.warn).toHaveBeenCalledWith(
            "Valiq data tools NOT registered: missing secrets",
            { missing: ["VALIQ_DATA_API"] }
        )
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
