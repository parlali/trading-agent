import { PolymarketClient, polymarketRiskValidators, POLYMARKET_RUNTIME_SECRET_KEYS, PolymarketVenueAdapter, resolvePolymarketCredentials, } from "@valiq-trading/polymarket";
import { createValiqBreakingNewsTool, VALIQ_DATA_SECRET_KEYS, getMissingValiqDataApiSecrets, resolveValiqDataApiConfig, ValiqDataClient, ValiqDataAdapter, } from "@valiq-trading/valiq";
export class PolymarketPlugin {
    app = "polymarket";
    venueName = "polymarket";
    resolveSecretKeys() {
        return [
            ...POLYMARKET_RUNTIME_SECRET_KEYS,
            ...VALIQ_DATA_SECRET_KEYS,
        ];
    }
    resolveAdditionalSecretKeys(_policy) {
        return [];
    }
    async validateEnvironment(secrets) {
        const credentials = resolvePolymarketCredentials(secrets);
        const client = new PolymarketClient(credentials);
        await client.getBalance();
        await client.getOpenOrders();
    }
    createVenueAdapter(_policy, secrets) {
        const credentials = resolvePolymarketCredentials(secrets);
        const client = new PolymarketClient(credentials);
        return new PolymarketVenueAdapter(client);
    }
    getRiskValidators() {
        return polymarketRiskValidators;
    }
    getExtraTools(config) {
        const dataApi = resolveValiqDataApiConfig(config.secrets);
        if (!dataApi) {
            const missing = getMissingValiqDataApiSecrets(config.secrets);
            config.runLogger.warn("Valiq tools NOT registered: missing secrets", { missing });
            return [];
        }
        const dataClient = new ValiqDataClient({
            apiUrl: dataApi.apiUrl,
            apiKey: dataApi.apiKey,
            logger: config.runLogger,
        });
        const data = new ValiqDataAdapter(dataClient);
        return [
            createValiqBreakingNewsTool(data),
        ];
    }
}
