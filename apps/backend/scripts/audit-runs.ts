import { createTradingBackendClient } from "@valiq-trading/convex"
import { resolveStrategyLlmConfig } from "@valiq-trading/core"

const CONVEX_URL = process.env.CONVEX_URL!
const SERVICE_TOKEN = process.env.BACKEND_SERVICE_TOKEN!

const client = createTradingBackendClient({
    url: CONVEX_URL,
    machineAuth: { serviceToken: SERVICE_TOKEN },
})

async function main() {
    const strategies = await client.getAllStrategies()

    // For each strategy, get the latest positions
    console.log("=== STRATEGY POSITIONS (including dry-run) ===")
    for (const s of strategies) {
        try {
            const positions = await client.getLatestPositions(s._id)
            if (positions.length > 0) {
                console.log(`\n  ${s.name}:`)
                for (const p of positions) {
                    const meta = p.metadata as any
                    console.log(`    ${p.instrument} | side=${p.side} | qty=${p.quantity} | entry=${p.entryPrice} | current=${p.currentPrice ?? 'N/A'} | pnl=${p.unrealizedPnl ?? 'N/A'} | dryRun=${meta?.dryRun ?? false}`)
                    if (meta?.question) console.log(`      Market: ${meta.question}`)
                    if (meta?.marketSlug) console.log(`      Slug: ${meta.marketSlug}`)
                }
            }
        } catch (e: any) {
            // Skip
        }
    }

    // Get owned instruments for each app
    console.log("\n=== OWNED INSTRUMENTS ===")
    for (const app of ["alpaca-options", "polymarket", "mt5"] as const) {
        const owned = await client.getAllOwnedInstrumentsByApp(app)
        console.log(`  ${app}: ${owned.length} instruments`)
        for (const o of owned) {
            const strat = strategies.find(s => String(s._id) === o.strategyId)
            console.log(`    ${o.instrument} -> ${strat?.name ?? 'unknown'}`)
        }
    }

    // Get the run count - each strategy's last completed run summary
    console.log("\n=== ALL STRATEGY SUMMARIES AND STATS ===")
    for (const s of strategies) {
        try {
            const policy = s.policy as Record<string, unknown>
            const llm = resolveStrategyLlmConfig(policy)
            const lastRun = await client.getLastCompletedRunSummary(s._id)
            const activeRun = await client.getActiveRun(s._id)
            console.log(`\n--- ${s.name} (${llm.provider}:${llm.model}) ---`)
            console.log(`  App: ${s.app} | DryRun: ${policy.dryRun ?? false} | Schedule: ${s.schedule}`)
            if (activeRun) {
                console.log(`  ACTIVE RUN: since ${new Date(activeRun.startedAt).toISOString()} trigger=${activeRun.trigger}`)
            }
            if (lastRun) {
                console.log(`  Last completed: ${new Date(lastRun.endedAt!).toISOString()}`)
                console.log(`  Summary: ${lastRun.summary}`)
            } else {
                console.log(`  No completed runs`)
            }
        } catch (e: any) {
            console.log(`  Error: ${e.message?.substring(0, 100)}`)
        }
    }

    process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
