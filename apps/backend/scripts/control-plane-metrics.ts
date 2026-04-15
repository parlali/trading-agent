import { createTradingBackendClient } from "@valiq-trading/convex"

declare const Bun: {
    env: Record<string, string | undefined>
}

const convexUrl = Bun.env.CONVEX_URL
const backendServiceToken = Bun.env.BACKEND_SERVICE_TOKEN

if (!convexUrl || !backendServiceToken) {
    throw new Error("CONVEX_URL and BACKEND_SERVICE_TOKEN are required")
}

const backend = createTradingBackendClient({
    url: convexUrl,
    machineAuth: {
        serviceToken: backendServiceToken,
    },
})

async function main(): Promise<void> {
    const metrics = await backend.getControlPlaneMetrics()
    const sorted = [...metrics].sort((left, right) => left.metric.localeCompare(right.metric))

    console.log(`Control-plane metrics: ${sorted.length}`)
    for (const metric of sorted) {
        console.log(`${metric.metric} app=${metric.app ?? "all"} value=${metric.value} updatedAt=${new Date(metric.updatedAt).toISOString()}`)
    }
}

await main()
