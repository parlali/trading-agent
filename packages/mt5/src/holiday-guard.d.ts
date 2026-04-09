export interface HolidayCheckResult {
    isHoliday: boolean;
    reason?: string;
}
export declare class HolidayGuard {
    private readonly calendars;
    checkRegions(regions: readonly string[], date?: Date): HolidayCheckResult;
    checkInstrumentRegions(instrumentRegions: Record<string, readonly string[]>, date?: Date): HolidayCheckResult;
    private findMatches;
    private getCalendar;
}
//# sourceMappingURL=holiday-guard.d.ts.map