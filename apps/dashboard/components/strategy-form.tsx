"use client"

import { useState } from "react"
import { useMutation } from "convex/react"
import { api } from "@valiq-trading/convex"
import type { Id } from "@valiq-trading/convex"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { ScheduleBuilder } from "@/components/schedule-builder"
import { VENUE_META, type ActiveVenueApp } from "@/lib/constants"
import { POLICY_DEFAULTS, STRATEGY_CONTEXT_DEFAULTS } from "@valiq-trading/core"
import { toast } from "sonner"
import { Loader2, Plus, X } from "lucide-react"

type PolicyFields = Record<string, unknown>

type StrategyFormData = {
    app: ActiveVenueApp
    name: string
    enabled: boolean
    schedule: string
    policy: PolicyFields
    context: string
}

type StrategyFormProps = {
    mode: "create" | "edit"
    initialData?: StrategyFormData & { id: Id<"strategies"> }
}

function getDefaultPolicy(app: ActiveVenueApp): PolicyFields {
    return structuredClone(POLICY_DEFAULTS[app] ?? {})
}

function getDefaultContext(app: ActiveVenueApp): string {
    return STRATEGY_CONTEXT_DEFAULTS[app] ?? ""
}

function getNestedValue(obj: PolicyFields, path: string): unknown {
    const parts = path.split(".")
    let current: unknown = obj
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== "object") return undefined
        current = (current as Record<string, unknown>)[part]
    }
    return current
}

function setNestedValue(obj: PolicyFields, path: string, value: unknown): PolicyFields {
    const parts = path.split(".")
    const result = { ...obj }
    const leafKey = parts.at(-1)

    if (!leafKey) {
        return result
    }

    if (parts.length === 1) {
        result[leafKey] = value
        return result
    }

    const parentPath = parts.slice(0, -1)

    let parent: Record<string, unknown> = result
    for (const key of parentPath) {
        parent[key] = { ...((parent[key] as Record<string, unknown> | undefined) ?? {}) }
        parent = parent[key] as Record<string, unknown>
    }
    parent[leafKey] = value

    return result
}

