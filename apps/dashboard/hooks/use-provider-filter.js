import { useState, useMemo, useCallback } from "react";
export function useProviderFilter() {
    const [provider, setProvider] = useState(null);
    const filterByProvider = useCallback((items) => {
        if (!provider)
            return items;
        return items.filter((item) => item.app === provider);
    }, [provider]);
    return { provider, setProvider, filterByProvider };
}
export function useFilteredData(data, provider) {
    const filtered = useMemo(() => {
        if (!data)
            return [];
        if (!provider)
            return data;
        return data.filter((item) => item.app === provider);
    }, [data, provider]);
    return {
        filtered,
        isEmpty: data !== undefined && filtered.length === 0,
        isLoading: data === undefined,
    };
}
