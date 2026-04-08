import { FilterBar } from "@/components/filter-bar"
import { VENUE_APPS, VENUE_META, type VenueApp } from "@/lib/constants"

export function ProviderFilter({
    selected,
    onSelect,
}: {
    selected: VenueApp | null
    onSelect: (app: VenueApp | null) => void
}) {
    return (
        <FilterBar
            items={[null, ...VENUE_APPS] as const}
            selected={selected as string | null}
            onSelect={(v) => onSelect(v as VenueApp | null)}
            getLabel={(v) => v === null ? "All" : VENUE_META[v as VenueApp].shortLabel}
        />
    )
}
