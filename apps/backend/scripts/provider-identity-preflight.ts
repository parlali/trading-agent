import { pathToFileURL } from "node:url"
import {
    VENUE_APPS,
    type App,
    type OrderSnapshot,
    type PortfolioPendingOrder,
    type PortfolioPosition,
} from "@valiq-trading/core"
import type {
    ExecutionSafetyFaultRow,
    PortfolioFreshnessRow,
    StoredAccount,
    StoredStrategy,
    TradingBackendClient,
} from "@valiq-trading/convex"
import {
    createClient,
    createOrderPersistenceAdapter,
    resolveArg,
    runScript,
} from "./lib/strategy-cli"
import {
    isDryRunStrategy,
    refreshProviderPortfolioState,
} from "./lib/safe-strategy-reset"
import {
    findMT5ConfiguredInstrumentConflicts,
    formatMT5ConfiguredInstrumentConflict,
} from "../src/mt5-configured-instrument-governance"

type VenueApp = Exclude<App, "backend">

interface AccountScope {
    app: VenueApp
    accountId: string
}

export async function runProviderIdentityPreflight(): Promise<void> {
    const client = createClient()
    const orderPersistence = createOrderPersistenceAdapter()
    const appFilter = resolveVenueApp(resolveArg("app"))
    const apps: VenueApp[] = appFilter ? [appFilter] : [...VENUE_APPS]
    const accounts = (await client.getAccounts())
        .filter((account) => apps.includes(account.app as VenueApp))
    const strategies = (await client.getAllStrategies())
        .filter((strategy) => apps.includes(strategy.app as VenueApp))
    const accountScopes = resolvePreflightAccountScopes(apps, accounts, strategies)

    const failures: string[] = []
    await refreshProviderTruth(client, accountScopes, strategies, failures, {
        requireLiveStrategy: appFilter !== undefined,
    })
    inspectMT5ConfiguredInstrumentConflicts(strategies, failures)
    await inspectProviderFreshness(client, accountScopes, failures)
    await inspectProviderExposure(client, accountScopes, failures)
    await inspectActiveOrders(strategies, orderPersistence, client, failures)

    if (failures.length > 0) {
        console.error("Provider identity preflight failed:")
        for (const failure of failures) {
            console.error(`  - ${failure}`)
        }
        throw new Error(`Provider identity preflight failed with ${failures.length} issue(s)`)
    }

    console.log(
        `Provider identity preflight passed for ${formatAccountScopes(accountScopes)} with ${strategies.length} strategy record(s) checked`
    )
}

function inspectMT5ConfiguredInstrumentConflicts(
    strategies: StoredStrategy[],
    failures: string[]
): void {
    for (const conflict of findMT5ConfiguredInstrumentConflicts(strategies)) {
        failures.push(formatMT5ConfiguredInstrumentConflict(conflict))
    }
}

async function refreshProviderTruth(
    client: TradingBackendClient,
    accountScopes: AccountScope[],
    strategies: StoredStrategy[],
    failures: string[],
    options?: {
        requireLiveStrategy?: boolean
    }
): Promise<void> {
    const refreshStrategies = selectProviderRefreshStrategies(accountScopes, strategies)

    for (const scope of accountScopes) {
        const strategy = refreshStrategies.get(formatAccountScopeKey(scope))
        if (!strategy) {
            const message = `${formatAccountScope(scope)}: no live strategy is available to refresh provider state with scheduled credentials`
            if (options?.requireLiveStrategy) {
                failures.push(message)
            } else {
                console.warn(`${message}; auditing stored provider rows only`)
            }
            continue
        }

        try {
            await refreshProviderPortfolioState(client, strategy)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push(`${formatAccountScope(scope)}: provider truth refresh failed: ${message}`)
        }
    }
}

function selectProviderRefreshStrategies(
    accountScopes: AccountScope[],
    strategies: StoredStrategy[]
): Map<string, StoredStrategy> {
    const result = new Map<string, StoredStrategy>()

    for (const scope of accountScopes) {
        const candidates = strategies
            .filter((strategy) =>
                strategy.app === scope.app &&
                strategy.accountId === scope.accountId &&
                !isDryRunStrategy(strategy)
            )
            .sort(compareProviderRefreshStrategies)
        const strategy = candidates[0]
        if (strategy) {
            result.set(formatAccountScopeKey(scope), strategy)
        }
    }

    return result
}

function compareProviderRefreshStrategies(left: StoredStrategy, right: StoredStrategy): number {
    const enabledOrder = Number(right.enabled === true) - Number(left.enabled === true)
    if (enabledOrder !== 0) {
        return enabledOrder
    }

    return left.name.localeCompare(right.name)
}

