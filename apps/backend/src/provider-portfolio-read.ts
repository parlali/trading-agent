import type { AccountState, Position, ProviderPositionClosure, VenueAdapter, WorkingOrder } from "@valiq-trading/core"
import type { VenueApp } from "./types"

export interface ProviderPortfolioSnapshot {
    accountState: AccountState
    positions: Position[]
    workingOrders: WorkingOrder[]
    positionClosures: ProviderPositionClosure[]
}

export async function readProviderPortfolioForSync(
    app: VenueApp,
    venue: VenueAdapter
): Promise<ProviderPortfolioSnapshot> {
    return app === "mt5"
        ? await readProviderPortfolioSequentially(venue)
        : await readProviderPortfolioConcurrently(venue)
}

async function readProviderPortfolioSequentially(venue: VenueAdapter): Promise<ProviderPortfolioSnapshot> {
    const accountState = await venue.getAccountState()
    const positions = await venue.getPositions()
    const workingOrders = venue.getWorkingOrders ? await venue.getWorkingOrders() : []
    const positionClosures = venue.getRecentPositionClosures ? await venue.getRecentPositionClosures() : []

    return {
        accountState,
        positions,
        workingOrders,
        positionClosures,
    }
}

async function readProviderPortfolioConcurrently(venue: VenueAdapter): Promise<ProviderPortfolioSnapshot> {
    const [accountState, positions, workingOrders] = await Promise.all([
        venue.getAccountState(),
        venue.getPositions(),
        venue.getWorkingOrders ? venue.getWorkingOrders() : Promise.resolve([]),
    ])
    const positionClosures = venue.getRecentPositionClosures
        ? await venue.getRecentPositionClosures()
        : []

    return {
        accountState,
        positions,
        workingOrders,
        positionClosures,
    }
}
