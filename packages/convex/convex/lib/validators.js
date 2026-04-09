import { v } from "convex/values";
import { VENUE_APPS, APPS, SEVERITY_LEVELS, EVENT_TYPES, PORTFOLIO_PROVIDER_STATUSES, PROVIDER_OWNERSHIP_STATUSES, } from "@valiq-trading/core";
import { ORDER_STATUSES, ORDER_ACTIONS, ORDER_TRANSITION_TYPES, } from "@valiq-trading/core";
function stringLiterals(values) {
    const validators = values.map((s) => v.literal(s));
    return v.union(...validators);
}
export const venueAppV = stringLiterals(VENUE_APPS);
export const appV = stringLiterals(APPS);
export const orderStatusV = stringLiterals(ORDER_STATUSES);
export const orderActionV = stringLiterals(ORDER_ACTIONS);
export const orderTransitionTypeV = stringLiterals(ORDER_TRANSITION_TYPES);
export const severityV = stringLiterals(SEVERITY_LEVELS);
export const eventTypeV = stringLiterals(EVENT_TYPES);
export const claimSourceV = v.union(v.literal("position"), v.literal("order"));
export const portfolioProviderStatusV = stringLiterals(PORTFOLIO_PROVIDER_STATUSES);
export const providerOwnershipStatusV = stringLiterals(PROVIDER_OWNERSHIP_STATUSES);