function resolvePreflightAccountScopes(
    apps: VenueApp[],
    accounts: StoredAccount[],
    strategies: StoredStrategy[]
): AccountScope[] {
    const activeAccountScopes = accounts
        .filter((account) => account.status === "active")
        .map((account) => ({
            app: account.app as VenueApp,
            accountId: account.accountId,
        }))
    const strategyAccountScopes = strategies.map((strategy) => ({
        app: strategy.app as VenueApp,
        accountId: strategy.accountId,
    }))
    const scopesByKey = new Map<string, AccountScope>()

    for (const scope of [...activeAccountScopes, ...strategyAccountScopes]) {
        if (apps.includes(scope.app)) {
            scopesByKey.set(formatAccountScopeKey(scope), scope)
        }
    }

    return Array.from(scopesByKey.values())
        .sort((left, right) => formatAccountScope(left).localeCompare(formatAccountScope(right)))
}

function formatAccountScopes(scopes: AccountScope[]): string {
    return scopes.length > 0
        ? scopes.map(formatAccountScope).join(", ")
        : "<none>"
}

function formatAccountScope(scope: AccountScope): string {
    return `${scope.app}:${scope.accountId}`
}

function formatAccountScopeKey(scope: AccountScope): string {
    return `${scope.app}\u0000${scope.accountId}`
}

if (isExecutedDirectly()) {
    runScript(runProviderIdentityPreflight)
}

async function inspectProviderFreshness(
    client: TradingBackendClient,
    accountScopes: AccountScope[],
    failures: string[]
): Promise<void> {
    for (const scope of accountScopes) {
        const row = (await client.getPortfolioFreshness(scope.app, scope.accountId))[0]
        if (!row) {
            failures.push(`${formatAccountScope(scope)}: provider sync state is missing`)
            continue
        }
        inspectFreshnessRow(row, failures)
    }
}

function inspectFreshnessRow(row: PortfolioFreshnessRow, failures: string[]): void {
    if (row.stale) {
        failures.push(`${formatRowScope(row)}: provider sync is stale`)
    }
    if (row.providerStatus !== "healthy") {
        failures.push(`${formatRowScope(row)}: provider status is ${row.providerStatus}`)
    }
    if (row.driftDetected) {
        failures.push(`${formatRowScope(row)}: provider drift detected${formatDetail(row.lastDriftSummary)}`)
    }
    if (row.lastError) {
        failures.push(`${formatRowScope(row)}: provider sync error${formatDetail(row.lastError)}`)
    }
}

function formatRowScope(row: PortfolioFreshnessRow): string {
    return row.accountId ? `${row.app}:${row.accountId}` : row.app
}

async function inspectProviderExposure(
    client: TradingBackendClient,
    accountScopes: AccountScope[],
    failures: string[]
): Promise<void> {
    for (const scope of accountScopes) {
        const [positions, orders] = await Promise.all([
            client.getPortfolioPositions(scope.app, undefined, scope.accountId),
            client.getPortfolioPendingOrders(scope.app, undefined, scope.accountId),
        ])

        for (const position of positions) {
            inspectProviderPosition(position, failures)
        }

        for (const order of orders) {
            inspectProviderOrder(order, failures)
        }
    }
}

function inspectProviderPosition(position: PortfolioPosition, failures: string[]): void {
    if (position.expectedExternal) {
        return
    }

    if (position.ownershipStatus !== "owned") {
        failures.push(
            `${position.app}: ${position.ownershipStatus} non-external provider position ${position.instrument} (${formatProviderPositionEvidence(position)})`
        )
    }
}

function inspectProviderOrder(order: PortfolioPendingOrder, failures: string[]): void {
    if (order.expectedExternal) {
        return
    }

    if (order.ownershipStatus !== "owned") {
        failures.push(
            `${order.app}: ${order.ownershipStatus} non-external provider order ${order.orderId} ${order.instrument} (${formatProviderOrderEvidence(order)})`
        )
        return
    }

    if (!isCanonicalOrderId(order.canonicalOrderId)) {
        failures.push(`${order.app}: owned provider order ${order.orderId} for ${order.instrument} has no real canonical order id (${formatProviderOrderEvidence(order)})`)
    }
    if (!hasProviderClientIdentity(order)) {
        failures.push(`${order.app}: owned provider order ${order.orderId} has no provider client identity (${formatProviderOrderEvidence(order)})`)
    }
    if (!hasProviderOrderIdentity(order)) {
        failures.push(`${order.app}: owned provider order ${order.orderId} has no provider order identity (${formatProviderOrderEvidence(order)})`)
    }
}

async function inspectActiveOrders(
    strategies: StoredStrategy[],
    orderPersistence: ReturnType<typeof createOrderPersistenceAdapter>,
    client: TradingBackendClient,
    failures: string[]
): Promise<void> {
    for (const strategy of strategies) {
        const [activeOrders, faults] = await Promise.all([
            orderPersistence.listActiveOrders(String(strategy._id)),
            client.getStrategyExecutionSafetyFaults(strategy._id, true),
        ])

        for (const order of activeOrders) {
            inspectActiveOrder(strategy, order, failures)
        }

        for (const fault of faults) {
            inspectSafetyFault(strategy, fault, failures)
        }
    }
}

