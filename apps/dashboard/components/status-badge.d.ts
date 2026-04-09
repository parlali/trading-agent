type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";
declare const STATUS_MAPS: {
    readonly run: Record<string, BadgeVariant>;
    readonly health: Record<string, BadgeVariant>;
    readonly event: Record<string, BadgeVariant>;
};
type StatusCategory = keyof typeof STATUS_MAPS;
declare function getStatusBadgeVariant(status: string, category: StatusCategory, fallback?: BadgeVariant): BadgeVariant;
export declare function StatusBadge({ status, category, fallback, className, children, }: {
    status: string;
    category: StatusCategory;
    fallback?: BadgeVariant;
    className?: string;
    children?: React.ReactNode;
}): import("react").JSX.Element;
export { getStatusBadgeVariant };
export type { StatusCategory, BadgeVariant };
//# sourceMappingURL=status-badge.d.ts.map