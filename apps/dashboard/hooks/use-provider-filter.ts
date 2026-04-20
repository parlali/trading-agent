import { useState, useMemo, useCallback } from "react"
import type { ActiveVenueApp } from "@/lib/constants"

export function useProviderFilter<T extends { app: string }>() {
    const [provider, setProvider] = useState<ActiveVenueApp | null>(null)

    const filterByProvider = useCallback(
        (items: T[]): T[] => {
            if (!provider) return items
            return items.filter((item) => item.app === provider)
        },
        [provider],
    )

    return { provider, setProvider, filterByProvider }
}

export function useFilteredData<T extends { app: string }>(
    data: T[] | undefined,
    provider: ActiveVenueApp | null,
): { filtered: T[], isEmpty: boolean, isLoading: boolean } {
    const filtered = useMemo(() => {
        if (!data) return []
        if (!provider) return data
        return data.filter((item) => item.app === provider)
    }, [data, provider])

    return {
        filtered,
        isEmpty: data !== undefined && filtered.length === 0,
        isLoading: data === undefined,
    }
}
