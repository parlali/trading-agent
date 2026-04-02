"use client"

import { useQuery, useMutation } from "convex/react"
import { api } from "@valiq-trading/convex"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { PageSkeleton } from "@/components/page-skeleton"
import { VENUE_META, VENUE_APPS, type VenueApp } from "@/lib/constants"
import { formatRelativeTime } from "@/lib/format"
import { ShieldAlert } from "lucide-react"
import { toast } from "sonner"

export default function KillSwitchesPage() {
    const systemState = useQuery(api.queries.getSystemState, {})
    const setKillSwitch = useMutation(api.mutations.setKillSwitch)

    if (systemState === undefined) {
        return <PageSkeleton count={4} height="h-20" spacing="space-y-4" />
    }

    const handleToggle = (scope: "alpaca-options" | "polymarket" | "mt5" | "global", enabled: boolean) => {
        setKillSwitch({ scope, enabled, updatedBy: "dashboard" })
            .then(() => toast.success(`Kill switch ${enabled ? "activated" : "deactivated"}`))
            .catch(() => toast.error("Failed to update kill switch"))
    }

    return (
        <div className="space-y-6">
            <Card className={systemState.globalKillSwitch ? "border-signal-danger/30" : ""}>
                <CardHeader>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                            <ShieldAlert className={`h-5 w-5 shrink-0 ${systemState.globalKillSwitch ? "text-signal-danger" : "text-muted-foreground"}`} />
                            <div className="min-w-0">
                                <CardTitle className="text-base">Global Kill Switch</CardTitle>
                                <CardDescription>
                                    Halt all trading across every venue
                                </CardDescription>
                            </div>
                        </div>
                        <Switch
                            className="shrink-0"
                            checked={systemState.globalKillSwitch}
                            onCheckedChange={(checked) => handleToggle("global", checked)}
                        />
                    </div>
                </CardHeader>
                {systemState.updatedAt > 0 ? (
                    <CardContent>
                        <p className="text-xs text-muted-foreground">
                            Last updated {formatRelativeTime(systemState.updatedAt)}
                        </p>
                    </CardContent>
                ) : null}
            </Card>

            <div className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground">Per-Venue Kill Switches</h3>
                {VENUE_APPS.map((app) => {
                    const meta = VENUE_META[app]
                    const key = app.replace(/-/g, "_") as keyof typeof systemState.appKillSwitches
                    const isKilled = systemState.appKillSwitches[key] === true

                    return (
                        <Card key={app} className={isKilled ? "border-signal-danger/30" : ""}>
                            <CardContent className="flex items-center justify-between gap-3 py-4">
                                <div className="flex items-center gap-3 min-w-0">
                                    <meta.icon className={`h-4 w-4 shrink-0 ${isKilled ? "text-signal-danger" : "text-muted-foreground"}`} />
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium">{meta.label}</p>
                                        <p className="text-xs text-muted-foreground hidden sm:block">{meta.description}</p>
                                    </div>
                                </div>
                                <Switch
                                    className="shrink-0"
                                    checked={isKilled}
                                    onCheckedChange={(checked) => handleToggle(app, checked)}
                                />
                            </CardContent>
                        </Card>
                    )
                })}
            </div>
        </div>
    )
}
