import type { Id } from "@valiq-trading/convex";
import { type ActiveVenueApp } from "@/lib/constants";
type PolicyFields = Record<string, unknown>;
type StrategyFormData = {
    app: ActiveVenueApp;
    name: string;
    enabled: boolean;
    schedule: string;
    policy: PolicyFields;
    context: string;
};
type StrategyFormProps = {
    mode: "create" | "edit";
    initialData?: StrategyFormData & {
        id: Id<"strategies">;
    };
};
export declare function StrategyForm({ mode, initialData }: StrategyFormProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=strategy-form.d.ts.map