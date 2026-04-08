import { VENUE_META, type ActiveVenueApp } from "@/lib/constants"
import { Badge } from "@/components/ui/badge"

export function VenueBadge({ app }: { app: string }) {
    const meta = VENUE_META[app as ActiveVenueApp]
    if (!meta) return <Badge variant="outline">{app}</Badge>

    return (
        <Badge variant="outline" className="gap-1 font-normal">
            <meta.icon className="h-3 w-3" />
            {meta.shortLabel}
        </Badge>
    )
}
