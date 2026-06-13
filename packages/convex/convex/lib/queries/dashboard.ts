import { query } from "../../_generated/server"
import { requireUser } from "../authGuards"
import { getLatestPositionsForStrategy } from "../instrumentClaims"
import { isDryRunLedgerMetadata } from "../dryRunLedger"
import { createDefaultKillSwitchState } from "../killSwitchState"

function isNonNullable<T>(value: T): value is NonNullable<T> {
    return value !== null && value !== undefined
}
function resolveSnapshotEquity(snapshot: { balance: number; openPnl: number; equity?: number }): number {
    return snapshot.equity ?? (snapshot.balance + snapshot.openPnl)
}

export const getDashboardOverview = query({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)
        const [
            systemState,
            appHealth,
            accounts,
            strategies,
            runs,
            alerts,
            syncStates,
            riskStates,
        ] = await Promise.all([
            ctx.db
                .query("system_state")
                .withIndex("by_key", (q) => q.eq("key", "kill_switches"))
                .first(),
            ctx.db.query("app_heartbeats").collect(),
            ctx.db.query("accounts").collect(),
            ctx.db.query("strategies").collect(),
            ctx.db.query("strategy_runs").order("desc").take(50),
            ctx.db.query("alerts").order("desc").take(20),
            ctx.db.query("provider_sync_state").collect(),
            ctx.db.query("strategy_risk_states").collect(),
        ])

        const [accountSnapshotsByAccount, accountPnlEventsByAccount, unresolvedFaultsByAccount, openPositionsByStrategy] = await Promise.all([
            Promise.all(
                accounts.map((account) =>
                    ctx.db
                        .query("account_snapshots")
                        .withIndex("by_app_account", (q) => q.eq("app", account.app).eq("accountId", account.accountId))
                        .collect()
                )
            ),
            Promise.all(
                accounts.map((account) =>
                    ctx.db
                        .query("account_pnl_events")
                        .withIndex("by_app_account", (q) => q.eq("app", account.app).eq("accountId", account.accountId))
                        .collect()
                )
            ),
            Promise.all(
                accounts.map(async (account) =>
                    (
                        await Promise.all([
                            ctx.db
                                .query("execution_safety_faults")
                                .withIndex("by_app_account_blocked", (q) =>
                                    q.eq("app", account.app).eq("accountId", account.accountId).eq("blocked", true)
                                )
                                .collect(),
                            ctx.db
                                .query("execution_safety_faults")
                                .withIndex("by_app_account_blocked", (q) =>
                                    q.eq("app", account.app).eq("accountId", account.accountId).eq("blocked", false)
                                )
                                .collect(),
                        ])
                    ).flat()
                )
            ),
            Promise.all(
                strategies.map(async (strategy) => {
                    const positions = await getLatestPositionsForStrategy(ctx, strategy._id)
                    return positions
                        .filter((position) => !isDryRunLedgerMetadata(position.metadata))
                        .map((position) => ({ ...position, strategy }))
                })
            ),
        ])

        const latestRunByStrategy = new Map<string, typeof runs[number]>()
        for (const run of runs) {
            const strategyId = String(run.strategyId)
            if (!latestRunByStrategy.has(strategyId)) {
                latestRunByStrategy.set(strategyId, run)
            }
        }

        const strategiesByAccount = new Map<string, typeof strategies>()
        for (const strategy of strategies) {
            const key = createAccountKey(strategy.app, strategy.accountId)
            const existing = strategiesByAccount.get(key) ?? []
            existing.push(strategy)
            strategiesByAccount.set(key, existing)
        }

        const latestRunByAccount = new Map<string, typeof runs>()
        for (const run of runs) {
            if (!run.accountId) {
                continue
            }
            const key = createAccountKey(run.app, run.accountId)
            const existing = latestRunByAccount.get(key) ?? []
            existing.push(run)
            latestRunByAccount.set(key, existing)
        }

        const strategyById = new Map(strategies.map((strategy) => [String(strategy._id), strategy]))
        const accountRows = accounts
            .map((account, index) => {
                const key = createAccountKey(account.app, account.accountId)
                const accountStrategies = strategiesByAccount.get(key) ?? []
                const latestSnapshot = (accountSnapshotsByAccount[index] ?? [])
                    .sort((left, right) => right.timestamp - left.timestamp)[0] ?? null
                const pnlEvents = accountPnlEventsByAccount[index] ?? []
                const recentAccountRuns = (latestRunByAccount.get(key) ?? []).slice(0, 10)
                const accountSyncState = syncStates.find((state) =>
                    state.app === account.app && state.accountId === account.accountId
                ) ?? null
                const accountRiskStates = riskStates.filter((state) =>
                    accountStrategies.some((strategy) => String(strategy._id) === String(state.strategyId))
                )
                const unresolvedFaults = (unresolvedFaultsByAccount[index] ?? []).filter((fault) =>
                    fault.resolvedAt === undefined
                )

                return {
                    ...account,
                    latestSnapshot,
                    syncState: accountSyncState,
                    strategyCount: accountStrategies.length,
                    enabledStrategyCount: accountStrategies.filter((strategy) => strategy.enabled).length,
                    blockedStrategyCount: accountRiskStates.filter((state) => state.safetyState === "blocked").length,
                    unresolvedFaultCount: unresolvedFaults.length,
                    unresolvedBlockingFaultCount: unresolvedFaults.filter((fault) => fault.blocked).length,
                    latestRun: recentAccountRuns[0] ?? null,
                    recentRunCount: recentAccountRuns.length,
                    latestPnlEvent: pnlEvents.sort((left, right) => right.occurredAt - left.occurredAt)[0] ?? null,
                }
            })
            .sort((left, right) =>
                left.app.localeCompare(right.app) ||
                left.accountId.localeCompare(right.accountId)
            )

        const modelComparison = strategies
            .map((strategy) => {
                const latestRun = latestRunByStrategy.get(String(strategy._id)) ?? null
                const snapshot = accountRows.find((account) =>
                    account.app === strategy.app && account.accountId === strategy.accountId
                )?.latestSnapshot ?? null
                return {
                    strategyId: strategy._id,
                    strategyName: strategy.name,
                    app: strategy.app,
                    accountId: strategy.accountId,
                    model: readStrategyModel(strategy.policy),
                    enabled: strategy.enabled,
                    latestRun,
                    equity: snapshot ? resolveSnapshotEquity(snapshot) : null,
                    openPnl: snapshot?.openPnl ?? null,
                    dayPnl: snapshot?.dayPnl ?? null,
                    opportunityRealizedPnl: latestRun?.opportunityRealizedPnl ?? null,
                }
            })
            .sort((left, right) =>
                left.model.localeCompare(right.model) ||
                left.app.localeCompare(right.app) ||
                left.accountId.localeCompare(right.accountId)
            )

        const moneyAuditAlerts = alerts.filter((alert) =>
            alert.message.includes("money reconciliation mismatch") ||
            alert.message.includes("account money reconciliation mismatch")
        )

        const unresolvedFaults = unresolvedFaultsByAccount
            .flat()
            .filter((fault) => fault.resolvedAt === undefined)
            .sort((left, right) => right.occurredAt - left.occurredAt)
            .slice(0, 20)
            .map((fault) => ({
                ...fault,
                strategyName: strategyById.get(String(fault.strategyId))?.name ?? "Unknown strategy",
            }))

        return {
            systemState: systemState ?? createDefaultKillSwitchState(),
            appHealth,
            accounts: accountRows,
            accountSnapshots: accountRows.map((account) => account.latestSnapshot).filter(isNonNullable),
            modelComparison,
            moneyAuditAlerts,
            unresolvedFaults,
            activeRuns: runs.filter((run) => run.status === "running"),
            recentRuns: runs.slice(0, 10),
            recentAlerts: alerts,
            openPositions: openPositionsByStrategy.flat(),
            strategies: strategies.map((strategy) => ({
                ...strategy,
                latestRun: latestRunByStrategy.get(String(strategy._id)) ?? null,
            })),
        }
    },
})

function createAccountKey(app: string, accountId: string): string {
    return `${app}:${accountId}`
}

function readStrategyModel(policy: unknown): string {
    if (!policy || typeof policy !== "object") {
        return "unconfigured"
    }

    const record = policy as Record<string, unknown>
    const llm = record.llm && typeof record.llm === "object"
        ? record.llm as Record<string, unknown>
        : undefined
    const model = typeof llm?.model === "string"
        ? llm.model
        : typeof record.model === "string"
            ? record.model
            : undefined

    return model && model.trim().length > 0 ? model : "unconfigured"
}
