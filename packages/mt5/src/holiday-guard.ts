import Holidays from "date-holidays"

const HOLIDAY_TYPES = ["bank", "public"] as const

const REGION_ALIASES: Record<string, string[]> = {
    EU: ["DE", "FR", "IT", "ES", "NL"],
}

export interface HolidayCheckResult {
    isHoliday: boolean
    reason?: string
}

interface HolidayMatch {
    region: string
    country: string
    holidayName: string
}

export class HolidayGuard {
    private readonly calendars = new Map<string, Holidays>()

    checkRegions(regions: readonly string[], date = new Date()): HolidayCheckResult {
        const matches = this.findMatches(regions, date)
        if (matches.length === 0) {
            return { isHoliday: false }
        }

        return {
            isHoliday: true,
            reason: matches.map((match) => formatHolidayMatch(match)).join(", "),
        }
    }

    checkInstrumentRegions(
        instrumentRegions: Record<string, readonly string[]>,
        date = new Date()
    ): HolidayCheckResult {
        const instrumentMatches = Object.entries(instrumentRegions).flatMap(([instrument, regions]) => {
            const matches = this.findMatches(regions, date)
            if (matches.length === 0) {
                return []
            }

            return [`${instrument}: ${matches.map((match) => formatHolidayMatch(match)).join(", ")}`]
        })

        if (instrumentMatches.length === 0) {
            return { isHoliday: false }
        }

        return {
            isHoliday: true,
            reason: instrumentMatches.join(" | "),
        }
    }

    private findMatches(regions: readonly string[], date: Date): HolidayMatch[] {
        const matches: HolidayMatch[] = []

        for (const region of [...new Set(regions.map((value) => value.trim().toUpperCase()).filter(Boolean))]) {
            for (const country of expandRegion(region)) {
                const holidays = this.getCalendar(country).isHoliday(date)
                if (!holidays || holidays.length === 0) {
                    continue
                }

                matches.push({
                    region,
                    country,
                    holidayName: holidays[0]!.name,
                })
                break
            }
        }

        return matches
    }

    private getCalendar(country: string): Holidays {
        const normalizedCountry = country.trim().toUpperCase()
        const cached = this.calendars.get(normalizedCountry)
        if (cached) {
            return cached
        }

        const calendar = new Holidays(normalizedCountry, {
            types: [...HOLIDAY_TYPES],
        })
        this.calendars.set(normalizedCountry, calendar)
        return calendar
    }
}

function expandRegion(region: string): string[] {
    return REGION_ALIASES[region] ?? [region]
}

function formatHolidayMatch(match: HolidayMatch): string {
    const scope = match.region === match.country
        ? match.region
        : `${match.region}/${match.country}`

    return `${scope} ${match.holidayName}`
}
