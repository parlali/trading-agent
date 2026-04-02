import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import type { Id } from "@valiq-trading/convex"

export function useStrategy(id: string) {
    const data = useQuery(api.queries.getStrategyById, {
        id: id as Id<"strategies">,
    })
    return {
        data,
        isLoading: data === undefined,
        notFound: data === null,
    }
}