function inspectActiveOrder(
    strategy: StoredStrategy,
    order: OrderSnapshot,
    failures: string[]
): void {
    if (order.commitOutcome === "commit_unknown") {
        failures.push(`${strategy.app}: ${strategy.name} has commit-unknown order ${order.orderId} (${formatActiveOrderEvidence(order)})`)
    }
    if (!isCanonicalOrderId(order.canonicalOrderId ?? order.orderId)) {
        failures.push(`${strategy.app}: ${strategy.name} active order ${order.orderId} has no canonical identity (${formatActiveOrderEvidence(order)})`)
    }
    if (!hasText(order.providerClientOrderId) && !hasText(order.signedOrderFingerprint)) {
        failures.push(`${strategy.app}: ${strategy.name} active order ${order.orderId} has no provider client identity (${formatActiveOrderEvidence(order)})`)
    }
}

function inspectSafetyFault(
    strategy: StoredStrategy,
    fault: ExecutionSafetyFaultRow,
    failures: string[]
): void {
    if (!fault.blocked) {
        return
    }

    failures.push(`${strategy.app}: ${strategy.name} has unresolved blocked safety fault ${fault.category}: ${fault.message}`)
}

function resolveVenueApp(value: string | undefined): VenueApp | undefined {
    if (!value) {
        return undefined
    }

    const app = value.trim() as VenueApp
    if (!VENUE_APPS.includes(app)) {
        throw new Error(`Unsupported app ${value}. Expected one of: ${VENUE_APPS.join(", ")}`)
    }

    return app
}

function hasProviderClientIdentity(order: Pick<PortfolioPendingOrder | OrderSnapshot, "providerClientOrderId" | "signedOrderFingerprint">): boolean {
    return hasText(order.providerClientOrderId) || hasText(order.signedOrderFingerprint)
}

function hasProviderOrderIdentity(order: Pick<PortfolioPendingOrder, "providerOrderId" | "providerOrderAliases">): boolean {
    return hasText(order.providerOrderId) || (order.providerOrderAliases ?? []).some(hasText)
}

function isCanonicalOrderId(value: string | undefined): boolean {
    return typeof value === "string" && /^v[a-z0-9]{5}[a-z2-7]{10}$/.test(value)
}

function hasText(value: string | undefined): boolean {
    return typeof value === "string" && value.trim().length > 0
}

function formatDetail(value: string | undefined): string {
    return value ? `: ${value}` : ""
}

function formatProviderPositionEvidence(position: PortfolioPosition): string {
    return [
        `qty=${position.quantity}`,
        `side=${position.side}`,
        `positionKey=${formatValue(position.positionKey)}`,
        `strategy=${formatValue(position.strategyName ?? position.strategyId)}`,
        "operator_action=adopt_expected_external_or_close",
    ].join(" ")
}

function formatProviderOrderEvidence(order: PortfolioPendingOrder): string {
    return [
        `canonical=${formatValue(order.canonicalOrderId)}`,
        `provider=${formatValue(order.providerOrderId)}`,
        `client=${formatValue(order.providerClientOrderId ?? order.signedOrderFingerprint)}`,
        `aliases=${formatList(order.providerOrderAliases)}`,
        `strategy=${formatValue(order.strategyName ?? order.strategyId)}`,
        `status=${order.status}`,
        `remaining=${order.remainingQuantity}`,
        `metadata.comment=${formatValue(readMetadataString(order.metadata, "comment"))}`,
        "operator_action=cancel_adopt_or_manual_reconcile",
    ].join(" ")
}

function formatActiveOrderEvidence(order: OrderSnapshot): string {
    return [
        `canonical=${formatValue(order.canonicalOrderId ?? order.orderId)}`,
        `provider=${formatValue(order.providerOrderId)}`,
        `client=${formatValue(order.providerClientOrderId ?? order.signedOrderFingerprint)}`,
        `aliases=${formatList(order.providerOrderAliases)}`,
        `commit=${formatValue(order.commitOutcome)}`,
        `status=${order.status}`,
    ].join(" ")
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = metadata?.[key]
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function formatValue(value: string | number | undefined): string {
    if (value === undefined || value === "") {
        return "<missing>"
    }

    return String(value)
}

function formatList(values: string[] | undefined): string {
    return values && values.length > 0 ? values.join(",") : "<none>"
}

function isExecutedDirectly(): boolean {
    const entry = process.argv[1]
    return entry ? import.meta.url === pathToFileURL(entry).href : false
}

export const providerIdentityPreflightTestables = {
    inspectMT5ConfiguredInstrumentConflicts,
    inspectActiveOrder,
    inspectProviderPosition,
    inspectProviderOrder,
    inspectSafetyFault,
    isCanonicalOrderId,
    selectProviderRefreshStrategies,
}
