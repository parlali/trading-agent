import type { Id } from "@valiq-trading/convex";
type DeleteStrategyDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    strategyId: Id<"strategies">;
    strategyName: string;
    onDeleted: () => void;
};
export declare function DeleteStrategyDialog({ open, onOpenChange, strategyId, strategyName, onDeleted, }: DeleteStrategyDialogProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=delete-strategy-dialog.d.ts.map