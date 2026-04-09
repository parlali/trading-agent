import Holidays from "date-holidays";
const HOLIDAY_TYPES = ["bank", "public"];
const REGION_ALIASES = {
    EU: ["DE", "FR", "IT", "ES", "NL"],
};
export class HolidayGuard {
    calendars = new Map();
    checkRegions(regions, date = new Date()) {
        const matches = this.findMatches(regions, date);
        if (matches.length === 0) {
            return { isHoliday: false };
        }
        return {
            isHoliday: true,
            reason: matches.map((match) => formatHolidayMatch(match)).join(", "),
        };
    }
    checkInstrumentRegions(instrumentRegions, date = new Date()) {
        const instrumentMatches = Object.entries(instrumentRegions).flatMap(([instrument, regions]) => {
            const matches = this.findMatches(regions, date);
            if (matches.length === 0) {
                return [];
            }
            return [`${instrument}: ${matches.map((match) => formatHolidayMatch(match)).join(", ")}`];
        });
        if (instrumentMatches.length === 0) {
            return { isHoliday: false };
        }
        return {
            isHoliday: true,
            reason: instrumentMatches.join(" | "),
        };
    }
    findMatches(regions, date) {
        const matches = [];
        for (const region of [...new Set(regions.map((value) => value.trim().toUpperCase()).filter(Boolean))]) {
            for (const country of expandRegion(region)) {
                const holidays = this.getCalendar(country).isHoliday(date);
                if (!holidays || holidays.length === 0) {
                    continue;
                }
                matches.push({
                    region,
                    country,
                    holidayName: holidays[0].name,
                });
                break;
            }
        }
        return matches;
    }
    getCalendar(country) {
        const normalizedCountry = country.trim().toUpperCase();
        const cached = this.calendars.get(normalizedCountry);
        if (cached) {
            return cached;
        }
        const calendar = new Holidays(normalizedCountry, {
            types: [...HOLIDAY_TYPES],
        });
        this.calendars.set(normalizedCountry, calendar);
        return calendar;
    }
}
function expandRegion(region) {
    return REGION_ALIASES[region] ?? [region];
}
function formatHolidayMatch(match) {
    const scope = match.region === match.country
        ? match.region
        : `${match.region}/${match.country}`;
    return `${scope} ${match.holidayName}`;
}
