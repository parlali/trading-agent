"use client"

import { useState, useRef, useCallback } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"

type RunMode = "interval" | "fixed-time"
type IntervalUnit = "minutes" | "hours"
type DayMode = "every-day" | "weekdays" | "specific-days"

type ScheduleState = {
    runMode: RunMode
    intervalUnit: IntervalUnit
    intervalValue: number
    hour: string
    minute: string
    dayMode: DayMode
    days: number[]
    hourWindowEnabled: boolean
    hourStart: string
    hourEnd: string
    isCustom: boolean
    customCron: string
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const DAY_CRON_VALUES = [1, 2, 3, 4, 5, 6, 0]

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"))
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"))

const DEFAULT_STATE: ScheduleState = {
    runMode: "fixed-time",
    intervalUnit: "minutes",
    intervalValue: 30,
    hour: "14",
    minute: "00",
    dayMode: "weekdays",
    days: [],
    hourWindowEnabled: false,
    hourStart: "09",
    hourEnd: "17",
    isCustom: false,
    customCron: "",
}

function dayModeToCronDow(state: ScheduleState): string {
    switch (state.dayMode) {
        case "every-day":
            return "*"
        case "weekdays":
            return "1-5"
        case "specific-days": {
            if (state.days.length === 0) return ""
            return state.days
                .map((i) => DAY_CRON_VALUES[i])
                .sort((a, b) => a - b)
                .join(",")
        }
    }
}

function scheduleToCron(state: ScheduleState): string {
    if (state.isCustom) return state.customCron

    const dow = dayModeToCronDow(state)
    if (!dow) return ""

    if (state.runMode === "fixed-time") {
        return `${state.minute} ${state.hour} * * ${dow}`
    }

    const intervalVal = state.intervalUnit === "minutes"
        ? Math.max(1, Math.min(59, state.intervalValue))
        : Math.max(1, Math.min(23, state.intervalValue))

    const minuteField = state.intervalUnit === "minutes" ? `*/${intervalVal}` : "0"
    const hourField = state.intervalUnit === "hours"
        ? `*/${intervalVal}`
        : state.hourWindowEnabled
            ? `${Number(state.hourStart)}-${Number(state.hourEnd)}`
            : "*"

    if (state.intervalUnit === "hours" && state.hourWindowEnabled) {
        const start = Number(state.hourStart)
        const end = Number(state.hourEnd)
        const hours: number[] = []
        for (let h = start; h <= end; h += intervalVal) {
            hours.push(h)
        }
        return `0 ${hours.join(",")} * * ${dow}`
    }

    return `${minuteField} ${hourField} * * ${dow}`
}

function cronToSchedule(cron: string): ScheduleState {
    if (!cron || !cron.trim()) return DEFAULT_STATE

    const parts = cron.trim().split(/\s+/)
    if (parts.length !== 5) return { ...DEFAULT_STATE, isCustom: true, customCron: cron }

    const [minute, hour, _dom, _month, dow] = parts as [string, string, string, string, string]

    const dayMode = parseDowToDayMode(dow)
    if (!dayMode) return { ...DEFAULT_STATE, isCustom: true, customCron: cron }

    const minuteIntervalMatch = minute.match(/^\*\/(\d+)$/)
    if (minuteIntervalMatch) {
        const hourRangeMatch = hour.match(/^(\d+)-(\d+)$/)
        return {
            ...DEFAULT_STATE,
            runMode: "interval",
            intervalUnit: "minutes",
            intervalValue: Number(minuteIntervalMatch[1]),
            dayMode: dayMode.mode,
            days: dayMode.days,
            hourWindowEnabled: !!hourRangeMatch,
            hourStart: hourRangeMatch ? String(Number(hourRangeMatch[1])).padStart(2, "0") : "09",
            hourEnd: hourRangeMatch ? String(Number(hourRangeMatch[2])).padStart(2, "0") : "17",
        }
    }

    const hourIntervalMatch = hour.match(/^\*\/(\d+)$/)
    if (hourIntervalMatch && (minute === "0" || minute === "00")) {
        return {
            ...DEFAULT_STATE,
            runMode: "interval",
            intervalUnit: "hours",
            intervalValue: Number(hourIntervalMatch[1]),
            dayMode: dayMode.mode,
            days: dayMode.days,
        }
    }

    if (minute === "0" || minute === "00") {
        const hourListMatch = hour.match(/^[\d,]+$/)
        if (hourListMatch) {
            const hours = hour.split(",").map(Number)
            if (hours.length >= 2) {
                const interval = hours[1] - hours[0]
                const isEvenlySpaced = hours.every((h, i) => i === 0 || h - hours[i - 1] === interval)
                if (isEvenlySpaced && interval >= 1) {
                    return {
                        ...DEFAULT_STATE,
                        runMode: "interval",
                        intervalUnit: "hours",
                        intervalValue: interval,
                        dayMode: dayMode.mode,
                        days: dayMode.days,
                        hourWindowEnabled: true,
                        hourStart: String(hours[0]).padStart(2, "0"),
                        hourEnd: String(hours[hours.length - 1]).padStart(2, "0"),
                    }
                }
            }
        }
    }

    if (/^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour)) {
        return {
            ...DEFAULT_STATE,
            runMode: "fixed-time",
            hour: String(Number(hour)).padStart(2, "0"),
            minute: String(Number(minute)).padStart(2, "0"),
            dayMode: dayMode.mode,
            days: dayMode.days,
        }
    }

    return { ...DEFAULT_STATE, isCustom: true, customCron: cron }
}

