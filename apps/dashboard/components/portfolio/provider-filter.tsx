import { FilterBar } from "@/components/filter-bar"
import { ACTIVE_VENUE_APPS, VENUE_META, type ActiveVenueApp } from "@/lib/constants"

export function ProviderFilter({
    selected,
    onSelect,
}: {
    selected: ActiveVenueApp | null
    onSelect: (app: ActiveVenueApp | null) => void
}) {
    return (
        <FilterBar
            items={[null, ...ACTIVE_VENUE_APPS] as const}
            selected={selected}
            onSelect={onSelect}
            getLabel={(v) => v === null ? "All" : VENUE_META[v].shortLabel}
        />
    )
}
