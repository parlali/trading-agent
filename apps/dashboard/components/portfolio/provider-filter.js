import { FilterBar } from "@/components/filter-bar";
import { ACTIVE_VENUE_APPS, VENUE_META } from "@/lib/constants";
export function ProviderFilter({ selected, onSelect, }) {
    return (<FilterBar items={[null, ...ACTIVE_VENUE_APPS]} selected={selected} onSelect={(v) => onSelect(v)} getLabel={(v) => v === null ? "All" : VENUE_META[v]?.shortLabel ?? v}/>);
}
