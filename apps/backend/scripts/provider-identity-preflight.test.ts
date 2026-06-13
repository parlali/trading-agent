import { describe, expect, it } from "vitest"
import type { OrderSnapshot, PortfolioPendingOrder, PortfolioPosition } from "@valiq-trading/core"
import type { ExecutionSafetyFaultRow, StoredStrategy } from "@valiq-trading/convex"
import { providerIdentityPreflightTestables } from "./provider-identity-preflight"

describe("provider identity preflight", () => {
    it("selects enabled live strategies for provider refresh", () => {
        const selected = providerIdentityPreflightTestables.selectProviderRefreshStrategies([
            { app: "alpaca-options", accountId: "test-account" },
            { app: "mt5", accountId: "test-account" },
        ], [
            createStrategy({
                _id: "dry-run" as never,
                app: "alpaca-options",
                name: "Dry run",
                enabled: true,
                policy: { dryRun: true },
            }),
            createStrategy({
                _id: "disabled-live" as never,
                app: "alpaca-options",
                name: "A disabled live",
                enabled: false,
                policy: {},
            }),
            createStrategy({
                _id: "enabled-live" as never,
                app: "alpaca-options",
                name: "B enabled live",
                enabled: true,
                policy: {},
            }),
        ])

        expect(selected.get("alpaca-options\u0000test-account")?._id).toBe("enabled-live")
        expect(selected.has("mt5\u0000test-account")).toBe(false)
    })

    it("rejects owned provider-live orders without canonical identity proof", () => {
        const failures: string[] = []

        providerIdentityPreflightTestables.inspectProviderOrder(createProviderOrder({
            orderId: "provider-order-1",
            canonicalOrderId: undefined,
            providerOrderId: "provider-order-1",
            providerClientOrderId: "vokc01abcde23456",
        }), failures)

        expect(failures).toEqual([
            "okx-swap: owned provider order provider-order-1 for BTC-USDT-SWAP has no real canonical order id (canonical=<missing> provider=provider-order-1 client=vokc01abcde23456 aliases=<none> strategy=<missing> status=pending remaining=1 metadata.comment=<missing> operator_action=cancel_adopt_or_manual_reconcile)",
        ])
    })

    it("rejects owned provider-live orders without provider client and provider order identity", () => {
        const failures: string[] = []

        providerIdentityPreflightTestables.inspectProviderOrder(createProviderOrder({
            orderId: "vokc01abcde23456",
            canonicalOrderId: "vokc01abcde23456",
            providerOrderId: undefined,
            providerClientOrderId: undefined,
            providerOrderAliases: [],
        }), failures)

        expect(failures).toEqual([
            "okx-swap: owned provider order vokc01abcde23456 has no provider client identity (canonical=vokc01abcde23456 provider=<missing> client=<missing> aliases=<none> strategy=<missing> status=pending remaining=1 metadata.comment=<missing> operator_action=cancel_adopt_or_manual_reconcile)",
            "okx-swap: owned provider order vokc01abcde23456 has no provider order identity (canonical=vokc01abcde23456 provider=<missing> client=<missing> aliases=<none> strategy=<missing> status=pending remaining=1 metadata.comment=<missing> operator_action=cancel_adopt_or_manual_reconcile)",
        ])
    })

    it("reports row-level evidence for unowned provider positions", () => {
        const failures: string[] = []

        providerIdentityPreflightTestables.inspectProviderPosition({
            app: "alpaca-options",
            ownershipStatus: "unowned",
            expectedExternal: false,
            instrument: "IC:SPY:2026-05-29:A|B|C|D",
            positionKey: "IC:SPY:2026-05-29:A|B|C|D:short",
            side: "short",
            quantity: 1,
            entryPrice: 0.45,
            syncedAt: 1,
        } as PortfolioPosition, failures)

        expect(failures).toEqual([
            "alpaca-options: unowned non-external provider position IC:SPY:2026-05-29:A|B|C|D (qty=1 side=short positionKey=IC:SPY:2026-05-29:A|B|C|D:short strategy=<missing> operator_action=adopt_expected_external_or_close)",
        ])
    })

    it("rejects active commit-unknown orders and unresolved blocked safety faults", () => {
        const strategy = createStrategy()
        const failures: string[] = []

        providerIdentityPreflightTestables.inspectActiveOrder(strategy, {
            orderId: "vokc01abcde23456",
            canonicalOrderId: "vokc01abcde23456",
            providerClientOrderId: "vokc01abcde23456",
            commitOutcome: "commit_unknown",
            status: "pending",
        } as OrderSnapshot, failures)
        providerIdentityPreflightTestables.inspectSafetyFault(strategy, {
            category: "commit_unknown",
            message: "provider truth unresolved",
            blocked: true,
        } as ExecutionSafetyFaultRow, failures)

        expect(failures).toEqual([
            "okx-swap: OKX reset replay has commit-unknown order vokc01abcde23456 (canonical=vokc01abcde23456 provider=<missing> client=vokc01abcde23456 aliases=<none> commit=commit_unknown status=pending)",
            "okx-swap: OKX reset replay has unresolved blocked safety fault commit_unknown: provider truth unresolved",
        ])
    })
})

function createProviderOrder(
    overrides: Partial<PortfolioPendingOrder>
): PortfolioPendingOrder {
    return {
        app: "okx-swap",
        ownershipStatus: "owned",
        orderId: "vokc01abcde23456",
        canonicalOrderId: "vokc01abcde23456",
        providerOrderId: "provider-order-1",
        providerClientOrderId: "vokc01abcde23456",
        providerOrderAliases: [],
        instrument: "BTC-USDT-SWAP",
        venue: "okx",
        status: "pending",
        quantity: 1,
        filledQuantity: 0,
        remainingQuantity: 1,
        submittedAt: 1,
        updatedAt: 1,
        ...overrides,
    }
}

function createStrategy(overrides?: Partial<StoredStrategy>): StoredStrategy {
    return {
        _id: "strategy-okx" as never,
        _creationTime: 1,
        app: "okx-swap",
        accountId: "test-account",
        name: "OKX reset replay",
        enabled: false,
        schedule: "0 * * * *",
        policy: {},
        context: "",
        ...overrides,
    }
}
