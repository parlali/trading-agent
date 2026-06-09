import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type {
    Id,
    StoredRun,
    StoredStrategy,
    TradingBackendClient,
} from "@valiq-trading/convex"
import { buildCodexRunAuditArtifact } from "./codex-run-audit"
import {
    isDryRunStrategy,
    refreshProviderPortfolioState,
} from "./safe-strategy-reset"
import { resolveArg } from "./strategy-cli"

const codexAuditCliDir = dirname(fileURLToPath(import.meta.url))
const DEFAULT_AUDIT_RUN_HISTORY_PAGE_SIZE = 100
const MAX_AUDIT_RUN_HISTORY_PAGE_SIZE = 500
const MAX_AUDIT_RUN_HISTORY_PAGES = 50

export async function collectCodexRunAuditArtifact(args: {
    client: TradingBackendClient
    strategy: StoredStrategy
    run: StoredRun
    exportedAt: string
}): Promise<ReturnType<typeof buildCodexRunAuditArtifact>> {
    const [
        agentLogs,
        tradeEvents,
        positions,
        portfolioFreshness,
    ] = await Promise.all([
        args.client.getAgentLogs(args.run._id),
        args.client.getTradeEvents(args.run._id),
        args.client.getPositionsForRun(args.strategy._id, args.run._id),
        args.client.getPortfolioFreshness(args.strategy.app),
    ])

    return buildCodexRunAuditArtifact({
        exportedAt: args.exportedAt,
        strategy: args.strategy,
        run: args.run,
        agentLogs,
        tradeEvents,
        positions,
        portfolioFreshness,
    })
}

export async function resolveCodexStrategyAndRun(client: TradingBackendClient): Promise<{
    strategy: StoredStrategy
    run: StoredRun
}> {
    const runId = resolveArg("run-id")
    const strategyId = resolveArg("strategy")
    const strategyName = resolveArg("strategy-name")

    if (runId) {
        const run = await client.getRunById(runId as Id<"strategy_runs">)
        if (!run) {
            throw new Error(`Run not found: ${runId}`)
        }
        const strategy = await client.getStrategyById(run.strategyId)
        if (!strategy) {
            throw new Error(`Strategy not found for run ${runId}: ${run.strategyId}`)
        }
        assertStrategySelectionMatches(strategy, {
            runId,
            strategyId,
            strategyName,
        })
        return { strategy, run }
    }

    const strategy = await resolveStrategySelection(client, {
        strategyId,
        strategyName,
    })
    const run = await resolveLatestCompletedCodexRun(client, strategy)

    return { strategy, run }
}

export async function resolveStrategySelection(
    client: TradingBackendClient,
    args: {
        strategyId?: string
        strategyName?: string
    } = {}
): Promise<StoredStrategy> {
    if (args.strategyId) {
        const strategy = await client.getStrategyById(args.strategyId as Id<"strategies">)
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`)
        }
        return strategy
    }

    if (args.strategyName) {
        const strategies = await client.getAllStrategies()
        const matches = strategies.filter((candidate) =>
            candidate.name.toLowerCase() === args.strategyName?.toLowerCase()
        )
        if (matches.length > 1) {
            throw new Error(`Strategy name is ambiguous: ${args.strategyName} matched ${matches.map((strategy) => `${strategy.name} (${strategy._id})`).join(", ")}`)
        }
        const [strategy] = matches
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyName}`)
        }
        return strategy
    }

    throw new Error("--run-id, --strategy, or --strategy-name is required")
}

export async function resolveLatestCompletedCodexRun(
    client: TradingBackendClient,
    strategy: StoredStrategy
): Promise<StoredRun> {
    const [run] = await findStrategyRunHistoryMatches({
        client,
        strategyId: strategy._id,
        minMatches: 1,
        matches: (candidate) =>
            candidate.status === "completed" &&
            candidate.llmProvider === "codex",
    })

    if (!run) {
        throw new Error(`No completed Codex run found for strategy ${strategy.name} (${strategy._id})`)
    }

    return run
}