export function StrategyForm({ mode, initialData }: StrategyFormProps) {
    const router = useRouter()
    const upsertStrategy = useMutation(api.mutations.upsertStrategy)
    const [saving, setSaving] = useState(false)

    const [app, setApp] = useState<ActiveVenueApp>(initialData?.app ?? "alpaca-options")
    const [name, setName] = useState(initialData?.name ?? "")
    const [enabled, setEnabled] = useState(initialData?.enabled ?? false)
    const [schedule, setSchedule] = useState(initialData?.schedule ?? "")
    const [policy, setPolicy] = useState<PolicyFields>(
        initialData?.policy ?? getDefaultPolicy("alpaca-options")
    )
    const [context, setContext] = useState(initialData?.context ?? getDefaultContext("alpaca-options"))

    function handleVenueChange(newApp: ActiveVenueApp) {
        setApp(newApp)
        if (mode === "create") {
            setPolicy(getDefaultPolicy(newApp))
            setContext(getDefaultContext(newApp))
        }
    }

    function handlePolicyFieldChange(fieldKey: string, value: unknown) {
        setPolicy((prev) => setNestedValue(prev, fieldKey, value))
    }

    function cleanPolicy(raw: PolicyFields): PolicyFields {
        const cleaned: PolicyFields = {}
        for (const [key, val] of Object.entries(raw)) {
            if (val === undefined || val === null || val === "") continue
            if (typeof val === "object" && !Array.isArray(val)) {
                const nested = cleanPolicy(val as PolicyFields)
                if (Object.keys(nested).length > 0) cleaned[key] = nested
            } else {
                cleaned[key] = val
            }
        }
        return cleaned
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()

        if (!name.trim()) {
            toast.error("Name is required")
            return
        }

        if (!schedule.trim()) {
            toast.error("Schedule is required")
            return
        }

        const model = typeof policy.model === "string" ? policy.model.trim() : ""
        if (!model) {
            toast.error("OpenRouter model id is required")
            return
        }

        setSaving(true)
        try {
            const strategyId = await upsertStrategy({
                id: mode === "edit" ? initialData?.id : undefined,
                app,
                name: name.trim(),
                enabled,
                schedule: schedule.trim(),
                policy: cleanPolicy({
                    ...policy,
                    model,
                }),
                context: context.trim(),
            })

            toast.success(mode === "create" ? "Strategy created" : "Strategy updated")
            router.push(`/strategies/${strategyId}`)
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to save strategy")
        } finally {
            setSaving(false)
        }
    }

    const maxBet = (policy.maxBet ?? { mode: "fixed", value: 100 }) as { mode: string; value: number }

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">General</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-1.5">
                        <Label className="text-sm">
                            Venue<span className="text-signal-danger ml-0.5">*</span>
                        </Label>
                        <Select
                            value={app}
                            onValueChange={(v) => handleVenueChange(v as ActiveVenueApp)}
                            disabled={mode === "edit"}
                        >
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {(Object.entries(VENUE_META) as [ActiveVenueApp, typeof VENUE_META[ActiveVenueApp]][]).map(
                                    ([key, meta]) => (
                                        <SelectItem key={key} value={key}>
                                            {meta.label}
                                        </SelectItem>
                                    )
                                )}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-1.5">
                        <Label className="text-sm">
                            Name<span className="text-signal-danger ml-0.5">*</span>
                        </Label>
                        <Input
                            placeholder="e.g. 4-Day SPY Iron Condor"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </div>

                    <ScheduleBuilder value={schedule} onChange={setSchedule} />

                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-sm">Enabled</Label>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                Strategy will run on schedule when enabled
                            </p>
                        </div>
                        <Switch checked={enabled} onCheckedChange={setEnabled} />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Policy</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-sm">Dry Run</Label>
                            <p className="text-xs text-muted-foreground mt-0.5">Log orders without executing</p>
                        </div>
                        <Switch
                            checked={policy.dryRun === true}
                            onCheckedChange={(checked) => handlePolicyFieldChange("dryRun", checked)}
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label className="text-sm">
                            OpenRouter Model ID<span className="text-signal-danger ml-0.5">*</span>
                        </Label>
                        <Input
                            placeholder="anthropic/claude-sonnet-4.6"
                            value={(policy.model as string) ?? ""}
                            onChange={(e) => handlePolicyFieldChange(
                                "model",
                                e.target.value
                            )}
                            className="font-mono"
                        />
                        <p className="text-xs text-muted-foreground">
                            Required OpenRouter model id for this strategy.
                        </p>
                    </div>

                    <div className="rounded-lg border p-3 space-y-3">
                        <div>
                            <Label className="text-sm">Risk Governance</Label>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                Canonical per-strategy drawdown, cooldown, and continuity policy. Drawdown limits are percentages of current account balance.
                            </p>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label className="text-xs">Max Day Drawdown (%)</Label>
                                <Input
                                    type="number"
                                    step="any"
                                    placeholder="3"
                                    value={getNestedValue(policy, "safety.maxDrawdownDay") !== undefined ? String(getNestedValue(policy, "safety.maxDrawdownDay")) : ""}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "safety.maxDrawdownDay",
                                        e.target.value === "" ? undefined : Number(e.target.value)
                                    )}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs">Max Week Drawdown (%)</Label>
                                <Input
                                    type="number"
                                    step="any"
                                    placeholder="10"
                                    value={getNestedValue(policy, "safety.maxDrawdownWeek") !== undefined ? String(getNestedValue(policy, "safety.maxDrawdownWeek")) : ""}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "safety.maxDrawdownWeek",
                                        e.target.value === "" ? undefined : Number(e.target.value)
                                    )}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs">Cooldown After Day Breach (minutes)</Label>
                                <Input
                                    type="number"
                                    step={1}
                                    min={0}
                                    placeholder="720"
                                    value={getNestedValue(policy, "safety.cooldownMinutesAfterDayBreach") !== undefined ? String(getNestedValue(policy, "safety.cooldownMinutesAfterDayBreach")) : ""}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "safety.cooldownMinutesAfterDayBreach",
                                        e.target.value === "" ? undefined : Number(e.target.value)
                                    )}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs">Cooldown After Week Breach (minutes)</Label>
                                <Input
                                    type="number"
                                    step={1}
                                    min={0}
                                    placeholder="1440"
                                    value={getNestedValue(policy, "safety.cooldownMinutesAfterWeekBreach") !== undefined ? String(getNestedValue(policy, "safety.cooldownMinutesAfterWeekBreach")) : ""}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "safety.cooldownMinutesAfterWeekBreach",
                                        e.target.value === "" ? undefined : Number(e.target.value)
                                    )}
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label className="text-xs">Strategy Timezone</Label>
                                <Input
                                    placeholder="UTC"
                                    value={getNestedValue(policy, "safety.strategyTimezone") as string ?? ""}
                                    onChange={(e) => handlePolicyFieldChange("safety.strategyTimezone", e.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs">Pending Entry TTL (minutes)</Label>
                                <Input
                                    type="number"
                                    step={1}
                                    min={1}
                                    placeholder="120"
                                    value={getNestedValue(policy, "safety.pendingEntryTtlMinutes") !== undefined ? String(getNestedValue(policy, "safety.pendingEntryTtlMinutes")) : ""}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "safety.pendingEntryTtlMinutes",
                                        e.target.value === "" ? undefined : Number(e.target.value)
                                    )}
                                />
                            </div>
                        </div>

                        {(app === "mt5" || app === "okx-swap") ? (
                            <div className="rounded-md border p-3 space-y-3">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="space-y-1">
                                        <Label className="text-xs">Session Flat Policy</Label>
                                        <p className="text-xs text-muted-foreground">
                                            Deterministic end-of-session flattening is policy-controlled.
                                        </p>
                                    </div>
                                    <Switch
                                        checked={Boolean(getNestedValue(policy, "safety.sessionFlat.enabled"))}
                                        onCheckedChange={(checked) => handlePolicyFieldChange("safety.sessionFlat.enabled", checked)}
                                    />
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <Label className="text-xs">Close Buffer (minutes)</Label>
                                        <Input
                                            type="number"
                                            step={1}
                                            min={1}
                                            placeholder="15"
                                            value={getNestedValue(policy, "safety.sessionFlat.closeBufferMinutes") !== undefined ? String(getNestedValue(policy, "safety.sessionFlat.closeBufferMinutes")) : ""}
                                            onChange={(e) => handlePolicyFieldChange(
                                                "safety.sessionFlat.closeBufferMinutes",
                                                e.target.value === "" ? undefined : Number(e.target.value)
                                            )}
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label className="text-xs">Session Flat Timezone</Label>
                                        <Input
                                            placeholder="UTC"
                                            value={getNestedValue(policy, "safety.sessionFlat.timezone") as string ?? ""}
                                            onChange={(e) => handlePolicyFieldChange("safety.sessionFlat.timezone", e.target.value)}
                                        />
                                    </div>
                                </div>
                            </div>
                        ) : null}

                        <div className="space-y-1.5">
                            <Label className="text-xs">Expected External Instruments</Label>
                            <Textarea
                                placeholder={"GREENLAND-2026\nBTC-USDT-SWAP"}
                                value={Array.isArray(getNestedValue(policy, "safety.expectedExternalInstruments")) ? (getNestedValue(policy, "safety.expectedExternalInstruments") as string[]).join("\n") : ""}
                                onChange={(e) => handlePolicyFieldChange(
                                    "safety.expectedExternalInstruments",
                                    e.target.value
                                        .split(/[\n,]+/)
                                        .map((instrument) => instrument.trim())
                                        .filter(Boolean)
                                )}
                                rows={2}
                                className="font-mono text-xs"
                            />
                        </div>
                    </div>

                    {app === "alpaca-options" ? (
                        <div className="space-y-1.5">
                            <Label className="text-sm">
                                Max Loss Per Play ($)<span className="text-signal-danger ml-0.5">*</span>
                            </Label>
                            <Input
                                type="number"
                                step="any"
                                placeholder="500"
                                value={policy.maxLossPerPlay !== undefined ? String(policy.maxLossPerPlay) : ""}
                                onChange={(e) => handlePolicyFieldChange(
                                    "maxLossPerPlay",
                                    e.target.value === "" ? undefined : Number(e.target.value)
                                )}
                            />
                        </div>
                    ) : null}

                    {app === "polymarket" ? (
                        <div className="space-y-1.5">
                            <Label className="text-sm">
                                Max Bet<span className="text-signal-danger ml-0.5">*</span>
                            </Label>
                            <div className="flex items-center gap-2 flex-wrap">
                                <Select
                                    value={maxBet.mode}
                                    onValueChange={(v) => handlePolicyFieldChange("maxBet", { ...maxBet, mode: v })}
                                >
                                    <SelectTrigger className="w-full sm:w-40">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="fixed">Fixed USD</SelectItem>
                                        <SelectItem value="percentage">% of Account</SelectItem>
                                    </SelectContent>
                                </Select>
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="number"
                                        step="any"
                                        min={0}
                                        placeholder={maxBet.mode === "fixed" ? "100" : "5"}
                                        value={maxBet.value !== undefined ? String(maxBet.value) : ""}
                                        onChange={(e) => handlePolicyFieldChange(
                                            "maxBet",
                                            { ...maxBet, value: e.target.value === "" ? 0 : Number(e.target.value) }
                                        )}
                                        className="w-28"
                                    />
                                    <span className="text-sm text-muted-foreground">
                                        {maxBet.mode === "fixed" ? "USD" : "%"}
                                    </span>
                                </div>
                            </div>
                        </div>
                    ) : null}

                    {app === "mt5" ? (
                        <>
                            <div className="space-y-1.5">
                                <Label className="text-sm">
                                    Max Risk Per Trade (%)<span className="text-signal-danger ml-0.5">*</span>
                                </Label>
                                <Input
                                    type="number"
                                    step="any"
                                    min={0}
                                    max={100}
                                    placeholder="2"
                                    value={policy.maxRiskPercent !== undefined ? String(policy.maxRiskPercent) : ""}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "maxRiskPercent",
                                        e.target.value === "" ? undefined : Number(e.target.value)
                                    )}
                                />
                                <p className="text-xs text-muted-foreground">
                                    Percentage of account balance risked per trade on stop loss
                                </p>
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-sm">
                                    Trading Hours<span className="text-signal-danger ml-0.5">*</span>
                                </Label>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <Input
                                        placeholder="08:00"
                                        value={getNestedValue(policy, "tradingHours.start") as string ?? ""}
                                        onChange={(e) => handlePolicyFieldChange("tradingHours.start", e.target.value)}
                                        className="w-20 sm:w-24 font-mono"
                                    />
                                    <span className="text-muted-foreground">to</span>
                                    <Input
                                        placeholder="16:00"
                                        value={getNestedValue(policy, "tradingHours.end") as string ?? ""}
                                        onChange={(e) => handlePolicyFieldChange("tradingHours.end", e.target.value)}
                                        className="w-20 sm:w-24 font-mono"
                                    />
                                    <Input
                                        placeholder="UTC"
                                        value={getNestedValue(policy, "tradingHours.timezone") as string ?? ""}
                                        onChange={(e) => handlePolicyFieldChange("tradingHours.timezone", e.target.value)}
                                        className="w-24 sm:w-28"
                                    />
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-sm">Min Risk/Reward Ratio</Label>
                                <Input
                                    type="number"
                                    step="any"
                                    min={0}
                                    placeholder="0.5"
                                    value={policy.minRiskReward !== undefined ? String(policy.minRiskReward) : ""}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "minRiskReward",
                                        e.target.value === "" ? undefined : Number(e.target.value)
                                    )}
                                />
                                <p className="text-xs text-muted-foreground">
                                    Minimum reward-to-risk ratio required to enter a trade
                                </p>
                            </div>

                            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                                <div className="space-y-1">
                                    <Label className="text-sm">Allow Multiple Pending Entries Per Instrument</Label>
                                    <p className="text-xs text-muted-foreground">
                                        When off, MT5 will reject a new entry if this strategy already has a live pending entry order for the same instrument
                                    </p>
                                </div>
                                <Switch
                                    checked={Boolean(policy.allowMultiplePendingEntryOrdersPerInstrument)}
                                    onCheckedChange={(checked) => handlePolicyFieldChange("allowMultiplePendingEntryOrdersPerInstrument", checked)}
                                />
                            </div>

                            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                                <div className="space-y-1">
                                    <Label className="text-sm">Allow Overlapping Exposure</Label>
                                    <p className="text-xs text-muted-foreground">
                                        When off, MT5 enforces one live position or entry order at a time for this strategy and blocks add-on entries
                                    </p>
                                </div>
                                <Switch
                                    checked={Boolean(policy.allowOverlappingExposure)}
                                    onCheckedChange={(checked) => handlePolicyFieldChange("allowOverlappingExposure", checked)}
                                />
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-sm">Market Regions by Instrument</Label>
                                <p className="text-xs text-muted-foreground">
                                    Map instruments to market regions for holiday detection (e.g. US, GB, EU)
                                </p>
                                <div className="space-y-2">
                                    {Object.entries(
                                        (policy.marketRegionsByInstrument ?? {}) as Record<string, string[]>
                                    ).map(([instrument, regions], index) => (
                                        <div key={index} className="flex items-center gap-2">
                                            <Input
                                                placeholder="XAUUSD"
                                                value={instrument}
                                                onChange={(e) => {
                                                    const entries = Object.entries(
                                                        (policy.marketRegionsByInstrument ?? {}) as Record<string, string[]>
                                                    )
                                                    const currentEntry = entries[index]
                                                    if (!currentEntry) {
                                                        return
                                                    }
                                                    entries[index] = [e.target.value, currentEntry[1]]
                                                    const record: Record<string, string[]> = {}
                                                    for (const [k, v] of entries) {
                                                        record[k] = v
                                                    }
                                                    handlePolicyFieldChange("marketRegionsByInstrument", record)
                                                }}
                                                className="w-28 font-mono uppercase"
                                            />
                                            <Input
                                                placeholder="US, GB"
                                                value={Array.isArray(regions) ? regions.join(", ") : ""}
                                                onChange={(e) => {
                                                    const entries = Object.entries(
                                                        (policy.marketRegionsByInstrument ?? {}) as Record<string, string[]>
                                                    )
                                                    const currentEntry = entries[index]
                                                    if (!currentEntry) {
                                                        return
                                                    }
                                                    entries[index] = [
                                                        currentEntry[0],
                                                        e.target.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
                                                    ]
                                                    const record: Record<string, string[]> = {}
                                                    for (const [k, v] of entries) {
                                                        record[k] = v
                                                    }
                                                    handlePolicyFieldChange("marketRegionsByInstrument", record)
                                                }}
                                                className="flex-1 font-mono"
                                            />
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 shrink-0"
                                                onClick={() => {
                                                    const entries = Object.entries(
                                                        (policy.marketRegionsByInstrument ?? {}) as Record<string, string[]>
                                                    )
                                                    entries.splice(index, 1)
                                                    if (entries.length === 0) {
                                                        handlePolicyFieldChange("marketRegionsByInstrument", undefined)
                                                    } else {
                                                        const record: Record<string, string[]> = {}
                                                        for (const [k, v] of entries) {
                                                            record[k] = v
                                                        }
                                                        handlePolicyFieldChange("marketRegionsByInstrument", record)
                                                    }
                                                }}
                                            >
                                                <X className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    ))}
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                            const current = {
                                                ...((policy.marketRegionsByInstrument ?? {}) as Record<string, string[]>),
                                            }
                                            current[""] = []
                                            handlePolicyFieldChange("marketRegionsByInstrument", current)
                                        }}
                                    >
                                        <Plus className="h-4 w-4 mr-1" />
                                        Add Instrument
                                    </Button>
                                </div>
                            </div>
                        </>
                    ) : null}

                    {app === "okx-swap" ? (
                        <>
                            <div className="space-y-1.5">
                                <Label className="text-sm">
                                    Allowed Instruments<span className="text-signal-danger ml-0.5">*</span>
                                </Label>
                                <Textarea
                                    placeholder={"BTC-USDT-SWAP\nETH-USDT-SWAP"}
                                    value={Array.isArray(policy.allowedInstruments) ? policy.allowedInstruments.join("\n") : ""}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "allowedInstruments",
                                        e.target.value
                                            .split(/[\n,]+/)
                                            .map((instrument) => instrument.trim().toUpperCase())
                                            .filter(Boolean)
                                    )}
                                    rows={3}
                                    className="font-mono text-sm"
                                />
                                <p className="text-xs text-muted-foreground">
                                    One OKX swap instrument per line or comma-separated. Use canonical instrument IDs such as BTC-USDT-SWAP.
                                </p>
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-sm">
                                    Max Leverage<span className="text-signal-danger ml-0.5">*</span>
                                </Label>
                                <Input
                                    type="number"
                                    step={1}
                                    min={1}
                                    max={5}
                                    placeholder="3"
                                    value={policy.maxLeverage !== undefined ? String(policy.maxLeverage) : ""}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "maxLeverage",
                                        e.target.value === "" ? undefined : Number(e.target.value)
                                    )}
                                />
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-sm">
                                    Max Risk Per Trade (%)<span className="text-signal-danger ml-0.5">*</span>
                                </Label>
                                <Input
                                    type="number"
                                    step="any"
                                    min={0}
                                    max={100}
                                    placeholder="1"
                                    value={policy.maxRiskPercent !== undefined ? String(policy.maxRiskPercent) : ""}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "maxRiskPercent",
                                        e.target.value === "" ? undefined : Number(e.target.value)
                                    )}
                                />
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-sm">
                                    Trading Hours<span className="text-signal-danger ml-0.5">*</span>
                                </Label>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <Input
                                        placeholder="00:00"
                                        value={getNestedValue(policy, "tradingHours.start") as string ?? ""}
                                        onChange={(e) => handlePolicyFieldChange("tradingHours.start", e.target.value)}
                                        className="w-20 sm:w-24 font-mono"
                                    />
                                    <span className="text-muted-foreground">to</span>
                                    <Input
                                        placeholder="23:59"
                                        value={getNestedValue(policy, "tradingHours.end") as string ?? ""}
                                        onChange={(e) => handlePolicyFieldChange("tradingHours.end", e.target.value)}
                                        className="w-20 sm:w-24 font-mono"
                                    />
                                    <Input
                                        placeholder="UTC"
                                        value={getNestedValue(policy, "tradingHours.timezone") as string ?? ""}
                                        onChange={(e) => handlePolicyFieldChange("tradingHours.timezone", e.target.value)}
                                        className="w-24 sm:w-28"
                                    />
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-sm">
                                    Funding Rate Threshold<span className="text-signal-danger ml-0.5">*</span>
                                </Label>
                                <Input
                                    type="number"
                                    step="any"
                                    min={0}
                                    placeholder="0.003"
                                    value={policy.fundingRateThreshold !== undefined ? String(policy.fundingRateThreshold) : ""}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "fundingRateThreshold",
                                        e.target.value === "" ? undefined : Number(e.target.value)
                                    )}
                                    className="font-mono"
                                />
                                <p className="text-xs text-muted-foreground">
                                    Absolute funding-rate threshold. For example, 0.003 means 0.30%.
                                </p>
                            </div>

                            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                                <div className="space-y-1">
                                    <Label className="text-sm">Require Take Profit</Label>
                                    <p className="text-xs text-muted-foreground">
                                        When enabled, new OKX entries must include an explicit take-profit level.
                                    </p>
                                </div>
                                <Switch
                                    checked={Boolean(policy.requireTakeProfit)}
                                    onCheckedChange={(checked) => handlePolicyFieldChange("requireTakeProfit", checked)}
                                />
                            </div>
                        </>
                    ) : null}

                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Context</CardTitle>
                </CardHeader>
                <CardContent>
                    <Textarea
                        placeholder="Freeform strategy context injected into the agent system prompt. Describe the trading approach, opportunity selection, reassessment logic, and qualitative guidance."
                        value={context}
                        onChange={(e) => setContext(e.target.value)}
                        rows={10}
                        className="font-mono text-sm"
                    />
                </CardContent>
            </Card>

            <div className="flex items-center gap-3">
                <Button type="submit" disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {mode === "create" ? "Create Strategy" : "Save Changes"}
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => router.back()}
                >
                    Cancel
                </Button>
            </div>
        </form>
    )
}
