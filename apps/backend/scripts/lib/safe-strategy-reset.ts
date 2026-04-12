import {
    type DeleteStrategyResult,
    type Id,
    type PortfolioFreshnessRow,
    type ProviderPendingOrderRow,
    type ProviderPositionRow,
    type StoredStrategy,
    type TradingBackendClient,
} from "@valiq-trading/convex"
import {
    validatePolicy,
    type Position,
    type VenueAdapter,
    type WorkingOrder,
} from "@valiq-trading/core"
import { AlpacaPlugin } from "../../src/plugins/alpaca"
import { BinancePlugin } from "../../src/plugins/binance"
import { MT5Plugin } from "../../src/plugins/mt5"
import { PolymarketPlugin } from "../../src/plugins/polymarket"
import type { VenueApp, VenuePlugin } from "../../src/types"

const RESET_PLUGINS: Partial<Record<VenueApp, VenuePlugin>> = {
    "alpaca-options": new AlpacaPlugin(),
    "binance-futures": new BinancePlugin(),
    "polymarket": new PolymarketPlugin(),
    "mt5": new MT5Plugin(),
}

export interface SafeStrategyResetResult {
    strategy: StoredStrategy
    deleted: DeleteStrategyResult
    cancelledOrders: number
    closedPositions: number
}

export interface VenueResetContext {
    venue: VenueAdapter
    venueName: string
}

export interface VenueExposureResetResult {
    cancelledOrders: number
    closedPositions: number
    orderFailures: string[]
    positionFailures: string[]
}

export interface VenueMarketClock {
    isOpen: boolean
    nextOpen?: string
    nextClose?: string
}

export interface MarketClosedResetBlock {
    provider: string
    positions: Array<Pick<ProviderPositionRow, "instrument"> | Pick<Position, "instrument">>
    workingOrders: Array<Pick<ProviderPendingOrderRow, "orderId" | "instrument" | "metadata"> | Pick<WorkingOrder, "orderId" | "instrument" | "metadata">>
    nextOpen?: string
}

const RESET_VERIFICATION_ATTEMPTS = 6
const RESET_VERIFICATION_DELAY_MS = 1000

export async function resetStrategySafely(
    client: TradingBackendClient,
    strategyId: Id<"strategies">
): Promise<SafeStrategyResetResult> {
    const strategy = await client.getStrategyById(strategyId)

    if (!strategy) {
        throw new Error(`Strategy not found: ${strategyId}`)
    }

    const trackedPositions = await client.getPortfolioPositions(strategy.app, strategy._id)
    const trackedOrders = await client.getPortfolioPendingOrders(strategy.app, strategy._id)
    const freshness = await getFreshness(client, strategy.app)

    assertResetPreconditions(strategy, freshness, trackedPositions, trackedOrders)

    const activeRun = await client.getActiveRun(strategy._id)
    if (activeRun) {
        throw new Error("Cannot reset a strategy with an active run")
    }

    await client.disableStrategy(strategy._id)

    let cancelledOrders = 0
    let closedPositions = 0

    if (!isDryRunStrategy(strategy)) {
        const { venue } = await createVenue(strategy, client)
        const result = await flattenVenueExposure(venue, {
            positions: trackedPositions.map((position) => ({ instrument: position.instrument })),
            workingOrders: trackedOrders.map((order) => ({ orderId: order.orderId })),
        })
        cancelledOrders = result.cancelledOrders
        closedPositions = result.closedPositions

        await reconcileAndVerifyReset(client, strategy)
    }

    const deleted = await client.deleteStrategy(strategy._id)

    return {
        strategy,
        deleted,
        cancelledOrders,
        closedPositions,
    }
}

function assertResetPreconditions(
    strategy: StoredStrategy,
    freshness: PortfolioFreshnessRow | null,
    trackedPositions: ProviderPositionRow[],
    trackedOrders: ProviderPendingOrderRow[]
): void {
    if (isDryRunStrategy(strategy)) {
        return
    }

    const requiresHealthyProviderState =
        (freshness?.lastVerifiedAt ?? 0) > 0 ||
        trackedPositions.length > 0 ||
        trackedOrders.length > 0

    if (
        requiresHealthyProviderState &&
        (
            !freshness ||
            freshness.stale ||
            freshness.driftDetected ||
            freshness.providerStatus !== "healthy"
        )
    ) {
        throw new Error(
            `Refusing to reset ${strategy.name}: ${strategy.app} provider ownership is stale or drifted. Resolve venue ownership manually before retrying.`
        )
    }
}

