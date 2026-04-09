import { useQuery } from "convex/react";
import { api } from "@valiq-trading/convex";
export function useStrategy(id) {
    const data = useQuery(api.queries.getStrategyById, {
        id: id,
    });
    return {
        data,
        isLoading: data === undefined,
        notFound: data === null,
    };
}
