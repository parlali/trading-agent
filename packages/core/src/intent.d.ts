import type { OrderIntent } from "./types";
import type { OrderAction } from "./orders";
export declare const getIntentAction: (intent: OrderIntent, fallback?: OrderAction) => OrderAction;
export declare const hasIntentChanges: (changes: Partial<OrderIntent>) => boolean;
export declare const createSyntheticIntent: (action: OrderAction, instrument: string, side: "buy" | "sell", quantity: number, orderId?: string, metadata?: Record<string, unknown>) => OrderIntent;
//# sourceMappingURL=intent.d.ts.map