export async function createVenue(
    strategy: StoredStrategy,
    client: TradingBackendClient
): Promise<VenueResetContext> {
    const plugin = RESET_PLUGINS[strategy.app]

    if (!plugin) {
        throw new Error(`No backend reset plugin registered for ${strategy.app}`)
    }

    const policy = validatePolicy(strategy.app, strategy.policy)
    const secretKeys = new Set([
        ...plugin.resolveSecretKeys(),
        ...(plugin.resolveAdditionalSecretKeys?.(policy) ?? []),
    ])
    const secrets = await client.resolveSecrets(Array.from(secretKeys))

    return {
        venue: plugin.createVenueAdapter(policy, secrets),
        venueName: plugin.venueName,
    }
}

export async function flattenVenueExposure(
    venue: VenueAdapter,
    exposure: {
        positions: Array<Pick<ProviderPositionRow, "instrument"> | Pick<Position, "instrument">>
        workingOrders: Array<Pick<ProviderPendingOrderRow, "orderId"> | Pick<WorkingOrder, "orderId">>
    }
): Promise<VenueExposureResetResult> {
    const cancelledOrders = await cancelOrders(
        venue,
        uniqueStrings(exposure.workingOrders.map((order) => order.orderId))
    )
    const closedPositions = await closePositions(
        venue,
        uniqueStrings(exposure.positions.map((position) => position.instrument))
    )

    return {
        cancelledOrders: cancelledOrders.count,
        closedPositions: closedPositions.count,
        orderFailures: cancelledOrders.failures,
        positionFailures: closedPositions.failures,
    }
}

export async function detectMarketClosedResetBlock(
    provider: string,
    venue: VenueAdapter,
    exposure?: {
        positions: Array<Pick<ProviderPositionRow, "instrument"> | Pick<Position, "instrument">>
        workingOrders: Array<Pick<ProviderPendingOrderRow, "orderId" | "instrument" | "metadata"> | Pick<WorkingOrder, "orderId" | "instrument" | "metadata">>
    }
): Promise<MarketClosedResetBlock | null> {
    if (!hasMarketClock(venue)) {
        return null
    }

    const clock = await venue.getMarketClock()
    if (clock.isOpen) {
        return null
    }

    const [positions, workingOrders] = exposure
        ? [exposure.positions, exposure.workingOrders]
        : await Promise.all([
            venue.getPositions(),
            venue.getWorkingOrders ? venue.getWorkingOrders() : Promise.resolve([]),
        ])

    if (positions.length === 0 || workingOrders.length === 0) {
        return null
    }

    const positionInstruments = new Set(positions.map((position) => position.instrument))
    const matchingWorkingOrders = workingOrders.filter((order) =>
        positionInstruments.has(order.instrument) && isCloseWorkingOrder(order)
    )

    if (matchingWorkingOrders.length === 0) {
        return null
    }

    return {
        provider,
        positions,
        workingOrders: matchingWorkingOrders,
        nextOpen: clock.nextOpen,
    }
}

export function isMarketClosedExecutionFailure(
    provider: string,
    message: string
): boolean {
    if (provider !== "alpaca-options") {
        return false
    }

    const normalized = message.toLowerCase()
    return normalized.includes("market closed") ||
        normalized.includes("market is closed") ||
        normalized.includes("market is not open") ||
        normalized.includes("outside market hours") ||
        normalized.includes("option market has closed")
}

