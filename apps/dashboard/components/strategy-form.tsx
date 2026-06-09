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
import {
    NumberPolicyField,
    SwitchPolicyField,
    TextPolicyField,
    TradingHoursPolicyFields,
    getNestedValue,
    parseStringList,
    policyStringListValue,
    setNestedValue,
    type PolicyFields,
} from "@/components/strategy-policy-fields"
import { VENUE_META, type ActiveVenueApp } from "@/lib/constants"
import { POLICY_DEFAULTS, STRATEGY_CONTEXT_DEFAULTS } from "@valiq-trading/core"
import { toast } from "sonner"
import { Loader2, Plus, X } from "lucide-react"

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

type LlmProvider = "openrouter" | "codex"

type LlmPolicy = {
    provider: LlmProvider
    model?: string
    reasoning?: {
        effort?: "low" | "medium" | "high"
        exclude?: boolean
    }
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
    summary?: "auto" | "concise" | "detailed" | "none"
    serviceTier?: string
    authMode?: "chatgpt" | "access-token" | "api-key"
    codexBin?: string
}

const CODEX_PROVIDER_ENABLED = process.env.NEXT_PUBLIC_ENABLE_CODEX_PROVIDER === "true"

function getDefaultPolicy(app: ActiveVenueApp): PolicyFields {
    return structuredClone(POLICY_DEFAULTS[app] ?? {})
}

function getDefaultContext(app: ActiveVenueApp): string {
    return STRATEGY_CONTEXT_DEFAULTS[app] ?? ""
}

function normalizePolicyForEdit(policy: PolicyFields): PolicyFields {
    if (policy.llm && typeof policy.llm === "object") {
        return policy
    }

    const legacyModel = typeof policy.model === "string" ? policy.model : ""
    const legacyReasoning = policy.reasoning && typeof policy.reasoning === "object"
        ? policy.reasoning as LlmPolicy["reasoning"]
        : undefined
    const { model, reasoning, ...rest } = policy

    return {
        ...rest,
        llm: {
            provider: "openrouter",
            model: legacyModel,
            reasoning: legacyReasoning,
        },
    }
}

