import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import {
    createConvexOrderPersistenceAdapter,
    createTradingBackendClient,
    type CascadeDeleteCounts,
    type DeleteOrphanedStrategyHistoryBatchResult,
    type FullResetAudit,
    type TradingBackendClient,
    type DeleteAllStrategiesResult,
} from "@valiq-trading/convex"
import { parseStrategyMarkdownDocument } from "@valiq-trading/core"
import type { App, OrderPersistenceAdapter, StrategyConfig } from "@valiq-trading/core"

const FULL_RESET_CLEAR_BATCH_SIZE = 20
const FULL_RESET_CLEAR_MAX_BATCHES = 10000
const strategyCliDir = dirname(fileURLToPath(import.meta.url))

export function resolveArg(name: string): string | undefined {
    const prefix = `--${name}=`
    const entry = process.argv.find((value) => value.startsWith(prefix))

    if (!entry) {
        return undefined
    }

    return entry.slice(prefix.length).trim() || undefined
}

export function requireArg(name: string): string {
    const value = resolveArg(name)

    if (!value) {
        throw new Error(`--${name}=<value> is required`)
    }

    return value
}

function requireEnv(name: string): string {
    const value = process.env[name]?.trim()

    if (!value) {
        throw new Error(`${name} is required`)
    }

    return value
}

export function createClient(): TradingBackendClient {
    return createTradingBackendClient({
        url: requireEnv("CONVEX_URL"),
        machineAuth: {
            serviceToken: requireEnv("BACKEND_SERVICE_TOKEN"),
        },
    })
}

export function createOrderPersistenceAdapter(): OrderPersistenceAdapter {
    return createConvexOrderPersistenceAdapter({
        url: requireEnv("CONVEX_URL"),
        machineAuth: {
            serviceToken: requireEnv("BACKEND_SERVICE_TOKEN"),
        },
    })
}

export function resolveDocumentPath(): string {
    return resolve(strategyCliDir, "../../../../private/strategies.md")
}

