export interface SummaryMetadata {
    nextRunInMinutes?: number;
}
export declare function parseSummaryMetadata(summary: string): SummaryMetadata | null;
export declare function stripMetadataBlock(summary: string): string;
//# sourceMappingURL=summary-metadata.d.ts.map