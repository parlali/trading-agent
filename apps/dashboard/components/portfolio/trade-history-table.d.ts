export type PortfolioTradeRow = {
    eventId: string;
    timestamp: number;
    app: string;
    strategyId: string;
    strategyName: string;
    runId: string;
    orderId?: string;
    instrument?: string;
    eventType: string;
    action?: string;
    status?: string;
    side?: string;
    quantity?: number;
    filledQuantity?: number;
    price?: number;
    summary: string;
};
export declare function TradeHistoryTable({ trades, title, }: {
    trades: PortfolioTradeRow[];
    title?: string;
}): import("react").JSX.Element;
//# sourceMappingURL=trade-history-table.d.ts.map