function parseDowToDayMode(dow: string): { mode: DayMode, days: number[] } | null {
    if (dow === "*") return { mode: "every-day", days: [] }
    if (dow === "1-5") return { mode: "weekdays", days: [] }

    const dayNumbers = dow.split(",").map(Number)
    if (dayNumbers.some(isNaN)) return null

    const dayIndices = dayNumbers
        .map((cronDay) => DAY_CRON_VALUES.indexOf(cronDay))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)

    if (dayIndices.length > 0) return { mode: "specific-days", days: dayIndices }
    return null
}

type ScheduleBuilderProps = {
    value: string
    onChange: (cron: string) => void
}

export function ScheduleBuilder({ value, onChange }: ScheduleBuilderProps) {
    const [state, setState] = useState<ScheduleState>(() => cronToSchedule(value))
    const lastEmittedCron = useRef(value)

    const emitCron = useCallback((next: ScheduleState) => {
        const cron = scheduleToCron(next)
        if (cron) {
            lastEmittedCron.current = cron
            onChange(cron)
        }
    }, [onChange])

    if (value && value !== lastEmittedCron.current) {
        lastEmittedCron.current = value
        setState(cronToSchedule(value))
    }

    function update(patch: Partial<ScheduleState>) {
        setState((prev) => {
            const next = { ...prev, ...patch }
            emitCron(next)
            return next
        })
    }

    function toggleDay(dayIndex: number) {
        setState((prev) => {
            const days = prev.days.includes(dayIndex)
                ? prev.days.filter((d) => d !== dayIndex)
                : [...prev.days, dayIndex].sort((a, b) => a - b)
            const next = { ...prev, days }
            emitCron(next)
            return next
        })
    }

    if (state.isCustom) {
        return (
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <Label className="text-sm">
                        Schedule<span className="text-signal-danger ml-0.5">*</span>
                    </Label>
                    <Input
                        placeholder="e.g. 0 14 * * 1-5"
                        className="font-mono"
                        value={state.customCron}
                        onChange={(e) => {
                            const next = { ...state, customCron: e.target.value }
                            setState(next)
                            if (e.target.value.trim().split(/\s+/).length === 5) {
                                onChange(e.target.value.trim())
                            }
                        }}
                    />
                    <p className="text-xs text-muted-foreground">
                        Standard cron expression (minute hour day month weekday)
                    </p>
                </div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => update({ isCustom: false })}
                >
                    Switch to visual editor
                </Button>
                <p className="text-xs text-muted-foreground font-mono">
                    {state.customCron || "No schedule set"}
                </p>
            </div>
        )
    }

    return (
        <div className="space-y-4">
            <div className="space-y-1.5">
                <Label className="text-sm">
                    Schedule<span className="text-signal-danger ml-0.5">*</span>
                </Label>
            </div>

            <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Run</Label>
                <Select
                    value={state.runMode}
                    onValueChange={(v) => update({ runMode: v as RunMode })}
                >
                    <SelectTrigger className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="fixed-time">At a fixed time</SelectItem>
                        <SelectItem value="interval">On a repeating interval</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {state.runMode === "interval" ? (
                <div className="space-y-3">
                    <div className="flex items-center gap-2">
                        <Label className="text-sm whitespace-nowrap">Every</Label>
                        <Input
                            type="number"
                            min={1}
                            max={state.intervalUnit === "minutes" ? 59 : 23}
                            className="w-20"
                            value={state.intervalValue}
                            onChange={(e) => update({ intervalValue: Number(e.target.value) || 1 })}
                        />
                        <Select
                            value={state.intervalUnit}
                            onValueChange={(v) => update({ intervalUnit: v as IntervalUnit })}
                        >
                            <SelectTrigger className="w-28">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="minutes">minutes</SelectItem>
                                <SelectItem value="hours">hours</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex items-center gap-3">
                        <Switch
                            checked={state.hourWindowEnabled}
                            onCheckedChange={(checked) => update({ hourWindowEnabled: checked })}
                        />
                        <Label className="text-sm">Restrict to specific hours</Label>
                    </div>

                    {state.hourWindowEnabled ? (
                        <div className="flex items-center gap-2">
                            <Label className="text-xs text-muted-foreground whitespace-nowrap">From</Label>
                            <Select
                                value={state.hourStart}
                                onValueChange={(v) => update({ hourStart: v })}
                            >
                                <SelectTrigger className="w-20">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {HOURS.map((h) => (
                                        <SelectItem key={h} value={h}>{h}:00</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Label className="text-xs text-muted-foreground whitespace-nowrap">to</Label>
                            <Select
                                value={state.hourEnd}
                                onValueChange={(v) => update({ hourEnd: v })}
                            >
                                <SelectTrigger className="w-20">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {HOURS.map((h) => (
                                        <SelectItem key={h} value={h}>{h}:00</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <span className="text-xs text-muted-foreground">UTC</span>
                        </div>
                    ) : null}
                </div>
            ) : (
                <div className="flex items-center gap-2">
                    <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Hour</Label>
                        <Select
                            value={state.hour}
                            onValueChange={(v) => update({ hour: v })}
                        >
                            <SelectTrigger className="w-20">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {HOURS.map((h) => (
                                    <SelectItem key={h} value={h}>{h}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <span className="mt-5 text-muted-foreground">:</span>
                    <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Minute</Label>
                        <Select
                            value={state.minute}
                            onValueChange={(v) => update({ minute: v })}
                        >
                            <SelectTrigger className="w-20">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {MINUTES.map((m) => (
                                    <SelectItem key={m} value={m}>{m}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <span className="mt-5 text-xs text-muted-foreground">UTC</span>
                </div>
            )}

            <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Days</Label>
                <Select
                    value={state.dayMode}
                    onValueChange={(v) => update({ dayMode: v as DayMode })}
                >
                    <SelectTrigger className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="every-day">Every day</SelectItem>
                        <SelectItem value="weekdays">Weekdays (Mon-Fri)</SelectItem>
                        <SelectItem value="specific-days">Specific days</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {state.dayMode === "specific-days" ? (
                <div className="flex gap-1.5">
                    {DAY_LABELS.map((label, index) => (
                        <Button
                            key={label}
                            type="button"
                            size="sm"
                            variant={state.days.includes(index) ? "default" : "outline"}
                            className="h-8 w-10 px-0 text-xs"
                            onClick={() => toggleDay(index)}
                        >
                            {label}
                        </Button>
                    ))}
                </div>
            ) : null}

            <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground font-mono">
                    {scheduleToCron(state) || "No schedule set"}
                </p>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground h-auto py-1"
                    onClick={() => update({ isCustom: true, customCron: scheduleToCron(state) })}
                >
                    Edit as cron
                </Button>
            </div>
        </div>
    )
}