async function cancelOrders(
    venue: VenueAdapter,
    orderIds: string[]
): Promise<{
    count: number
    failures: string[]
}> {
    let cancelled = 0
    const failures: string[] = []

    for (const orderId of orderIds) {
        try {
            const result = await venue.cancelOrder(orderId)
            if (result.status === "cancelled" || result.status === "filled") {
                cancelled++
            } else {
                failures.push(`order ${orderId}: ${result.error ?? result.status}`)
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push(`order ${orderId}: ${message}`)
        }
    }

    return {
        count: cancelled,
        failures,
    }
}

async function closePositions(
    venue: VenueAdapter,
    instruments: string[]
): Promise<{
    count: number
    failures: string[]
}> {
    let closed = 0
    const failures: string[] = []

    for (const instrument of instruments) {
        try {
            const result = await venue.closePosition(instrument)
            if (result.status === "filled" || result.status === "pending" || result.status === "partially_filled") {
                closed++
            } else {
                failures.push(`position ${instrument}: ${result.error ?? result.status}`)
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push(`position ${instrument}: ${message}`)
        }
    }

    return {
        count: closed,
        failures,
    }
}

export async function reconcileAndVerifyReset(
    client: TradingBackendClient,
    strategy: StoredStrategy,
    strategyId?: Id<"strategies">,
    options?: {
        requireHealthyState?: boolean
    }
): Promise<void> {
    const requireHealthyState = options?.requireHealthyState ?? true
    let lastFreshness: PortfolioFreshnessRow | null = null
    let lastRemainingPositions: ProviderPositionRow[] = []
    let lastRemainingOrders: ProviderPendingOrderRow[] = []

    for (let attempt = 0; attempt < RESET_VERIFICATION_ATTEMPTS; attempt++) {
        const { venue, venueName } = await createVenue(strategy, client)
        const [accountState, positions, workingOrders] = await Promise.all([
            venue.getAccountState(),
            venue.getPositions(),
            venue.getWorkingOrders ? venue.getWorkingOrders() : Promise.resolve([]),
        ])

        await client.reconcileProviderPortfolio(
            strategy.app,
            venueName,
            "periodic_sync",
            accountState,
            positions,
            workingOrders
        )

        ;[lastFreshness, lastRemainingPositions, lastRemainingOrders] = await Promise.all([
            getFreshness(client, strategy.app),
            client.getPortfolioPositions(strategy.app, strategyId),
            client.getPortfolioPendingOrders(strategy.app, strategyId),
        ])

        const healthy =
            lastFreshness &&
            !lastFreshness.stale &&
            !lastFreshness.driftDetected &&
            lastFreshness.providerStatus === "healthy"

        if (
            lastRemainingPositions.length === 0 &&
            lastRemainingOrders.length === 0 &&
            (!requireHealthyState || healthy)
        ) {
            return
        }

        if (attempt < RESET_VERIFICATION_ATTEMPTS - 1) {
            await sleep(RESET_VERIFICATION_DELAY_MS)
        }
    }

    if (
        requireHealthyState &&
        (
            !lastFreshness ||
            lastFreshness.stale ||
            lastFreshness.driftDetected ||
            lastFreshness.providerStatus !== "healthy"
        )
    ) {
        throw new Error(
            `Reset verification failed for ${strategy.name}: ${strategy.app} provider ownership is stale or drifted after cleanup.`
        )
    }

    throw new Error(
        `Reset verification failed for ${strategy.name}: ${lastRemainingPositions.length} provider position(s) and ${lastRemainingOrders.length} working order(s) still remain. ${formatRemainingExposure(lastRemainingPositions, lastRemainingOrders)}`
    )
}

async function getFreshness(
    client: TradingBackendClient,
    app: VenueApp
): Promise<PortfolioFreshnessRow | null> {
    const rows = await client.getPortfolioFreshness(app)
    return rows[0] ?? null
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values))
}

function formatRemainingExposure(
    positions: ProviderPositionRow[],
    orders: ProviderPendingOrderRow[]
): string {
    const parts: string[] = []

    if (positions.length > 0) {
        parts.push(`positions=${formatPositionList(positions)}`)
    }

    if (orders.length > 0) {
        parts.push(`orders=${formatOrderList(orders)}`)
    }

    return parts.join("; ")
}

function formatPositionList(positions: ProviderPositionRow[]): string {
    const values = uniqueStrings(
        positions.map((position) => `${position.instrument}:${position.quantity}`)
    )
    return formatList(values)
}

function formatOrderList(orders: ProviderPendingOrderRow[]): string {
    const values = uniqueStrings(
        orders.map((order) => `${order.orderId}:${order.instrument}`)
    )
    return formatList(values)
}

function formatList(values: string[]): string {
    if (values.length <= 5) {
        return values.join(", ")
    }

    return `${values.slice(0, 5).join(", ")}, ... (+${values.length - 5} more)`
}

function hasMarketClock(
    venue: VenueAdapter
): venue is VenueAdapter & { getMarketClock(): Promise<VenueMarketClock> } {
    return typeof (venue as Partial<{ getMarketClock(): Promise<VenueMarketClock> }>).getMarketClock === "function"
}

function isCloseWorkingOrder(
    order: Pick<ProviderPendingOrderRow, "metadata"> | Pick<WorkingOrder, "metadata">
): boolean {
    const legs = order.metadata?.legs
    if (!Array.isArray(legs) || legs.length === 0) {
        return false
    }

    return legs.every((leg) => {
        if (!leg || typeof leg !== "object") {
            return false
        }

        const record = leg as Record<string, unknown>
        return record.position_intent === "buy_to_close" ||
            record.position_intent === "sell_to_close" ||
            record.side === "buy_to_close" ||
            record.side === "sell_to_close"
    })
}

async function sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
}

export function isDryRunStrategy(strategy: Pick<StoredStrategy, "policy">): boolean {
    return strategy.policy.dryRun === true
}
