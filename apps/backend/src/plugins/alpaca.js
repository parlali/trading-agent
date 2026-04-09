import { ALPACA_RUNTIME_SECRET_KEYS, AlpacaClient, alpacaRiskValidators, AlpacaOptionsVenueAdapter, resolveAlpacaRuntimeConfig, } from "@valiq-trading/alpaca-options";
import { createOAuthTokenProvider, createValiqDataTool, createValiqResearchTool, getMissingValiqDataApiSecrets, resolveValiqDataApiConfig, ValiqClient, ValiqDataAdapter, ValiqDataClient, ValiqResearchAdapter, } from "@valiq-trading/valiq";
export class AlpacaPlugin {
    app = "alpaca-options";
    venueName = "alpaca";
    environment;
    resolveSecretKeys() {
        return [
            ...ALPACA_RUNTIME_SECRET_KEYS,
            "VALIQ_API_URL",
            "VALIQ_AUTH_URL",
            "VALIQ_OAUTH_CLIENT_ID",
            "VALIQ_OAUTH_CLIENT_SECRET",
            "VALIQ_OAUTH_USER_UUID",
            "VALIQ_DATA_API_URL",
            "VALIQ_DATA_API",
        ];
    }
    resolveAdditionalSecretKeys(_policy) {
        return [];
    }
    async validateEnvironment(secrets) {
        const runtimeConfig = resolveAlpacaRuntimeConfig(secrets);
        this.environment = runtimeConfig.environment;
        const client = new AlpacaClient(runtimeConfig);
        await client.getAccount();
        await client.getOptionContracts({
            underlyingSymbol: "SPY",
            limit: 1,
        });
        await client.getLatestEquityQuote("SPY");
    }
    createVenueAdapter(_policy, secrets) {
        const runtimeConfig = resolveAlpacaRuntimeConfig(secrets);
        const client = new AlpacaClient(runtimeConfig);
        return new AlpacaOptionsVenueAdapter(client);
    }
    getRiskValidators() {
        return alpacaRiskValidators;
    }
    getExtraTools(config) {
        const tools = [];
        const valiqUrl = config.secrets.VALIQ_API_URL;
        const authUrl = config.secrets.VALIQ_AUTH_URL;
        const clientId = config.secrets.VALIQ_OAUTH_CLIENT_ID;
        const clientSecret = config.secrets.VALIQ_OAUTH_CLIENT_SECRET;
        const userUuid = config.secrets.VALIQ_OAUTH_USER_UUID;
        if (valiqUrl && authUrl && clientId && clientSecret && userUuid) {
            const tokenProvider = createOAuthTokenProvider({
                authUrl,
                clientId,
                clientSecret,
                userUuid,
                logger: config.runLogger,
            });
            const valiqClient = new ValiqClient({
                apiUrl: valiqUrl,
                tokenProvider,
                logger: config.runLogger,
            });
            const research = new ValiqResearchAdapter(valiqClient, config.runLogger);
            tools.push(createValiqResearchTool(research));
        }
        const dataApi = resolveValiqDataApiConfig(config.secrets);
        if (dataApi) {
            const dataClient = new ValiqDataClient({
                apiUrl: dataApi.apiUrl,
                apiKey: dataApi.apiKey,
                logger: config.runLogger,
            });
            const data = new ValiqDataAdapter(dataClient);
            tools.push(createValiqDataTool(data));
        }
        else {
            const missing = getMissingValiqDataApiSecrets(config.secrets);
            if (missing.length > 0) {
                config.runLogger.warn("Valiq data tools NOT registered: missing secrets", { missing });
            }
        }
        return tools;
    }
    getEnvironment() {
        return this.environment;
    }
}
