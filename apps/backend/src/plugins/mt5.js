import { createOAuthTokenProvider, createValiqDataTool, createValiqResearchTool, getMissingValiqDataApiSecrets, resolveValiqDataApiConfig, ValiqClient, ValiqDataAdapter, ValiqDataClient, ValiqResearchAdapter, } from "@valiq-trading/valiq";
import { getCurrentTimeInTimezone, mt5PolicySchema, padTime, } from "@valiq-trading/core";
import { createMT5SpreadContextLine, HolidayGuard, MT5Client, MT5_RUNTIME_SECRET_KEYS, mt5RiskValidators, resolveMT5RuntimeConfig, MT5VenueAdapter, resolveMT5InstrumentRegions, } from "@valiq-trading/mt5";
export class MT5Plugin {
    app = "mt5";
    venueName = "mt5";
    holidayGuard = new HolidayGuard();
    resolveSecretKeys() {
        return [
            ...MT5_RUNTIME_SECRET_KEYS,
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
        const runtimeConfig = resolveMT5RuntimeConfig(secrets);
        const client = new MT5Client({
            workerUrl: runtimeConfig.workerUrl,
            accessKey: runtimeConfig.accessKey,
        });
        await client.getHealth();
        await client.connect(runtimeConfig.credentials);
    }
    createVenueAdapter(_policy, secrets) {
        const resolved = resolveMT5RuntimeConfig(secrets);
        const client = new MT5Client({
            workerUrl: resolved.workerUrl,
            accessKey: resolved.accessKey,
        });
        return new MT5VenueAdapter(client, resolved.credentials);
    }
    getRiskValidators() {
        return mt5RiskValidators;
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
    async preRunHooks(config) {
        const mt5Venue = config.venue;
        const parsedPolicy = mt5PolicySchema.parse(config.policy);
        const emergencyFlattened = await this.checkEmergencyFlatten(mt5Venue, parsedPolicy, config.strategyId, config);
        if (emergencyFlattened) {
            return { skip: true, reason: "Emergency flatten executed" };
        }
        const eodFlattened = await this.checkEndOfDayFlatten(mt5Venue, parsedPolicy, config.strategyId, config);
        if (eodFlattened) {
            return { skip: true, reason: "End-of-day flatten executed" };
        }
        const instrumentRegions = resolveMT5InstrumentRegions(parsedPolicy);
        try {
            const holidayCheck = this.holidayGuard.checkInstrumentRegions(instrumentRegions);
            if (holidayCheck.isHoliday) {
                config.logger.warn("Market holiday guard skipped MT5 run", {
                    strategyId: config.strategyId,
                    reason: holidayCheck.reason,
                    instrumentRegions,
                });
                return {
                    skip: true,
                    reason: `Market holiday: ${holidayCheck.reason}`,
                };
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            config.logger.warn("Holiday guard failed for MT5 run", {
                strategyId: config.strategyId,
                instrumentRegions,
                error: message,
            });
            return {
                skip: true,
                reason: `Holiday guard failed: ${message}`,
            };
        }
        const runtimeContextLines = await this.buildRuntimeContextLines(mt5Venue, instrumentRegions, config);
        return { skip: false, runtimeContextLines };
    }
    async postRunHooks(config) {
        const mt5Venue = config.venue;
        const parsedPolicy = mt5PolicySchema.parse(config.policy);
        await this.checkEmergencyFlatten(mt5Venue, parsedPolicy, config.strategyId, config);
    }
    async checkEmergencyFlatten(venue, policy, strategyId, config) {
        const accountState = await venue.getAccountState();
        if (accountState.openPnl < 0 && Math.abs(accountState.openPnl) >= policy.emergencyFlattenThreshold) {
            config.logger.error("Emergency flatten triggered", {
                strategyId,
                openPnl: accountState.openPnl,
                threshold: policy.emergencyFlattenThreshold,
            });
            await config.createAlert({
                strategyId,
                app: this.app,
                severity: "critical",
                message: `Emergency flatten triggered: unrealized loss ${Math.abs(accountState.openPnl).toFixed(2)} exceeds threshold ${policy.emergencyFlattenThreshold}`,
            });
            const result = await venue.closeAllPositions();
            config.logger.info("Emergency flatten completed", {
                closed: result.closed,
                results: result.results.map((r) => ({
                    orderId: r.orderId,
                    status: r.status,
                })),
            });
            return true;
        }
        return false;
    }
    async checkEndOfDayFlatten(venue, policy, strategyId, config) {
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
        config.logger.warn("End-of-day flatten triggered", {
            strategyId,
            currentTime: `${padTime(now.hours)}:${padTime(now.minutes)}`,
            endTime: end,
            openPositions: positions.length,
        });
        await config.createAlert({
            strategyId,
            app: this.app,
            severity: "warning",
            message: `End-of-day flatten: closing ${positions.length} position(s) before ${end} ${timezone}`,
        });
        const result = await venue.closeAllPositions();
        config.logger.info("End-of-day flatten completed", { closed: result.closed });
        return true;
    }
    async buildRuntimeContextLines(venue, instrumentRegions, config) {
        const instruments = Object.keys(instrumentRegions);
        if (instruments.length === 0) {
            return undefined;
        }
        try {
            const snapshots = await venue.getMarketSnapshot(instruments);
            const received = new Set(snapshots.map((snapshot) => snapshot.instrument));
            const missing = instruments.filter((instrument) => !received.has(instrument));
            if (missing.length > 0) {
                config.logger.warn("MT5 spread data is incomplete for this run", {
                    strategyId: config.strategyId,
                    requested: instruments,
                    received: [...received],
                    missing,
                });
                return [
                    `Spread data unavailable for: ${missing.join(", ")}. Sit out unless a later run provides complete liquidity context.`,
                ];
            }
            const spreadContextLine = createMT5SpreadContextLine(snapshots);
            if (!spreadContextLine) {
                return undefined;
            }
            config.logger.info("Collected MT5 spread context", {
                strategyId: config.strategyId,
                spreadContextLine,
            });
            return [spreadContextLine];
        }
        catch (error) {
            config.logger.warn("Failed to collect MT5 spread context", {
                strategyId: config.strategyId,
                error: error instanceof Error ? error.message : String(error),
            });
            return [
                "Spread data unavailable for this run. Trade only if an open position requires active management.",
            ];
        }
    }
}
