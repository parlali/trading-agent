export declare function useDashboardOverview(): {
    data: {
        systemState: {
            _id: import("convex/values").GenericId<"system_state">;
            _creationTime: number;
            updatedBy?: string | undefined;
            key: "kill_switches";
            updatedAt: number;
            globalKillSwitch: boolean;
            appKillSwitches: {
                binance_futures?: boolean | undefined;
                polymarket: boolean;
                mt5: boolean;
                alpaca_options: boolean;
            };
        } | {
            globalKillSwitch: false;
            appKillSwitches: {
                alpaca_options: false;
                polymarket: false;
                mt5: false;
                binance_futures: false;
            };
            updatedAt: number;
        };
        appHealth: {
            _id: import("convex/values").GenericId<"app_heartbeats">;
            _creationTime: number;
            metadata?: any;
            app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend";
            status: "healthy" | "degraded" | "unhealthy";
            lastHeartbeat: number;
        }[];
        accountSnapshots: {
            _id: import("convex/values").GenericId<"account_snapshots">;
            _creationTime: number;
            equity?: number | undefined;
            venue: string;
            timestamp: number;
            app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend";
            balance: number;
            buyingPower: number;
            marginUsed: number;
            marginAvailable: number;
            openPnl: number;
            dayPnl: number;
        }[];
        activeRuns: {
            _id: import("convex/values").GenericId<"strategy_runs">;
            _creationTime: number;
            error?: string | undefined;
            trigger?: "cron" | "manual" | "callback" | undefined;
            endedAt?: number | undefined;
            summary?: string | undefined;
            callbackRequestedMinutes?: number | undefined;
            callbackFiresAt?: number | undefined;
            strategyId: import("convex/values").GenericId<"strategies">;
            app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
            status: "running" | "completed" | "failed";
            startedAt: number;
        }[];
        recentRuns: {
            _id: import("convex/values").GenericId<"strategy_runs">;
            _creationTime: number;
            error?: string | undefined;
            trigger?: "cron" | "manual" | "callback" | undefined;
            endedAt?: number | undefined;
            summary?: string | undefined;
            callbackRequestedMinutes?: number | undefined;
            callbackFiresAt?: number | undefined;
            strategyId: import("convex/values").GenericId<"strategies">;
            app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
            status: "running" | "completed" | "failed";
            startedAt: number;
        }[];
        recentAlerts: {
            _id: import("convex/values").GenericId<"alerts">;
            _creationTime: number;
            strategyId?: import("convex/values").GenericId<"strategies"> | undefined;
            app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend" | undefined;
            message: string;
            timestamp: number;
            severity: "critical" | "warning" | "info";
            acknowledged: boolean;
        }[];
        openPositions: {
            strategy: {
                _id: import("convex/values").GenericId<"strategies">;
                _creationTime: number;
                app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
                name: string;
                enabled: boolean;
                schedule: string;
                policy: any;
                context: string;
                createdAt: number;
                updatedAt: number;
            };
            _id: import("convex/values").GenericId<"positions">;
            _creationTime: number;
            metadata?: string | undefined;
            currentPrice?: number | undefined;
            unrealizedPnl?: number | undefined;
            instrument: string;
            side: "long" | "short";
            quantity: number;
            strategyId: import("convex/values").GenericId<"strategies">;
            app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
            entryPrice: number;
            syncedAt: number;
        }[];
        strategies: {
            latestRun: {
                _id: import("convex/values").GenericId<"strategy_runs">;
                _creationTime: number;
                error?: string | undefined;
                trigger?: "cron" | "manual" | "callback" | undefined;
                endedAt?: number | undefined;
                summary?: string | undefined;
                callbackRequestedMinutes?: number | undefined;
                callbackFiresAt?: number | undefined;
                strategyId: import("convex/values").GenericId<"strategies">;
                app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
                status: "running" | "completed" | "failed";
                startedAt: number;
            } | null;
            _id: import("convex/values").GenericId<"strategies">;
            _creationTime: number;
            app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
            name: string;
            enabled: boolean;
            schedule: string;
            policy: any;
            context: string;
            createdAt: number;
            updatedAt: number;
        }[];
    } | undefined;
    isLoading: boolean;
};
//# sourceMappingURL=use-dashboard-overview.d.ts.map