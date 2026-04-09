import type { OrderAction, OrderStatus } from "@valiq-trading/core";
import type { Id, Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
type QueryDbCtx = {
    db: QueryCtx["db"];
};
type MutationDbCtx = {
    db: MutationCtx["db"];
};
type VenueApp = Doc<"strategies">["app"];
export declare function getLatestPositionsForStrategy(ctx: QueryDbCtx, strategyId: Id<"strategies">): Promise<Array<Doc<"positions">>>;
export declare function getClaimedInstrumentsForStrategy(ctx: QueryDbCtx, strategyId: Id<"strategies">): Promise<string[]>;
export declare function getOwnedInstrumentsForStrategy(ctx: QueryDbCtx, strategyId: Id<"strategies">): Promise<string[]>;
export declare function getOwnedInstrumentsByApp(ctx: QueryDbCtx, app: VenueApp): Promise<Array<{
    instrument: string;
    strategyId: Id<"strategies">;
}>>;
export declare function replacePositionClaims(ctx: MutationDbCtx, args: {
    strategyId: Id<"strategies">;
    app: VenueApp;
    instruments: string[];
    updatedAt: number;
}): Promise<void>;
export declare function reconcileOrderInstrumentClaim(ctx: MutationDbCtx, args: {
    strategyId: Id<"strategies">;
    app: VenueApp;
    orderId: string;
    instrument: string;
    action: OrderAction;
    status: OrderStatus;
    updatedAt: number;
}): Promise<void>;
export {};
//# sourceMappingURL=instrumentClaims.d.ts.map