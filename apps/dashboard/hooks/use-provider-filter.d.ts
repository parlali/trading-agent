import type { VenueApp } from "@/lib/constants";
export declare function useProviderFilter<T extends {
    app: string;
}>(): {
    provider: any;
    setProvider: import("react").Dispatch<any>;
    filterByProvider: (items: T[]) => T[];
};
export declare function useFilteredData<T extends {
    app: string;
}>(data: T[] | undefined, provider: VenueApp | null): {
    filtered: T[];
    isEmpty: boolean;
    isLoading: boolean;
};
//# sourceMappingURL=use-provider-filter.d.ts.map