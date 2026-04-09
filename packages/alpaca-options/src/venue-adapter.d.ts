import { type AccountState, type ExecutionResult, type OrderIntent, type PriceVerification, type PriceVerifier, type Position, type VenueAdapter, type WorkingOrder } from "@valiq-trading/core";
import { AlpacaClient, type AlpacaEquityQuote, type AlpacaEquitySnapshot, type AlpacaOptionContract, type AlpacaOptionContractsParams, type AlpacaOptionChainParams, type AlpacaOptionSnapshotsResponse } from "./alpaca-client";
export declare class AlpacaOptionsVenueAdapter implements VenueAdapter, PriceVerifier {
    private readonly client;
    constructor(client: AlpacaClient);
    getOptionsChain(underlyingSymbol: string, params?: AlpacaOptionChainParams): Promise<{
        contracts: AlpacaOptionContract[];
        snapshots: Record<string, AlpacaOptionSnapshotsResponse["snapshots"][string]>;
        nextPageToken?: string;
    }>;
    getOptionContracts(params: AlpacaOptionContractsParams): Promise<{
        contracts: AlpacaOptionContract[];
        nextPageToken?: string;
    }>;
    getOptionSnapshots(symbols: string[]): Promise<AlpacaOptionSnapshotsResponse>;
    getQuote(symbol: string): Promise<AlpacaEquityQuote>;
    getEquitySnapshot(symbol: string): Promise<AlpacaEquitySnapshot>;
    getPositions(): Promise<Position[]>;
    getAccountState(): Promise<AccountState>;
    getWorkingOrders(): Promise<WorkingOrder[]>;
    submitOrder(intent: OrderIntent): Promise<ExecutionResult>;
    cancelOrder(orderId: string): Promise<ExecutionResult>;
    modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult>;
    buildCloseIntent(instrument: string): Promise<OrderIntent>;
    closePosition(instrument: string, preparedIntent?: OrderIntent): Promise<ExecutionResult>;
    getOrderStatus(orderId: string): Promise<ExecutionResult>;
    verify(intent: OrderIntent): Promise<PriceVerification>;
}
//# sourceMappingURL=venue-adapter.d.ts.map