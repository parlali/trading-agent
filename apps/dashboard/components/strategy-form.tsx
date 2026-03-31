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
import { VENUE_META, type VenueApp } from "@/lib/constants"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"

type PolicyFields = Record<string, unknown>

type StrategyFormData = {
    app: VenueApp
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

const ALPACA_POLICY_DEFAULTS: PolicyFields = {
    dryRun: true,
    broker: "",
    accountId: "",
    maxLossPerStructure: 500,
    maxConcurrentStructures: 3,
    allowedUnderlyings: ["SPY"],
}

const POLYMARKET_POLICY_DEFAULTS: PolicyFields = {
    dryRun: true,
    credentialsRef: "",
    maxPositionSize: 100,
    maxTotalExposure: 1000,
}

const MT5_POLICY_DEFAULTS: PolicyFields = {
    dryRun: true,
    credentialsRef: "",
    maxDailyLoss: 500,
    maxConcurrentPositions: 3,
    maxLeverage: 10,
    allowedInstruments: ["EURUSD"],
    tradingHours: { start: "08:00", end: "16:00", timezone: "UTC" },
    emergencyFlattenThreshold: 1000,
}

const POLICY_DEFAULTS: Record<VenueApp, PolicyFields> = {
    "alpaca-options": ALPACA_POLICY_DEFAULTS,
    "polymarket": POLYMARKET_POLICY_DEFAULTS,
    "mt5": MT5_POLICY_DEFAULTS,
}

type FieldDef = {
    key: string
    label: string
    type: "text" | "number" | "boolean" | "array" | "object"
    required?: boolean
    placeholder?: string
    description?: string
}

const BASE_FIELDS: FieldDef[] = [
    { key: "dryRun", label: "Dry Run", type: "boolean", description: "Log orders without executing" },
    { key: "balanceFloor", label: "Balance Floor", type: "number", placeholder: "0", description: "Minimum account balance" },
    { key: "maxLossPerTrade", label: "Max Loss Per Trade", type: "number", placeholder: "0" },
    { key: "maxTotalExposure", label: "Max Total Exposure", type: "number", placeholder: "0" },
]

const ALPACA_FIELDS: FieldDef[] = [
    { key: "broker", label: "Broker", type: "text", required: true, placeholder: "alpaca-paper" },
    { key: "accountId", label: "Account ID", type: "text", required: true },
    { key: "maxLossPerStructure", label: "Max Loss Per Structure", type: "number", required: true },
    { key: "maxConcurrentStructures", label: "Max Concurrent Structures", type: "number", required: true },
    { key: "allowedUnderlyings", label: "Allowed Underlyings", type: "array", required: true, placeholder: "SPY, QQQ, IWM" },
]

const POLYMARKET_FIELDS: FieldDef[] = [
    { key: "credentialsRef", label: "Credentials Ref", type: "text", required: true, placeholder: "polymarket-main" },
    { key: "maxPositionSize", label: "Max Position Size", type: "number", required: true },
    { key: "maxTotalExposure", label: "Max Total Exposure (USDC)", type: "number", required: true },
    { key: "allowedCategories", label: "Allowed Categories", type: "array", placeholder: "politics, crypto, sports" },
    { key: "minLiquidity", label: "Min Liquidity", type: "number", placeholder: "0" },
]

const MT5_FIELDS: FieldDef[] = [
    { key: "credentialsRef", label: "Credentials Ref", type: "text", required: true, placeholder: "mt5-main" },
    { key: "maxDailyLoss", label: "Max Daily Loss", type: "number", required: true },
    { key: "maxConcurrentPositions", label: "Max Concurrent Positions", type: "number", required: true },
    { key: "maxLeverage", label: "Max Leverage", type: "number", required: true },
    { key: "allowedInstruments", label: "Allowed Instruments", type: "array", required: true, placeholder: "EURUSD, GBPUSD" },
    { key: "tradingHours.start", label: "Trading Hours Start", type: "text", required: true, placeholder: "08:00" },
    { key: "tradingHours.end", label: "Trading Hours End", type: "text", required: true, placeholder: "16:00" },
    { key: "tradingHours.timezone", label: "Trading Hours Timezone", type: "text", required: true, placeholder: "UTC" },
    { key: "emergencyFlattenThreshold", label: "Emergency Flatten Threshold", type: "number", required: true },
]

const VENUE_FIELDS: Record<VenueApp, FieldDef[]> = {
    "alpaca-options": ALPACA_FIELDS,
    "polymarket": POLYMARKET_FIELDS,
    "mt5": MT5_FIELDS,
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

    if (parts.length === 1) {
        result[parts[0]] = value
        return result
    }

    const parentPath = parts.slice(0, -1)
    const leafKey = parts[parts.length - 1]

    let parent: Record<string, unknown> = result
    for (let i = 0; i < parentPath.length; i++) {
        const key = parentPath[i]
        parent[key] = { ...(parent[key] as Record<string, unknown> || {}) }
        parent = parent[key] as Record<string, unknown>
    }
    parent[leafKey] = value

    return result
}

function parseArrayValue(value: string): string[] {
    return value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
}

function formatArrayValue(value: unknown): string {
    if (Array.isArray(value)) return value.join(", ")
    return ""
}

function PolicyField({
    field,
    value,
    onChange,
}: {
    field: FieldDef
    value: unknown
    onChange: (value: unknown) => void
}) {
    if (field.type === "boolean") {
        return (
            <div className="flex items-center justify-between">
                <div>
                    <Label className="text-sm">{field.label}</Label>
                    {field.description ? (
                        <p className="text-xs text-muted-foreground mt-0.5">{field.description}</p>
                    ) : null}
                </div>
                <Switch
                    checked={value === true}
                    onCheckedChange={(checked) => onChange(checked)}
                />
            </div>
        )
    }

    if (field.type === "number") {
        return (
            <div className="space-y-1.5">
                <Label className="text-sm">
                    {field.label}
                    {field.required ? <span className="text-signal-danger ml-0.5">*</span> : null}
                </Label>
                {field.description ? (
                    <p className="text-xs text-muted-foreground">{field.description}</p>
                ) : null}
                <Input
                    type="number"
                    step="any"
                    placeholder={field.placeholder}
                    value={value !== undefined && value !== null ? String(value) : ""}
                    onChange={(e) => {
                        const v = e.target.value
                        onChange(v === "" ? undefined : Number(v))
                    }}
                />
            </div>
        )
    }

    if (field.type === "array") {
        return (
            <div className="space-y-1.5">
                <Label className="text-sm">
                    {field.label}
                    {field.required ? <span className="text-signal-danger ml-0.5">*</span> : null}
                </Label>
                <Input
                    placeholder={field.placeholder}
                    value={formatArrayValue(value)}
                    onChange={(e) => onChange(parseArrayValue(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">Comma-separated values</p>
            </div>
        )
    }

    return (
        <div className="space-y-1.5">
            <Label className="text-sm">
                {field.label}
                {field.required ? <span className="text-signal-danger ml-0.5">*</span> : null}
            </Label>
            {field.description ? (
                <p className="text-xs text-muted-foreground">{field.description}</p>
            ) : null}
            <Input
                placeholder={field.placeholder}
                value={typeof value === "string" ? value : ""}
                onChange={(e) => onChange(e.target.value)}
            />
        </div>
    )
}

export function StrategyForm({ mode, initialData }: StrategyFormProps) {
    const router = useRouter()
    const upsertStrategy = useMutation(api.mutations.upsertStrategy)
    const [saving, setSaving] = useState(false)

    const [app, setApp] = useState<VenueApp>(initialData?.app ?? "alpaca-options")
    const [name, setName] = useState(initialData?.name ?? "")
    const [enabled, setEnabled] = useState(initialData?.enabled ?? false)
    const [schedule, setSchedule] = useState(initialData?.schedule ?? "")
    const [policy, setPolicy] = useState<PolicyFields>(
        initialData?.policy ?? POLICY_DEFAULTS["alpaca-options"]
    )
    const [context, setContext] = useState(initialData?.context ?? "")

    function handleVenueChange(newApp: VenueApp) {
        setApp(newApp)
        if (mode === "create") {
            setPolicy(POLICY_DEFAULTS[newApp])
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

        setSaving(true)
        try {
            const strategyId = await upsertStrategy({
                id: mode === "edit" ? initialData?.id : undefined,
                app,
                name: name.trim(),
                enabled,
                schedule: schedule.trim(),
                policy: cleanPolicy(policy),
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

    const venueFields = VENUE_FIELDS[app]
    const allPolicyFields = [...BASE_FIELDS, ...venueFields]

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
                            onValueChange={(v) => handleVenueChange(v as VenueApp)}
                            disabled={mode === "edit"}
                        >
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {(Object.entries(VENUE_META) as [VenueApp, typeof VENUE_META[VenueApp]][]).map(
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

                    <div className="space-y-1.5">
                        <Label className="text-sm">
                            Schedule (cron)<span className="text-signal-danger ml-0.5">*</span>
                        </Label>
                        <Input
                            placeholder="e.g. 0 14 * * 1-5"
                            value={schedule}
                            onChange={(e) => setSchedule(e.target.value)}
                            className="font-mono"
                        />
                        <p className="text-xs text-muted-foreground">Standard cron expression (minute hour day month weekday)</p>
                    </div>

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
                    {allPolicyFields.map((field) => (
                        <PolicyField
                            key={field.key}
                            field={field}
                            value={getNestedValue(policy, field.key)}
                            onChange={(v) => handlePolicyFieldChange(field.key, v)}
                        />
                    ))}
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
