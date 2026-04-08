import { resolve } from "node:path"
import {
    createTradingBackendClient,
    type TradingBackendClient,
    type DeleteAllStrategiesResult,
} from "@valiq-trading/convex"
import { parseStrategyMarkdownDocument } from "@valiq-trading/core"
import type { StrategyConfig } from "@valiq-trading/core"

export function resolveArg(name: string): string | undefined {
    const prefix = `--${name}=`
    const entry = Bun.argv.find((value) => value.startsWith(prefix))

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

export function resolveDocumentPath(): string {
    const explicitPath = resolveArg("file")

    if (explicitPath) {
        return resolve(process.cwd(), explicitPath)
    }

    return resolve(import.meta.dir, "../../../../strategies.md")
}

export async function loadStrategiesFromDocument(): Promise<StrategyConfig[]> {
    const documentPath = resolveDocumentPath()
    const file = Bun.file(documentPath)

    if (!(await file.exists())) {
        throw new Error(`Strategy document not found: ${documentPath}`)
    }

    const markdown = await file.text()
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
    console.log(`  manual run requests: ${deleted.manualRunRequests}`)
    console.log(`  alerts: ${deleted.alerts}`)
}

export function runScript(main: () => Promise<void>): void {
    void main().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(message)
        process.exit(1)
    })
}
