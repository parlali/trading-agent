import { resolve } from "node:path"
import {
    createTradingBackendClient,
    type ReplaceAllStrategiesResult,
} from "@valiq-trading/convex"
import { parseStrategyMarkdownDocument } from "@valiq-trading/core"

function resolveArg(name: string): string | undefined {
    const prefix = `--${name}=`
    const entry = Bun.argv.find((value) => value.startsWith(prefix))

    if (!entry) {
        return undefined
    }

    return entry.slice(prefix.length).trim() || undefined
}

function resolveDocumentPath(): string {
    const explicitPath = resolveArg("file")

    if (explicitPath) {
        return resolve(process.cwd(), explicitPath)
    }

    return resolve(import.meta.dir, "../../../strategies.md")
}

function requireEnv(name: string): string {
    const value = process.env[name]?.trim()

    if (!value) {
        throw new Error(`${name} is required`)
    }

    return value
}

function printSummary(result: ReplaceAllStrategiesResult): void {
    console.log(`Imported ${result.importedStrategies} strategies`)
    console.log(`Deleted ${result.deleted.strategies} previous strategies`)
    console.log(`Deleted ${result.deleted.runs} runs`)
    console.log(`Deleted ${result.deleted.agentLogs} agent logs`)
    console.log(`Deleted ${result.deleted.tradeEvents} trade events`)
    console.log(`Deleted ${result.deleted.orders} orders`)
    console.log(`Deleted ${result.deleted.orderTransitions} order transitions`)
    console.log(`Deleted ${result.deleted.positions} positions`)
    console.log(`Deleted ${result.deleted.instrumentClaims} instrument claims`)
    console.log(`Deleted ${result.deleted.positionSyncs} position syncs`)
    console.log(`Deleted ${result.deleted.manualRunRequests} manual run requests`)
    console.log(`Deleted ${result.deleted.alerts} strategy-linked alerts`)
}

async function main(): Promise<void> {
    const documentPath = resolveDocumentPath()
    const file = Bun.file(documentPath)

    if (!(await file.exists())) {
        throw new Error(`Strategy document not found: ${documentPath}`)
    }

    const markdown = await file.text()
    const document = parseStrategyMarkdownDocument(markdown)

    console.log(`Parsed ${document.strategies.length} strategies from ${documentPath}`)

    const client = createTradingBackendClient({
        url: requireEnv("CONVEX_URL"),
        machineAuth: {
            serviceToken: requireEnv("BACKEND_SERVICE_TOKEN"),
        },
    })

    const result = await client.replaceAllStrategies(document.strategies)

    printSummary(result)
}

void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
})
