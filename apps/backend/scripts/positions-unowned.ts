import type { StoredStrategy, TradingBackendClient } from "@valiq-trading/convex"
import {
    resolveProviderAdoptionInstruments,
    type ProviderAdoptionRow,
} from "@valiq-trading/core"
import {
    createClient,
    requireArg,
    resolveArg,
    runScript,
} from "./lib/strategy-cli"
import {
    flattenVenueExposure,
    refreshProviderPortfolioState,
    runWithResetExecutionContext,
} from "./lib/safe-strategy-reset"

type OperatorAction = "list" | "close" | "adopt"
type VenueApp = StoredStrategy["app"]

runScript(async () => {
    const client = createClient()
    const app = requireVenueApp(resolveArg("app"))
    const action = resolveAction(resolveArg("action"))
    const representativeStrategy = await getRepresentativeStrategy(client, app)

    if (representativeStrategy) {
        await refreshProviderPortfolioState(client, representativeStrategy)
    }

    switch (action) {
        case "list":
            await listUnownedExposure(client, app)
            return
        case "close":
            await closeUnownedExposure(client, app, representativeStrategy)
            return
        case "adopt":
            await adoptUnownedExposure(client, app)
            return
    }
})

async function listUnownedExposure(
    client: TradingBackendClient,
    app: VenueApp
): Promise<void> {
    const exposure = filterNonOwnedExposure(await getProviderExposure(client, app))

    if (exposure.positions.length === 0 && exposure.orders.length === 0) {
        console.log(`No unowned or orphaned provider exposure found for ${app}`)
        return
    }

    console.log(`${app} unowned provider exposure:`)

    if (exposure.positions.length > 0) {
        console.log("  Positions:")
        for (const position of exposure.positions) {
            console.log(
                `    ${position.instrument} qty=${position.quantity} side=${position.side} ownership=${position.ownershipStatus}`
            )
        }
    }

    if (exposure.orders.length > 0) {
        console.log("  Working orders:")
        for (const order of exposure.orders) {
            console.log(
                `    ${order.orderId} instrument=${order.instrument} status=${order.status} ownership=${order.ownershipStatus}`
            )
        }
    }
}

async function closeUnownedExposure(
    client: TradingBackendClient,
    app: VenueApp,
    representativeStrategy: StoredStrategy | null
): Promise<void> {
    if (!representativeStrategy) {
        throw new Error(`Cannot close ${app} exposure without at least one strategy to supply venue credentials`)
    }

    const exposure = filterNonOwnedExposure(await getProviderExposure(client, app))
    if (exposure.positions.length === 0 && exposure.orders.length === 0) {
        console.log(`No unowned or orphaned provider exposure found for ${app}`)
        return
    }

    const result = await runWithResetExecutionContext(
        client,
        representativeStrategy,
        "unowned exposure flatten",
        async ({ pipeline }) => await flattenVenueExposure(pipeline, {
            positions: exposure.positions,
            workingOrders: exposure.orders,
        })
    )

    console.log(`Closed ${result.closedPositions} position(s) and cancelled ${result.cancelledOrders} order(s) for ${app}`)

    for (const failure of result.positionFailures) {
        console.log(`  ${failure}`)
    }

    for (const failure of result.orderFailures) {
        console.log(`  ${failure}`)
    }

    await refreshProviderPortfolioState(client, representativeStrategy)

    const remaining = filterNonOwnedExposure(await getProviderExposure(client, app))
    if (remaining.positions.length > 0 || remaining.orders.length > 0) {
        throw new Error(
            `Unowned provider exposure still remains for ${app}. Positions=${remaining.positions.length}, orders=${remaining.orders.length}`
        )
    }

    console.log(`No unowned provider exposure remains for ${app}`)
}

async function adoptUnownedExposure(
    client: TradingBackendClient,
    app: VenueApp
): Promise<void> {
    const providerExposure = await getProviderExposure(client, app)
    const exposure = filterNonOwnedExposure(providerExposure)
    if (exposure.positions.length === 0 && exposure.orders.length === 0) {
        console.log(`No unowned or orphaned provider exposure found for ${app}`)
        return
    }

    const strategy = await resolveTargetStrategy(client, app)
    const instruments = resolveProviderAdoptionInstruments({
        targetStrategyId: strategy._id,
        requestedInstruments: resolveRequestedInstruments(),
        rows: buildAdoptionRows(providerExposure),
    })
    const result = await client.adoptProviderPositions(app, strategy._id, instruments)

    console.log(
        `Adopted ${result.adoptedPositions} provider position row(s) and ${result.adoptedOrders} working order row(s) into ${strategy.name}`
    )

    await listUnownedExposure(client, app)
}

