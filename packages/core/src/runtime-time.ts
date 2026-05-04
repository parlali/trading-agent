export function getCurrentTimeInTimezone(timezone: string): { hours: number; minutes: number } {
    const currentInstant = new Date(Date.now())

    try {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        })
        const parts = formatter.formatToParts(currentInstant)
        const hourPart = parts.find((p) => p.type === "hour")
        const minutePart = parts.find((p) => p.type === "minute")

        return {
            hours: Number(hourPart?.value ?? 0),
            minutes: Number(minutePart?.value ?? 0),
        }
    } catch {
        return {
            hours: currentInstant.getUTCHours(),
            minutes: currentInstant.getUTCMinutes(),
        }
    }
}

export function padTime(n: number): string {
    return String(n).padStart(2, "0")
}

export function isWithinSessionFlatWindow(args: {
    end: string
    timezone: string
    closeBufferMinutes: number
}): {
    shouldFlatten: boolean
    currentTime: string
} {
    const now = getCurrentTimeInTimezone(args.timezone)
    const [endHour, endMinute] = args.end.split(":").map(Number) as [number, number]

    const currentMinutes = now.hours * 60 + now.minutes
    const endMinutes = endHour * 60 + endMinute
    const flattenMinutes = endMinutes - args.closeBufferMinutes
    const shouldFlatten = currentMinutes >= flattenMinutes && currentMinutes < endMinutes

    return {
        shouldFlatten,
        currentTime: `${padTime(now.hours)}:${padTime(now.minutes)}`,
    }
}