function readLlmPolicy(policy: PolicyFields): LlmPolicy {
    const llm = policy.llm && typeof policy.llm === "object"
        ? policy.llm as LlmPolicy
        : undefined

    return {
        provider: llm?.provider === "codex" ? "codex" : "openrouter",
        model: llm?.model ?? "",
        reasoning: llm?.reasoning,
        effort: llm?.effort,
        summary: llm?.summary,
        serviceTier: llm?.serviceTier,
        authMode: llm?.authMode,
        codexBin: llm?.codexBin,
    }
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
        initialData?.policy ? normalizePolicyForEdit(initialData.policy) : getDefaultPolicy("alpaca-options")
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

    function handleLlmProviderChange(provider: LlmProvider) {
        setPolicy((prev) => {
            const current = readLlmPolicy(prev)
            return {
                ...prev,
                llm: provider === "openrouter"
                    ? {
                        provider,
                        model: current.model ?? "",
                        reasoning: current.reasoning ?? {
                            effort: "medium",
                            exclude: true,
                        },
                    }
                    : {
                        provider,
                        model: current.model ?? "",
                        effort: current.effort ?? "medium",
                        summary: current.summary ?? "concise",
                        authMode: current.authMode ?? "chatgpt",
                    },
            }
        })
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

        const llm = readLlmPolicy(policy)
        const model = typeof llm.model === "string" ? llm.model.trim() : ""
        if (!model) {
            toast.error(`${llm.provider === "openrouter" ? "OpenRouter" : "Codex"} model id is required`)
            return
        }

        if (llm.provider === "codex" && policy.dryRun !== true) {
            toast.error("Codex strategies are dry-run only")
            return
        }

        if (llm.provider === "codex" && !llm.authMode) {
            toast.error("Codex auth mode is required")
            return
        }

        setSaving(true)
        try {
            const cleanedPolicy = cleanPolicy({
                ...policy,
                llm: {
                    ...llm,
                    model,
                },
            })
            delete cleanedPolicy.model
            delete cleanedPolicy.reasoning

            const strategyId = await upsertStrategy({
                id: mode === "edit" ? initialData?.id : undefined,
                app,
                name: name.trim(),
                enabled,
                schedule: schedule.trim(),
                policy: cleanedPolicy,
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
    const llm = readLlmPolicy(policy)
    const showCodexOption = CODEX_PROVIDER_ENABLED || llm.provider === "codex"

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
                    <SwitchPolicyField
                        label="Dry Run"
                        fieldKey="dryRun"
                        checked={policy.dryRun === true}
                        onChange={handlePolicyFieldChange}
                        description="Log orders without executing"
                        className="flex items-center justify-between"
                    />

                    <div className="space-y-3 rounded-lg border p-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label className="text-sm">Model Provider</Label>
                                <Select
                                    value={llm.provider}
                                    onValueChange={(value) => handleLlmProviderChange(value as LlmProvider)}
                                >
                                    <SelectTrigger className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="openrouter">OpenRouter</SelectItem>
                                        {showCodexOption ? (
                                            <SelectItem value="codex">Codex</SelectItem>
                                        ) : null}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-sm">
                                    {llm.provider === "openrouter" ? "OpenRouter Model ID" : "Codex Model ID"}
                                    <span className="text-signal-danger ml-0.5">*</span>
                                </Label>
                                <Input
                                    placeholder={llm.provider === "openrouter" ? "anthropic/claude-sonnet-4.6" : "gpt-5.4"}
                                    value={llm.model ?? ""}
                                    onChange={(e) => handlePolicyFieldChange("llm.model", e.target.value)}
                                    className="font-mono"
                                />
                            </div>
                        </div>

                        {llm.provider === "openrouter" ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div className="space-y-1.5">
                                    <Label className="text-sm">Reasoning Effort</Label>
                                    <Select
                                        value={llm.reasoning?.effort ?? "medium"}
                                        onValueChange={(value) => handlePolicyFieldChange("llm.reasoning.effort", value)}
                                    >
                                        <SelectTrigger className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="low">Low</SelectItem>
                                            <SelectItem value="medium">Medium</SelectItem>
                                            <SelectItem value="high">High</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <SwitchPolicyField
                                    label="Hide Reasoning"
                                    fieldKey="llm.reasoning.exclude"
                                    checked={llm.reasoning?.exclude !== false}
                                    onChange={handlePolicyFieldChange}
                                    className="flex items-center justify-between rounded-md border p-3"
                                />
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                                <div className="space-y-1.5">
                                    <Label className="text-sm">Effort</Label>
                                    <Select
                                        value={llm.effort ?? "medium"}
                                        onValueChange={(value) => handlePolicyFieldChange("llm.effort", value)}
                                    >
                                        <SelectTrigger className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="none">None</SelectItem>
                                            <SelectItem value="minimal">Minimal</SelectItem>
                                            <SelectItem value="low">Low</SelectItem>
                                            <SelectItem value="medium">Medium</SelectItem>
                                            <SelectItem value="high">High</SelectItem>
                                            <SelectItem value="xhigh">X-High</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-sm">Summary</Label>
                                    <Select
                                        value={llm.summary ?? "concise"}
                                        onValueChange={(value) => handlePolicyFieldChange("llm.summary", value)}
                                    >
                                        <SelectTrigger className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="none">None</SelectItem>
                                            <SelectItem value="auto">Auto</SelectItem>
                                            <SelectItem value="concise">Concise</SelectItem>
                                            <SelectItem value="detailed">Detailed</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-sm">Auth Mode</Label>
                                    <Select
                                        value={llm.authMode ?? "chatgpt"}
                                        onValueChange={(value) => handlePolicyFieldChange("llm.authMode", value)}
                                    >
                                        <SelectTrigger className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="chatgpt">ChatGPT Session</SelectItem>
                                            <SelectItem value="access-token">Access Token</SelectItem>
                                            <SelectItem value="api-key">API Key</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <TextPolicyField
                                    label="Codex Binary"
                                    fieldKey="llm.codexBin"
                                    value={llm.codexBin}
                                    onChange={handlePolicyFieldChange}
                                    placeholder="codex"
                                />
                            </div>
                        )}
                    </div>

                    <div className="rounded-lg border p-3 space-y-3">
                        <div>
                            <Label className="text-sm">Risk Governance</Label>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                Canonical per-strategy drawdown, cooldown, and continuity policy. Drawdown limits are percentages of current account balance.
                            </p>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <NumberPolicyField
                                label="Max Day Drawdown (%)"
                                fieldKey="safety.maxDrawdownDay"
                                value={getNestedValue(policy, "safety.maxDrawdownDay")}
                                onChange={handlePolicyFieldChange}
                                placeholder="3"
                                labelClassName="text-xs"
                            />
                            <NumberPolicyField
                                label="Max Week Drawdown (%)"
                                fieldKey="safety.maxDrawdownWeek"
                                value={getNestedValue(policy, "safety.maxDrawdownWeek")}
                                onChange={handlePolicyFieldChange}
                                placeholder="10"
                                labelClassName="text-xs"
                            />
                            <NumberPolicyField
                                label="Cooldown After Day Breach (minutes)"
                                fieldKey="safety.cooldownMinutesAfterDayBreach"
                                value={getNestedValue(policy, "safety.cooldownMinutesAfterDayBreach")}
                                onChange={handlePolicyFieldChange}
                                step={1}
                                min={0}
                                placeholder="720"
                                labelClassName="text-xs"
                            />
                            <NumberPolicyField
                                label="Cooldown After Week Breach (minutes)"
                                fieldKey="safety.cooldownMinutesAfterWeekBreach"
                                value={getNestedValue(policy, "safety.cooldownMinutesAfterWeekBreach")}
                                onChange={handlePolicyFieldChange}
                                step={1}
                                min={0}
                                placeholder="1440"
                                labelClassName="text-xs"
                            />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <TextPolicyField
                                label="Strategy Timezone"
                                fieldKey="safety.strategyTimezone"
                                value={getNestedValue(policy, "safety.strategyTimezone")}
                                onChange={handlePolicyFieldChange}
                                placeholder="UTC"
                                labelClassName="text-xs"
                            />
                            <NumberPolicyField
                                label="Pending Entry TTL (minutes)"
                                fieldKey="safety.pendingEntryTtlMinutes"
                                value={getNestedValue(policy, "safety.pendingEntryTtlMinutes")}
                                onChange={handlePolicyFieldChange}
                                step={1}
                                min={1}
                                placeholder="120"
                                labelClassName="text-xs"
                            />
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
                                    <NumberPolicyField
                                        label="Close Buffer (minutes)"
                                        fieldKey="safety.sessionFlat.closeBufferMinutes"
                                        value={getNestedValue(policy, "safety.sessionFlat.closeBufferMinutes")}
                                        onChange={handlePolicyFieldChange}
                                        step={1}
                                        min={1}
                                        placeholder="15"
                                        labelClassName="text-xs"
                                    />
                                    <TextPolicyField
                                        label="Session Flat Timezone"
                                        fieldKey="safety.sessionFlat.timezone"
                                        value={getNestedValue(policy, "safety.sessionFlat.timezone")}
                                        onChange={handlePolicyFieldChange}
                                        placeholder="UTC"
                                        labelClassName="text-xs"
                                    />
                                </div>
                            </div>
                        ) : null}

                        <div className="space-y-1.5">
                            <Label className="text-xs">Expected External Instruments</Label>
                            <Textarea
                                placeholder={"GREENLAND-2026\nBTC-USDT-SWAP"}
                                value={policyStringListValue(getNestedValue(policy, "safety.expectedExternalInstruments"))}
                                onChange={(e) => handlePolicyFieldChange(
                                    "safety.expectedExternalInstruments",
                                    parseStringList(e.target.value)
                                )}
                                rows={2}
                                className="font-mono text-xs"
                            />
                        </div>
                    </div>

                    {app === "alpaca-options" ? (
                        <NumberPolicyField
                            label="Max Loss Per Play ($)"
                            fieldKey="maxLossPerPlay"
                            value={policy.maxLossPerPlay}
                            onChange={handlePolicyFieldChange}
                            placeholder="500"
                            required
                        />
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
                            <NumberPolicyField
                                label="Max Risk Per Trade (%)"
                                fieldKey="maxRiskPercent"
                                value={policy.maxRiskPercent}
                                onChange={handlePolicyFieldChange}
                                min={0}
                                max={100}
                                placeholder="2"
                                required
                                description="Percentage of account balance risked per trade on stop loss"
                            />

                            <TradingHoursPolicyFields
                                policy={policy}
                                onChange={handlePolicyFieldChange}
                                startPlaceholder="08:00"
                                endPlaceholder="16:00"
                            />

                            <NumberPolicyField
                                label="Min Risk/Reward Ratio"
                                fieldKey="minRiskReward"
                                value={policy.minRiskReward}
                                onChange={handlePolicyFieldChange}
                                min={0}
                                placeholder="0.5"
                                description="Minimum reward-to-risk ratio required to enter a trade"
                            />

                            <SwitchPolicyField
                                label="Allow Multiple Pending Entries Per Instrument"
                                fieldKey="allowMultiplePendingEntryOrdersPerInstrument"
                                checked={Boolean(policy.allowMultiplePendingEntryOrdersPerInstrument)}
                                onChange={handlePolicyFieldChange}
                                description="When off, MT5 will reject a new entry if this strategy already has a live pending entry order for the same instrument"
                            />

                            <SwitchPolicyField
                                label="Allow Overlapping Exposure"
                                fieldKey="allowOverlappingExposure"
                                checked={Boolean(policy.allowOverlappingExposure)}
                                onChange={handlePolicyFieldChange}
                                description="When off, MT5 enforces one live position or entry order at a time for this strategy and blocks add-on entries"
                            />

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
                                    value={policyStringListValue(policy.allowedInstruments)}
                                    onChange={(e) => handlePolicyFieldChange(
                                        "allowedInstruments",
                                        parseStringList(e.target.value, (instrument) => instrument.toUpperCase())
                                    )}
                                    rows={3}
                                    className="font-mono text-sm"
                                />
                                <p className="text-xs text-muted-foreground">
                                    One OKX swap instrument per line or comma-separated. Use canonical instrument IDs such as BTC-USDT-SWAP.
                                </p>
                            </div>

                            <NumberPolicyField
                                label="Max Leverage"
                                fieldKey="maxLeverage"
                                value={policy.maxLeverage}
                                onChange={handlePolicyFieldChange}
                                step={1}
                                min={1}
                                max={5}
                                placeholder="3"
                                required
                            />

                            <NumberPolicyField
                                label="Max Risk Per Trade (%)"
                                fieldKey="maxRiskPercent"
                                value={policy.maxRiskPercent}
                                onChange={handlePolicyFieldChange}
                                min={0}
                                max={100}
                                placeholder="1"
                                required
                            />

                            <TradingHoursPolicyFields
                                policy={policy}
                                onChange={handlePolicyFieldChange}
                                startPlaceholder="00:00"
                                endPlaceholder="23:59"
                            />

                            <NumberPolicyField
                                label="Funding Rate Threshold"
                                fieldKey="fundingRateThreshold"
                                value={policy.fundingRateThreshold}
                                onChange={handlePolicyFieldChange}
                                min={0}
                                placeholder="0.003"
                                inputClassName="font-mono"
                                required
                                description="Absolute funding-rate threshold. For example, 0.003 means 0.30%."
                            />

                            <SwitchPolicyField
                                label="Require Take Profit"
                                fieldKey="requireTakeProfit"
                                checked={Boolean(policy.requireTakeProfit)}
                                onChange={handlePolicyFieldChange}
                                description="When enabled, new OKX entries must include an explicit take-profit level."
                            />
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
