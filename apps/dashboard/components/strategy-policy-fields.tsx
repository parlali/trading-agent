"use client"

import type { ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

export type PolicyFields = Record<string, unknown>

export type PolicyFieldChange = (fieldKey: string, value: unknown) => void

export function getNestedValue(obj: PolicyFields, path: string): unknown {
    const parts = path.split(".")
    let current: unknown = obj
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== "object") return undefined
        current = (current as Record<string, unknown>)[part]
    }
    return current
}

export function setNestedValue(obj: PolicyFields, path: string, value: unknown): PolicyFields {
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

export function formatPolicyValue(value: unknown): string {
    return value === undefined || value === null ? "" : String(value)
}

export function parseOptionalNumber(value: string): number | undefined {
    return value === "" ? undefined : Number(value)
}

function parseTextValue(value: string): string {
    return value
}

export function parseStringList(value: string, transform: (value: string) => string = (item) => item): string[] {
    return value
        .split(/[\n,]+/)
        .map((item) => transform(item.trim()))
        .filter(Boolean)
}

export function policyStringListValue(value: unknown): string {
    return Array.isArray(value) ? value.join("\n") : ""
}

function PolicyFieldLabel({
    children,
    className,
    required,
}: {
    children: ReactNode
    className: string
    required?: boolean
}) {
    return (
        <Label className={className}>
            {children}
            {required ? <span className="text-signal-danger ml-0.5">*</span> : null}
        </Label>
    )
}

type PolicyInputFieldProps = {
    label: ReactNode
    fieldKey: string
    value: unknown
    onChange: PolicyFieldChange
    description?: string
    labelClassName?: string
    inputClassName?: string
    required?: boolean
    step?: string | number
    min?: number
    max?: number
    placeholder?: string
}

function PolicyInputField({
    label,
    fieldKey,
    value,
    onChange,
    description,
    labelClassName = "text-sm",
    inputClassName,
    required,
    step = "any",
    min,
    max,
    placeholder,
    inputType,
    parseValue,
}: PolicyInputFieldProps & {
    inputType?: "number" | "text"
    parseValue: (value: string) => unknown
}) {
    return (
        <div className="space-y-1.5">
            <PolicyFieldLabel className={labelClassName} required={required}>
                {label}
            </PolicyFieldLabel>
            <Input
                type={inputType}
                step={step}
                min={min}
                max={max}
                placeholder={placeholder}
                value={formatPolicyValue(value)}
                onChange={(e) => onChange(fieldKey, parseValue(e.target.value))}
                className={inputClassName}
            />
            {description ? (
                <p className="text-xs text-muted-foreground">
                    {description}
                </p>
            ) : null}
        </div>
    )
}

export function NumberPolicyField(props: PolicyInputFieldProps) {
    return (
        <PolicyInputField
            {...props}
            inputType="number"
            parseValue={parseOptionalNumber}
        />
    )
}

export function TextPolicyField(props: PolicyInputFieldProps) {
    return (
        <PolicyInputField
            {...props}
            inputType="text"
            parseValue={parseTextValue}
        />
    )
}

export function SwitchPolicyField({
    label,
    fieldKey,
    checked,
    onChange,
    description,
    className = "flex items-start justify-between gap-4 rounded-lg border p-3",
    labelClassName = "text-sm",
}: {
    label: ReactNode
    fieldKey: string
    checked: boolean
    onChange: PolicyFieldChange
    description?: string
    className?: string
    labelClassName?: string
}) {
    return (
        <div className={className}>
            <div className="space-y-1">
                <Label className={labelClassName}>{label}</Label>
                {description ? (
                    <p className="text-xs text-muted-foreground">
                        {description}
                    </p>
                ) : null}
            </div>
            <Switch checked={checked} onCheckedChange={(value) => onChange(fieldKey, value)} />
        </div>
    )
}

export function TradingHoursPolicyFields({
    policy,
    onChange,
    startPlaceholder,
    endPlaceholder,
}: {
    policy: PolicyFields
    onChange: PolicyFieldChange
    startPlaceholder: string
    endPlaceholder: string
}) {
    return (
        <div className="space-y-1.5">
            <PolicyFieldLabel className="text-sm" required>
                Trading Hours
            </PolicyFieldLabel>
            <div className="flex items-center gap-2 flex-wrap">
                <Input
                    placeholder={startPlaceholder}
                    value={formatPolicyValue(getNestedValue(policy, "tradingHours.start"))}
                    onChange={(e) => onChange("tradingHours.start", e.target.value)}
                    className="w-20 sm:w-24 font-mono"
                />
                <span className="text-muted-foreground">to</span>
                <Input
                    placeholder={endPlaceholder}
                    value={formatPolicyValue(getNestedValue(policy, "tradingHours.end"))}
                    onChange={(e) => onChange("tradingHours.end", e.target.value)}
                    className="w-20 sm:w-24 font-mono"
                />
                <Input
                    placeholder="UTC"
                    value={formatPolicyValue(getNestedValue(policy, "tradingHours.timezone"))}
                    onChange={(e) => onChange("tradingHours.timezone", e.target.value)}
                    className="w-24 sm:w-28"
                />
            </div>
        </div>
    )
}