export async function loadStrategiesFromDocument(): Promise<StrategyConfig[]> {
    const documentPath = resolveDocumentPath()
    let markdown: string
    try {
        markdown = await readFile(documentPath, "utf8")
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Strategy document not found: ${documentPath} (${message})`)
    }
    const document = parseStrategyMarkdownDocument(markdown)

    console.log(`Parsed ${document.strategies.length} strategies from ${documentPath}`)

    return document.strategies
}

export function getStrategyModel(strategy: {
    policy: Record<string, unknown>
}): string {
    const model = strategy.policy.model

    if (typeof model !== "string" || model.trim().length === 0) {
        throw new Error("Strategy policy.model must be a non-empty string")
    }

    return model.trim()
}

export function findStrategyByName(
    strategies: StrategyConfig[],
    name: string
): StrategyConfig {
    const match = strategies.find(
        (s) => s.name.toLowerCase() === name.toLowerCase()
    )

    if (!match) {
        const available = strategies.map((s) => `  - ${s.name}`).join("\n")
        throw new Error(
            `Strategy "${name}" not found in document.\nAvailable:\n${available}`
        )
    }

    return match
}

export function printDeleteCounts(deleted: DeleteAllStrategiesResult): void {
    if ("strategies" in deleted) {
        console.log(`  strategies: ${deleted.strategies}`)
    }
    console.log(`  runs: ${deleted.runs}`)
    console.log(`  agent logs: ${deleted.agentLogs}`)
    console.log(`  trade events: ${deleted.tradeEvents}`)
    console.log(`  orders: ${deleted.orders}`)
    console.log(`  order transitions: ${deleted.orderTransitions}`)
    console.log(`  positions: ${deleted.positions}`)
    console.log(`  instrument claims: ${deleted.instrumentClaims}`)
    console.log(`  position syncs: ${deleted.positionSyncs}`)
    console.log(`  provider positions: ${deleted.providerPositions}`)
    console.log(`  provider working orders: ${deleted.providerWorkingOrders}`)
    console.log(`  provider sync states: ${deleted.providerSyncStates}`)
    console.log(`  account snapshots: ${deleted.accountSnapshots}`)
    console.log(`  app heartbeats: ${deleted.appHeartbeats}`)
    console.log(`  manual run requests: ${deleted.manualRunRequests}`)
    console.log(`  alerts: ${deleted.alerts}`)
}

export function createDeleteTotals(): DeleteAllStrategiesResult {
    return {
        strategies: 0,
        runs: 0,
        agentLogs: 0,
        tradeEvents: 0,
        orders: 0,
        orderTransitions: 0,
        positions: 0,
        instrumentClaims: 0,
        positionSyncs: 0,
        strategyRiskStates: 0,
        executionSafetyFaults: 0,
        providerPositions: 0,
        providerWorkingOrders: 0,
        providerSyncStates: 0,
        accountSnapshots: 0,
        appHeartbeats: 0,
        manualRunRequests: 0,
        alerts: 0,
    }
}

export function addDeleteCounts(
    totals: DeleteAllStrategiesResult,
    deleted: CascadeDeleteCounts
): void {
    for (const key of Object.keys(deleted) as Array<keyof CascadeDeleteCounts>) {
        totals[key] += deleted[key]
    }
}

export async function flushOrphanedStrategyHistory(
    client: TradingBackendClient,
    options?: {
        batchSize?: number
        log?: (message: string) => void
    }
): Promise<DeleteAllStrategiesResult> {
    const totals = createDeleteTotals()
    const log = options?.log
    const batchSize = options?.batchSize
    let batches = 0

    while (true) {
        const result = await client.deleteOrphanedStrategyHistoryBatch(batchSize)
        batches++
        addDeleteCounts(totals, result)

        const deletedThisBatch = sumDeleteCounts(result)
        if (deletedThisBatch > 0) {
            log?.(
                `Orphan history cleanup batch ${batches}: removed ${deletedThisBatch} document(s)`
            )
        }

        if (!result.hasMore) {
            break
        }
    }

    return totals
}

export async function finalizeFullResetCleanup(
    client: TradingBackendClient,
    options?: {
        batchSize?: number
        log?: (message: string) => void
        allowedProviderExposureApps?: Array<Exclude<App, "backend">>
    }
): Promise<{
    deleted: DeleteAllStrategiesResult
    audit: FullResetAudit
}> {
    const deleted = createDeleteTotals()
    const log = options?.log

    await assertNoProviderExposureBeforeCleanup(client, {
        allowedApps: options?.allowedProviderExposureApps,
    })

    if ((options?.allowedProviderExposureApps ?? []).length > 0) {
        log?.(
            `Orphan history cleanup deferred while provider exposure remains for ${options?.allowedProviderExposureApps?.join(", ")}`
        )
    } else {
        const orphaned = await flushOrphanedStrategyHistory(client, options)
        addDeleteCounts(deleted, orphaned)
    }

    const cleared = await clearFullResetStateInBatches(client, {
        preserveApps: options?.allowedProviderExposureApps,
        log,
    })
    addDeleteCounts(deleted, cleared)

    const clearedCount =
        cleared.providerSyncStates +
        cleared.accountSnapshots +
        cleared.appHeartbeats +
        cleared.alerts

    if (clearedCount > 0) {
        log?.(`Full-reset operational cleanup: removed ${clearedCount} document(s)`)
    }

    const audit = await client.getFullResetAudit()

    return {
        deleted,
        audit,
    }
}

async function clearFullResetStateInBatches(
    client: TradingBackendClient,
    options?: {
        preserveApps?: Array<Exclude<App, "backend">>
        log?: (message: string) => void
    }
): Promise<CascadeDeleteCounts> {
    const totals = createDeleteTotals()

    for (let batch = 1; batch <= FULL_RESET_CLEAR_MAX_BATCHES; batch++) {
        const result = await client.clearFullResetStateBatch(
            FULL_RESET_CLEAR_BATCH_SIZE,
            options?.preserveApps
        )
        addDeleteCounts(totals, result)

        if (!result.hasMore) {
            return totals
        }

        if (batch % 25 === 0) {
            options?.log?.(`Full-reset operational cleanup completed ${batch} batch(es)`)
        }
    }

    throw new Error(`Exceeded ${FULL_RESET_CLEAR_MAX_BATCHES} full-reset cleanup batches`)
}

export async function assertNoProviderExposureBeforeCleanup(
    client: TradingBackendClient,
    options?: {
        allowedApps?: Array<Exclude<App, "backend">>
    }
): Promise<void> {
    const allowedApps = new Set(options?.allowedApps ?? [])
    const [positions, orders] = await Promise.all([
        client.getPortfolioPositions(),
        client.getPortfolioPendingOrders(),
    ])
    const blockingPositions = positions.filter((position) => !allowedApps.has(position.app))
    const blockingOrders = orders.filter((order) => !allowedApps.has(order.app))

    if (blockingPositions.length === 0 && blockingOrders.length === 0) {
        return
    }

    const positionSummary = blockingPositions
        .slice(0, 5)
        .map((position) => `${position.app}:${position.instrument}:${position.ownershipStatus}`)
        .join(", ")
    const orderSummary = blockingOrders
        .slice(0, 5)
        .map((order) => `${order.app}:${order.orderId}:${order.instrument}:${order.ownershipStatus}`)
        .join(", ")

    throw new Error(
        `Refusing to clear provider state while live provider exposure remains in Convex. Positions=${blockingPositions.length}${positionSummary ? ` [${positionSummary}${blockingPositions.length > 5 ? ", ..." : ""}]` : ""}. Orders=${blockingOrders.length}${orderSummary ? ` [${orderSummary}${blockingOrders.length > 5 ? ", ..." : ""}]` : ""}. Resolve or flatten the venue first.`
    )
}

export function assertFullResetAuditClean(audit: FullResetAudit): void {
    const remaining = Object.entries(audit).filter(([, count]) => count > 0)

    if (remaining.length === 0) {
        return
    }

    const details = remaining
        .map(([key, count]) => `  - ${key}: ${count}`)
        .join("\n")

    throw new Error(`Full reset audit failed. Residual Convex state remains:\n${details}`)
}

function sumDeleteCounts(
    deleted: CascadeDeleteCounts | DeleteOrphanedStrategyHistoryBatchResult
): number {
    return (
        deleted.runs +
        deleted.agentLogs +
        deleted.tradeEvents +
        deleted.orders +
        deleted.orderTransitions +
        deleted.positions +
        deleted.instrumentClaims +
        deleted.positionSyncs +
        deleted.providerPositions +
        deleted.providerWorkingOrders +
        deleted.providerSyncStates +
        deleted.accountSnapshots +
        deleted.appHeartbeats +
        deleted.manualRunRequests +
        deleted.alerts
    )
}

export function runScript(main: () => Promise<void>): void {
    void main().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(message)
        process.exit(1)
    })
}