export async function findStrategyRunHistoryMatches(args: {
    client: TradingBackendClient
    strategyId: Id<"strategies">
    minMatches: number
    initialLimit?: number
    matches: (run: StoredRun) => boolean
    stopAfterPage?: (runs: StoredRun[]) => boolean
    pageLimitError?: string
}): Promise<StoredRun[]> {
    let beforeStartedAt: number | undefined
    const pageSize = Math.min(
        MAX_AUDIT_RUN_HISTORY_PAGE_SIZE,
        Math.max(DEFAULT_AUDIT_RUN_HISTORY_PAGE_SIZE, args.initialLimit ?? DEFAULT_AUDIT_RUN_HISTORY_PAGE_SIZE)
    )
    const matches: StoredRun[] = []

    for (let page = 0; page < MAX_AUDIT_RUN_HISTORY_PAGES; page++) {
        const runs = await args.client.getRunHistory(args.strategyId, pageSize, beforeStartedAt)
        for (const run of runs) {
            if (args.matches(run)) {
                matches.push(run)
                if (matches.length >= args.minMatches) {
                    return matches
                }
            }
        }

        if (runs.length < pageSize) {
            return matches
        }
        if (args.stopAfterPage?.(runs)) {
            return matches
        }

        const lastRun = runs[runs.length - 1]
        if (!lastRun) {
            return matches
        }
        beforeStartedAt = lastRun.startedAt
    }

    if (args.pageLimitError) {
        throw new Error(args.pageLimitError)
    }

    return matches
}

export function resolveAuditOutputPath(args: {
    outputArg?: string
    defaultFileName: string
}): string {
    if (args.outputArg) {
        return resolve(args.outputArg)
    }

    return resolve(codexAuditCliDir, "../../../../private/audits", args.defaultFileName)
}

export async function refreshProviderSyncForAudit(args: {
    client: TradingBackendClient
    targetStrategy: StoredStrategy
    providerSyncStrategyId?: string
}): Promise<StoredStrategy> {
    const allStrategies = await args.client.getAllStrategies()
    const refreshStrategy = resolveProviderSyncRefreshStrategy({
        targetStrategy: args.targetStrategy,
        allStrategies,
        providerSyncStrategyId: args.providerSyncStrategyId,
    })

    await refreshProviderPortfolioState(args.client, refreshStrategy)

    return refreshStrategy
}

export function resolveProviderSyncRefreshStrategy(args: {
    targetStrategy: StoredStrategy
    allStrategies: StoredStrategy[]
    providerSyncStrategyId?: string
}): StoredStrategy {
    if (args.providerSyncStrategyId) {
        const strategy = args.allStrategies.find((candidate) =>
            String(candidate._id) === args.providerSyncStrategyId
        )
        if (!strategy) {
            throw new Error(`Provider-sync strategy not found: ${args.providerSyncStrategyId}`)
        }
        assertProviderSyncRefreshStrategy(args.targetStrategy, strategy)
        return strategy
    }

    const candidates = args.allStrategies
        .filter((candidate) =>
            candidate.app === args.targetStrategy.app &&
            !isDryRunStrategy(candidate)
        )
        .sort(compareStrategiesByName)

    if (candidates.length === 0) {
        throw new Error(`No live ${args.targetStrategy.app} strategy is available to refresh provider-sync evidence; pass --provider-sync-strategy <id> after adding a live strategy for the same venue`)
    }
    if (candidates.length > 1) {
        throw new Error(`Multiple live ${args.targetStrategy.app} strategies can refresh provider-sync evidence; pass --provider-sync-strategy <id>. Candidates: ${candidates.map((strategy) => `${strategy.name} (${strategy._id})`).join(", ")}`)
    }

    return candidates[0]!
}

function assertStrategySelectionMatches(
    strategy: StoredStrategy,
    args: {
        runId: string
        strategyId?: string
        strategyName?: string
    }
): void {
    if (args.strategyId && String(strategy._id) !== args.strategyId) {
        throw new Error(`Run ${args.runId} belongs to strategy ${strategy._id}, not ${args.strategyId}`)
    }
    if (args.strategyName && strategy.name.toLowerCase() !== args.strategyName.toLowerCase()) {
        throw new Error(`Run ${args.runId} belongs to strategy ${strategy.name}, not ${args.strategyName}`)
    }
}

function assertProviderSyncRefreshStrategy(
    targetStrategy: StoredStrategy,
    refreshStrategy: StoredStrategy
): void {
    if (refreshStrategy.app !== targetStrategy.app) {
        throw new Error(`Provider-sync strategy ${refreshStrategy.name} (${refreshStrategy._id}) is for ${refreshStrategy.app}, not target app ${targetStrategy.app}`)
    }
    if (isDryRunStrategy(refreshStrategy)) {
        throw new Error(`Provider-sync strategy ${refreshStrategy.name} (${refreshStrategy._id}) is dry-run; a live same-venue strategy is required to refresh provider truth`)
    }
}

function compareStrategiesByName(left: StoredStrategy, right: StoredStrategy): number {
    return left.name.localeCompare(right.name)
}
