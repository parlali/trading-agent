import { useQuery } from "convex/react";
import { api } from "@valiq-trading/convex";
export function useDashboardOverview() {
    const data = useQuery(api.queries.getDashboardOverview);
    return {
        data,
        isLoading: data === undefined,
    };
}
