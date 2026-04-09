"use client";
import { useQuery } from "convex/react";
import { api } from "@valiq-trading/convex";
import { FreshnessHeader, ProviderFilter, TradeHistoryTable, } from "@/components/portfolio";
import { PageSkeleton } from "@/components/page-skeleton";
import { usePortfolioFreshness } from "@/hooks/use-portfolio-freshness";
import { useProviderFilter } from "@/hooks/use-provider-filter";
export default function TradesPage() {
    const { provider, setProvider } = useProviderFilter();
    const freshnessStates = usePortfolioFreshness(provider);
    const trades = useQuery(api.queries.getPortfolioTradeHistory, {
        app: provider,
        limit: 100,
    });
    if (trades === undefined) {
        return <PageSkeleton count={5}/>;
    }
    return (<div className="space-y-4">
            <ProviderFilter selected={provider} onSelect={setProvider}/>
            <FreshnessHeader freshness={freshnessStates}/>
            <TradeHistoryTable trades={trades} title="Trade Events"/>
        </div>);
}
