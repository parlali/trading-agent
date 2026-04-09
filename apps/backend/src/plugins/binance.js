import { BINANCE_RUNTIME_SECRET_KEYS, BinanceClient, BinanceVenueAdapter, binanceRiskValidators, createBinanceMarketContextLine, resolveBinanceCredentials, } from "@valiq-trading/binance";
import { createValiqBreakingNewsTool, createValiqDataTool, createValiqResearchTool, createOAuthTokenProvider, getMissingValiqDataApiSecrets, ValiqClient, ValiqDataAdapter, ValiqDataClient, ValiqResearchAdapter, resolveValiqDataApiConfig, } from "@valiq-trading/valiq";
import { getCurrentTimeInTimezone, padTime, binancePolicySchema, } from "@valiq-trading/core";
export class BinancePlugin {
    app = "binance-futures";
    venueName = "binance-futures";
    resolveSecretKeys() {
        return [
            ...BINANCE_RUNTIME_SECRET_KEYS,
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
        const credentials = resolveBinanceCredentials(secrets);
        const client = new BinanceClient(credentials);
        await client.ping();
        await client.getAccount();
    }
    createVenueAdapter(_policy, secrets) {
        const credentials = resolveBinanceCredentials(secrets);
        const client = new BinanceClient(credentials);
        return new BinanceVenueAdapter(client);
    }
    getRiskValidators() {
        return binanceRiskValidators;
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
            tools.push(createValiqBreakingNewsTool(data));
        }
        else {
            const missing = getMissingValiqDataApiSecrets(config.secrets);
            if (missing.length > 0) {
                config.runLogger.warn("Valiq data tools NOT registered: missing secrets", { missing });
            }
        }
        return tools;
    }
    async preRunHooks(config) {
        const venue = config.venue;
        const policy = binancePolicySchema.parse(config.policy);
        const emergencyFlattened = await this.checkEmergencyFlatten(venue, policy, config.strategyId, config);
        if (emergencyFlattened) {
            return { skip: true, reason: "Emergency flatten executed" };
        }
        const eodFlattened = await this.checkEndOfSessionFlatten(venue, policy, config.strategyId, config);
        if (eodFlattened) {
            return { skip: true, reason: "End-of-session flatten executed" };
        }
        const runtimeContextLines = await this.buildRuntimeContextLines(venue, policy, config);
        return {
            skip: false,
            runtimeContextLines,
        };
    }
    async postRunHooks(config) {
        const venue = config.venue;
        const policy = binancePolicySchema.parse(config.policy);
        await this.checkEmergencyFlatten(venue, policy, config.strategyId, config);
    }
    async checkEmergencyFlatten(venue, policy, strategyId, config) {
        const accountState = await venue.getAccountState();
        if (accountState.openPnl < 0 && Math.abs(accountState.openPnl) >= policy.emergencyFlattenThreshold) {
            config.logger.error("Binance emergency flatten triggered", {
                strategyId,
                openPnl: accountState.openPnl,
                threshold: policy.emergencyFlattenThreshold,
            });
            await config.createAlert({
                strategyId,
                app: this.app,
                severity: "critical",
                message: `Binance emergency flatten triggered: unrealized loss ${Math.abs(accountState.openPnl).toFixed(2)} exceeds threshold ${policy.emergencyFlattenThreshold}`,
            });
            const result = await venue.closeAllPositions();
            config.logger.info("Binance emergency flatten completed", {
                strategyId,
                closed: result.closed,
            });
            return true;
        }
        return false;
    }
    async checkEndOfSessionFlatten(venue, policy, strategyId, config) {
        const { end, timezone } = policy.tradingHours;
        const now = getCurrentTimeInTimezone(timezone);
        const [endHour, endMinute] = end.split(":").map(Number);
        const currentMinutes = now.hours * 60 + now.minutes;
        const endMinutes = endHour * 60 + endMinute;
        const flattenMinutes = endMinutes - 15;
        const shouldFlatten = currentMinutes >= flattenMinutes && currentMinutes < endMinutes;
        if (!shouldFlatten) {
            return false;
        }
        const positions = await venue.getPositions();
        if (positions.length === 0) {
            return false;
        }
        config.logger.warn("Binance end-of-session flatten triggered", {
            strategyId,
            currentTime: `${padTime(now.hours)}:${padTime(now.minutes)}`,
            endTime: end,
            openPositions: positions.length,
        });
        await config.createAlert({
            strategyId,
            app: this.app,
            severity: "warning",
            message: `Binance end-of-session flatten: closing ${positions.length} position(s) before ${end} ${timezone}`,
        });
        const result = await venue.closeAllPositions();
        config.logger.info("Binance end-of-session flatten completed", {
            strategyId,
            closed: result.closed,
        });
        return true;
    }
    async buildRuntimeContextLines(venue, policy, config) {
        try {
            const snapshots = await venue.getMarketSnapshot(policy.allowedInstruments);
            const contextLine = createBinanceMarketContextLine(snapshots);
            if (!contextLine) {
                return undefined;
            }
            config.logger.info("Collected Binance market context", {
                strategyId: config.strategyId,
                contextLine,
            });
            return [contextLine];
        }
        catch (error) {
            config.logger.warn("Failed to collect Binance market context", {
                strategyId: config.strategyId,
                error: error instanceof Error ? error.message : String(error),
            });
            return [
                "Binance market context unavailable for this run. Manage existing positions conservatively and avoid new entries unless risk-reward is exceptional.",
            ];
        }
    }
}