async function getRepresentativeStrategy(
    client: TradingBackendClient,
    app: VenueApp
): Promise<StoredStrategy | null> {
    const strategies = (await client.getAllStrategies())
        .filter((strategy) => strategy.app === app)
        .sort((left, right) => left.name.localeCompare(right.name))

    return strategies[0] ?? null
}

async function getProviderExposure(
    client: TradingBackendClient,
    app: VenueApp
): Promise<{
    positions: Awaited<ReturnType<TradingBackendClient["getPortfolioPositions"]>>
    orders: Awaited<ReturnType<TradingBackendClient["getPortfolioPendingOrders"]>>
}> {
    const [positions, orders] = await Promise.all([
        client.getPortfolioPositions(app),
        client.getPortfolioPendingOrders(app),
    ])

    return { positions, orders }
}

function filterNonOwnedExposure(exposure: {
    positions: Awaited<ReturnType<TradingBackendClient["getPortfolioPositions"]>>
    orders: Awaited<ReturnType<TradingBackendClient["getPortfolioPendingOrders"]>>
}): {
    positions: Awaited<ReturnType<TradingBackendClient["getPortfolioPositions"]>>
    orders: Awaited<ReturnType<TradingBackendClient["getPortfolioPendingOrders"]>>
} {
    return {
        positions: exposure.positions.filter((position) => position.ownershipStatus !== "owned"),
        orders: exposure.orders.filter((order) => order.ownershipStatus !== "owned"),
    }
}

function buildAdoptionRows(exposure: {
    positions: Awaited<ReturnType<TradingBackendClient["getPortfolioPositions"]>>
    orders: Awaited<ReturnType<TradingBackendClient["getPortfolioPendingOrders"]>>
}): ProviderAdoptionRow[] {
    return [
        ...exposure.positions.map((position) => ({
            instrument: position.instrument,
            ownershipStatus: position.ownershipStatus,
            strategyId: position.strategyId,
        })),
        ...exposure.orders.map((order) => ({
            instrument: order.instrument,
            ownershipStatus: order.ownershipStatus,
            strategyId: order.strategyId,
        })),
    ]
}

async function resolveTargetStrategy(
    client: TradingBackendClient,
    app: VenueApp
): Promise<StoredStrategy> {
    const allStrategies = await client.getAllStrategies()
    const strategies = allStrategies.filter((strategy) => strategy.app === app)

    if (strategies.length === 0) {
        throw new Error(`No ${app} strategy exists to adopt provider exposure`)
    }

    const strategyIdArg = resolveArg("strategyId")
    if (strategyIdArg) {
        const strategy = strategies.find((candidate) => candidate._id === strategyIdArg)
        if (!strategy) {
            throw new Error(`Strategy not found for ${app}: ${strategyIdArg}`)
        }
        return strategy
    }

    const strategyName = requireArg("strategy")
    const strategy = strategies.find(
        (candidate) => candidate.name.toLowerCase() === strategyName.toLowerCase()
    )

    if (!strategy) {
        const available = strategies.map((candidate) => `  - ${candidate.name}`).join("\n")
        throw new Error(
            `Strategy "${strategyName}" not found for ${app}.\nAvailable:\n${available}`
        )
    }

    return strategy
}

function resolveRequestedInstruments(): string[] | undefined {
    const instrumentsArg = resolveArg("instruments")
    if (!instrumentsArg) {
        return undefined
    }

    const requested = Array.from(
        new Set(
            instrumentsArg
                .split(",")
                .map((instrument) => instrument.trim())
                .filter((instrument) => instrument.length > 0)
        )
    )

    if (requested.length === 0) {
        throw new Error("--instruments must contain at least one instrument when provided")
    }

    return requested
}

function requireVenueApp(value: string | undefined): VenueApp {
    if (
        value === "alpaca-options" ||
        value === "polymarket" ||
        value === "mt5" ||
        value === "okx-swap"
    ) {
        return value
    }

    throw new Error("--app must be one of alpaca-options, polymarket, mt5, or okx-swap")
}

function resolveAction(value: string | undefined): OperatorAction {
    if (value === undefined || value === "list") {
        return "list"
    }

    if (value === "close" || value === "adopt") {
        return value
    }

    throw new Error("--action must be one of list, close, or adopt")
}
