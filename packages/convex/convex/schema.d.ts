declare const _default: import("convex/server").SchemaDefinition<{
    strategies: import("convex/server").TableDefinition<import("convex/values").VObject<{
        app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
        name: string;
        enabled: boolean;
        schedule: string;
        policy: any;
        context: string;
        createdAt: number;
        updatedAt: number;
    }, {
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">[]], "required", never>;
        name: import("convex/values").VString<string, "required">;
        enabled: import("convex/values").VBoolean<boolean, "required">;
        schedule: import("convex/values").VString<string, "required">;
        policy: import("convex/values").VAny<any, "required", string>;
        context: import("convex/values").VString<string, "required">;
        createdAt: import("convex/values").VFloat64<number, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "app" | "name" | "enabled" | "schedule" | "policy" | "context" | "createdAt" | "updatedAt" | `policy.${string}`>, {
        by_app: ["app", "_creationTime"];
        by_app_enabled: ["app", "enabled", "_creationTime"];
    }, {}, {}>;
    strategy_runs: import("convex/server").TableDefinition<import("convex/values").VObject<{
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
    }, {
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies">, "required">;
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">[]], "required", never>;
        status: import("convex/values").VUnion<"running" | "completed" | "failed", [import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">], "required", never>;
        trigger: import("convex/values").VUnion<"cron" | "manual" | "callback" | undefined, [import("convex/values").VLiteral<"cron", "required">, import("convex/values").VLiteral<"manual", "required">, import("convex/values").VLiteral<"callback", "required">], "optional", never>;
        startedAt: import("convex/values").VFloat64<number, "required">;
        endedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        summary: import("convex/values").VString<string | undefined, "optional">;
        error: import("convex/values").VString<string | undefined, "optional">;
        callbackRequestedMinutes: import("convex/values").VFloat64<number | undefined, "optional">;
        callbackFiresAt: import("convex/values").VFloat64<number | undefined, "optional">;
    }, "required", "error" | "strategyId" | "app" | "status" | "trigger" | "startedAt" | "endedAt" | "summary" | "callbackRequestedMinutes" | "callbackFiresAt">, {
        by_strategy: ["strategyId", "_creationTime"];
        by_strategy_status: ["strategyId", "status", "_creationTime"];
    }, {}, {}>;
    agent_logs: import("convex/server").TableDefinition<import("convex/values").VObject<{
        toolName?: string | undefined;
        toolInput?: string | undefined;
        toolOutput?: string | undefined;
        timestamp: number;
        runId: import("convex/values").GenericId<"strategy_runs">;
        strategyId: import("convex/values").GenericId<"strategies">;
        sequence: number;
        role: "system" | "user" | "assistant" | "tool";
        content: string;
    }, {
        runId: import("convex/values").VId<import("convex/values").GenericId<"strategy_runs">, "required">;
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies">, "required">;
        sequence: import("convex/values").VFloat64<number, "required">;
        role: import("convex/values").VUnion<"system" | "user" | "assistant" | "tool", [import("convex/values").VLiteral<"system", "required">, import("convex/values").VLiteral<"user", "required">, import("convex/values").VLiteral<"assistant", "required">, import("convex/values").VLiteral<"tool", "required">], "required", never>;
        content: import("convex/values").VString<string, "required">;
        toolName: import("convex/values").VString<string | undefined, "optional">;
        toolInput: import("convex/values").VString<string | undefined, "optional">;
        toolOutput: import("convex/values").VString<string | undefined, "optional">;
        timestamp: import("convex/values").VFloat64<number, "required">;
    }, "required", "timestamp" | "runId" | "strategyId" | "sequence" | "role" | "content" | "toolName" | "toolInput" | "toolOutput">, {
        by_run: ["runId", "_creationTime"];
        by_run_sequence: ["runId", "sequence", "_creationTime"];
    }, {}, {}>;
    trade_events: import("convex/server").TableDefinition<import("convex/values").VObject<{
        app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
        timestamp: number;
        runId: import("convex/values").GenericId<"strategy_runs">;
        strategyId: import("convex/values").GenericId<"strategies">;
        eventType: "filled" | "rejected" | "cancelled" | "submission" | "intent" | "validation" | "fill_update";
        payload: string;
    }, {
        runId: import("convex/values").VId<import("convex/values").GenericId<"strategy_runs">, "required">;
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies">, "required">;
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined, [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">[]], "optional", never>;
        eventType: import("convex/values").VUnion<"filled" | "rejected" | "cancelled" | "submission" | "intent" | "validation" | "fill_update", [import("convex/values").VLiteral<"filled" | "rejected" | "cancelled" | "submission" | "intent" | "validation" | "fill_update", "required">, import("convex/values").VLiteral<"filled" | "rejected" | "cancelled" | "submission" | "intent" | "validation" | "fill_update", "required">, ...import("convex/values").VLiteral<"filled" | "rejected" | "cancelled" | "submission" | "intent" | "validation" | "fill_update", "required">[]], "required", never>;
        payload: import("convex/values").VString<string, "required">;
        timestamp: import("convex/values").VFloat64<number, "required">;
    }, "required", "timestamp" | "runId" | "strategyId" | "app" | "eventType" | "payload">, {
        by_run: ["runId", "_creationTime"];
        by_strategy: ["strategyId", "_creationTime"];
        by_app_timestamp: ["app", "timestamp", "_creationTime"];
    }, {}, {}>;
    orders: import("convex/server").TableDefinition<import("convex/values").VObject<{
        metadata?: any;
        app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
        avgFillPrice?: number | undefined;
        venue: string;
        instrument: string;
        quantity: number;
        orderId: string;
        action: "entry" | "adjustment" | "close" | "modify" | "cancel";
        runId: import("convex/values").GenericId<"strategy_runs">;
        strategyId: import("convex/values").GenericId<"strategies">;
        status: "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out";
        filledQuantity: number;
        intent: any;
        updatedAt: number;
        remainingQuantity: number;
        submittedAt: number;
        polling: {
            nextCheckAt?: number | undefined;
            timedOutAt?: number | undefined;
            lastError?: string | undefined;
            resumeToken?: string | undefined;
            timeoutMs: number;
            startedAt: number;
            pollIntervalMs: number;
            lastCheckedAt: number;
        };
    }, {
        orderId: import("convex/values").VString<string, "required">;
        runId: import("convex/values").VId<import("convex/values").GenericId<"strategy_runs">, "required">;
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies">, "required">;
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined, [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">[]], "optional", never>;
        venue: import("convex/values").VString<string, "required">;
        instrument: import("convex/values").VString<string, "required">;
        status: import("convex/values").VUnion<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", [import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">, import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">, ...import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">[]], "required", never>;
        action: import("convex/values").VUnion<"entry" | "adjustment" | "close" | "modify" | "cancel", [import("convex/values").VLiteral<"entry" | "adjustment" | "close" | "modify" | "cancel", "required">, import("convex/values").VLiteral<"entry" | "adjustment" | "close" | "modify" | "cancel", "required">, ...import("convex/values").VLiteral<"entry" | "adjustment" | "close" | "modify" | "cancel", "required">[]], "required", never>;
        quantity: import("convex/values").VFloat64<number, "required">;
        filledQuantity: import("convex/values").VFloat64<number, "required">;
        remainingQuantity: import("convex/values").VFloat64<number, "required">;
        avgFillPrice: import("convex/values").VFloat64<number | undefined, "optional">;
        submittedAt: import("convex/values").VFloat64<number, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
        intent: import("convex/values").VAny<any, "required", string>;
        metadata: import("convex/values").VAny<any, "optional", string>;
        polling: import("convex/values").VObject<{
            nextCheckAt?: number | undefined;
            timedOutAt?: number | undefined;
            lastError?: string | undefined;
            resumeToken?: string | undefined;
            timeoutMs: number;
            startedAt: number;
            pollIntervalMs: number;
            lastCheckedAt: number;
        }, {
            pollIntervalMs: import("convex/values").VFloat64<number, "required">;
            timeoutMs: import("convex/values").VFloat64<number, "required">;
            startedAt: import("convex/values").VFloat64<number, "required">;
            lastCheckedAt: import("convex/values").VFloat64<number, "required">;
            nextCheckAt: import("convex/values").VFloat64<number | undefined, "optional">;
            timedOutAt: import("convex/values").VFloat64<number | undefined, "optional">;
            lastError: import("convex/values").VString<string | undefined, "optional">;
            resumeToken: import("convex/values").VString<string | undefined, "optional">;
        }, "required", "timeoutMs" | "startedAt" | "pollIntervalMs" | "lastCheckedAt" | "nextCheckAt" | "timedOutAt" | "lastError" | "resumeToken">;
    }, "required", "venue" | "instrument" | "quantity" | "metadata" | "orderId" | "action" | "runId" | "strategyId" | "app" | "status" | "filledQuantity" | "intent" | "avgFillPrice" | "updatedAt" | "remainingQuantity" | "submittedAt" | "polling" | `metadata.${string}` | `intent.${string}` | "polling.timeoutMs" | "polling.startedAt" | "polling.pollIntervalMs" | "polling.lastCheckedAt" | "polling.nextCheckAt" | "polling.timedOutAt" | "polling.lastError" | "polling.resumeToken">, {
        by_order_id: ["orderId", "_creationTime"];
        by_strategy_status: ["strategyId", "status", "_creationTime"];
        by_app_status: ["app", "status", "_creationTime"];
        by_run: ["runId", "_creationTime"];
    }, {}, {}>;
    order_transitions: import("convex/server").TableDefinition<import("convex/values").VObject<{
        reason?: string | undefined;
        previousStatus?: "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out" | undefined;
        details?: any;
        orderId: string;
        timestamp: number;
        runId: import("convex/values").GenericId<"strategy_runs">;
        strategyId: import("convex/values").GenericId<"strategies">;
        status: "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out";
        type: "submission" | "status_change" | "modify_attempt" | "cancel_attempt" | "timeout_decision" | "terminal";
        sequence: number;
    }, {
        orderId: import("convex/values").VString<string, "required">;
        runId: import("convex/values").VId<import("convex/values").GenericId<"strategy_runs">, "required">;
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies">, "required">;
        sequence: import("convex/values").VFloat64<number, "required">;
        type: import("convex/values").VUnion<"submission" | "status_change" | "modify_attempt" | "cancel_attempt" | "timeout_decision" | "terminal", [import("convex/values").VLiteral<"submission" | "status_change" | "modify_attempt" | "cancel_attempt" | "timeout_decision" | "terminal", "required">, import("convex/values").VLiteral<"submission" | "status_change" | "modify_attempt" | "cancel_attempt" | "timeout_decision" | "terminal", "required">, ...import("convex/values").VLiteral<"submission" | "status_change" | "modify_attempt" | "cancel_attempt" | "timeout_decision" | "terminal", "required">[]], "required", never>;
        status: import("convex/values").VUnion<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", [import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">, import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">, ...import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">[]], "required", never>;
        previousStatus: import("convex/values").VUnion<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out" | undefined, [import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">, import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">, ...import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">[]], "optional", never>;
        reason: import("convex/values").VString<string | undefined, "optional">;
        details: import("convex/values").VAny<any, "optional", string>;
        timestamp: import("convex/values").VFloat64<number, "required">;
    }, "required", "orderId" | "timestamp" | "runId" | "strategyId" | "status" | "reason" | "type" | "sequence" | "previousStatus" | "details" | `details.${string}`>, {
        by_order_sequence: ["orderId", "sequence", "_creationTime"];
        by_run: ["runId", "_creationTime"];
    }, {}, {}>;
    positions: import("convex/server").TableDefinition<import("convex/values").VObject<{
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
    }, {
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies">, "required">;
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">[]], "required", never>;
        instrument: import("convex/values").VString<string, "required">;
        side: import("convex/values").VUnion<"long" | "short", [import("convex/values").VLiteral<"long", "required">, import("convex/values").VLiteral<"short", "required">], "required", never>;
        quantity: import("convex/values").VFloat64<number, "required">;
        entryPrice: import("convex/values").VFloat64<number, "required">;
        currentPrice: import("convex/values").VFloat64<number | undefined, "optional">;
        unrealizedPnl: import("convex/values").VFloat64<number | undefined, "optional">;
        metadata: import("convex/values").VString<string | undefined, "optional">;
        syncedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "instrument" | "side" | "quantity" | "metadata" | "strategyId" | "app" | "currentPrice" | "entryPrice" | "unrealizedPnl" | "syncedAt">, {
        by_strategy: ["strategyId", "_creationTime"];
        by_strategy_synced_at: ["strategyId", "syncedAt", "_creationTime"];
        by_app: ["app", "_creationTime"];
    }, {}, {}>;
    instrument_claims: import("convex/server").TableDefinition<import("convex/values").VObject<{
        instrument: string;
        strategyId: import("convex/values").GenericId<"strategies">;
        app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
        updatedAt: number;
        source: "position" | "order";
        sourceId: string;
    }, {
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies">, "required">;
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">[]], "required", never>;
        instrument: import("convex/values").VString<string, "required">;
        source: import("convex/values").VUnion<"position" | "order", [import("convex/values").VLiteral<"position", "required">, import("convex/values").VLiteral<"order", "required">], "required", never>;
        sourceId: import("convex/values").VString<string, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "instrument" | "strategyId" | "app" | "updatedAt" | "source" | "sourceId">, {
        by_strategy: ["strategyId", "_creationTime"];
        by_strategy_source: ["strategyId", "source", "_creationTime"];
        by_strategy_source_source_id: ["strategyId", "source", "sourceId", "_creationTime"];
        by_app: ["app", "_creationTime"];
    }, {}, {}>;
    position_syncs: import("convex/server").TableDefinition<import("convex/values").VObject<{
        strategyId: import("convex/values").GenericId<"strategies">;
        app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
        syncedAt: number;
        positionCount: number;
    }, {
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies">, "required">;
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">[]], "required", never>;
        syncedAt: import("convex/values").VFloat64<number, "required">;
        positionCount: import("convex/values").VFloat64<number, "required">;
    }, "required", "strategyId" | "app" | "syncedAt" | "positionCount">, {
        by_strategy_synced_at: ["strategyId", "syncedAt", "_creationTime"];
        by_app: ["app", "_creationTime"];
    }, {}, {}>;
    alerts: import("convex/server").TableDefinition<import("convex/values").VObject<{
        strategyId?: import("convex/values").GenericId<"strategies"> | undefined;
        app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend" | undefined;
        message: string;
        timestamp: number;
        severity: "critical" | "warning" | "info";
        acknowledged: boolean;
    }, {
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies"> | undefined, "optional">;
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend" | undefined, [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend", "required">[]], "optional", never>;
        severity: import("convex/values").VUnion<"critical" | "warning" | "info", [import("convex/values").VLiteral<"critical" | "warning" | "info", "required">, import("convex/values").VLiteral<"critical" | "warning" | "info", "required">, ...import("convex/values").VLiteral<"critical" | "warning" | "info", "required">[]], "required", never>;
        message: import("convex/values").VString<string, "required">;
        acknowledged: import("convex/values").VBoolean<boolean, "required">;
        timestamp: import("convex/values").VFloat64<number, "required">;
    }, "required", "message" | "timestamp" | "strategyId" | "app" | "severity" | "acknowledged">, {
        by_severity: ["severity", "_creationTime"];
        by_acknowledged: ["acknowledged", "_creationTime"];
    }, {}, {}>;
    system_state: import("convex/server").TableDefinition<import("convex/values").VObject<{
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
    }, {
        key: import("convex/values").VLiteral<"kill_switches", "required">;
        globalKillSwitch: import("convex/values").VBoolean<boolean, "required">;
        appKillSwitches: import("convex/values").VObject<{
            binance_futures?: boolean | undefined;
            polymarket: boolean;
            mt5: boolean;
            alpaca_options: boolean;
        }, {
            alpaca_options: import("convex/values").VBoolean<boolean, "required">;
            polymarket: import("convex/values").VBoolean<boolean, "required">;
            mt5: import("convex/values").VBoolean<boolean, "required">;
            binance_futures: import("convex/values").VBoolean<boolean | undefined, "optional">;
        }, "required", "polymarket" | "mt5" | "alpaca_options" | "binance_futures">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
        updatedBy: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "key" | "updatedAt" | "globalKillSwitch" | "appKillSwitches" | "updatedBy" | "appKillSwitches.polymarket" | "appKillSwitches.mt5" | "appKillSwitches.alpaca_options" | "appKillSwitches.binance_futures">, {
        by_key: ["key", "_creationTime"];
    }, {}, {}>;
    app_heartbeats: import("convex/server").TableDefinition<import("convex/values").VObject<{
        metadata?: any;
        app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend";
        status: "healthy" | "degraded" | "unhealthy";
        lastHeartbeat: number;
    }, {
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend", [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend", "required">[]], "required", never>;
        status: import("convex/values").VUnion<"healthy" | "degraded" | "unhealthy", [import("convex/values").VLiteral<"healthy", "required">, import("convex/values").VLiteral<"degraded", "required">, import("convex/values").VLiteral<"unhealthy", "required">], "required", never>;
        lastHeartbeat: import("convex/values").VFloat64<number, "required">;
        metadata: import("convex/values").VAny<any, "optional", string>;
    }, "required", "metadata" | "app" | "status" | `metadata.${string}` | "lastHeartbeat">, {
        by_app: ["app", "_creationTime"];
    }, {}, {}>;
    account_snapshots: import("convex/server").TableDefinition<import("convex/values").VObject<{
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
    }, {
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend", [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend", "required">[]], "required", never>;
        venue: import("convex/values").VString<string, "required">;
        balance: import("convex/values").VFloat64<number, "required">;
        equity: import("convex/values").VFloat64<number | undefined, "optional">;
        buyingPower: import("convex/values").VFloat64<number, "required">;
        marginUsed: import("convex/values").VFloat64<number, "required">;
        marginAvailable: import("convex/values").VFloat64<number, "required">;
        openPnl: import("convex/values").VFloat64<number, "required">;
        dayPnl: import("convex/values").VFloat64<number, "required">;
        timestamp: import("convex/values").VFloat64<number, "required">;
    }, "required", "venue" | "timestamp" | "app" | "balance" | "equity" | "buyingPower" | "marginUsed" | "marginAvailable" | "openPnl" | "dayPnl">, {
        by_app: ["app", "_creationTime"];
        by_app_timestamp: ["app", "timestamp", "_creationTime"];
    }, {}, {}>;
    provider_sync_state: import("convex/server").TableDefinition<import("convex/values").VObject<{
        lastError?: string | undefined;
        lastSyncedAt?: number | undefined;
        lastVerifiedAt?: number | undefined;
        lastDriftSummary?: string | undefined;
        app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
        stale: boolean;
        updatedAt: number;
        positionCount: number;
        providerStatus: "healthy" | "degraded" | "stale";
        accountScope: "single-account-per-venue";
        driftDetected: boolean;
        pendingOrderCount: number;
    }, {
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">[]], "required", never>;
        accountScope: import("convex/values").VLiteral<"single-account-per-venue", "required">;
        lastSyncedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        lastVerifiedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        providerStatus: import("convex/values").VUnion<"healthy" | "degraded" | "stale", [import("convex/values").VLiteral<"healthy" | "degraded" | "stale", "required">, import("convex/values").VLiteral<"healthy" | "degraded" | "stale", "required">, ...import("convex/values").VLiteral<"healthy" | "degraded" | "stale", "required">[]], "required", never>;
        stale: import("convex/values").VBoolean<boolean, "required">;
        driftDetected: import("convex/values").VBoolean<boolean, "required">;
        lastError: import("convex/values").VString<string | undefined, "optional">;
        lastDriftSummary: import("convex/values").VString<string | undefined, "optional">;
        positionCount: import("convex/values").VFloat64<number, "required">;
        pendingOrderCount: import("convex/values").VFloat64<number, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "app" | "stale" | "updatedAt" | "lastError" | "positionCount" | "providerStatus" | "accountScope" | "lastSyncedAt" | "lastVerifiedAt" | "driftDetected" | "lastDriftSummary" | "pendingOrderCount">, {
        by_app: ["app", "_creationTime"];
    }, {}, {}>;
    provider_positions: import("convex/server").TableDefinition<import("convex/values").VObject<{
        metadata?: string | undefined;
        strategyId?: import("convex/values").GenericId<"strategies"> | undefined;
        currentPrice?: number | undefined;
        unrealizedPnl?: number | undefined;
        stopLoss?: number | undefined;
        takeProfit?: number | undefined;
        instrument: string;
        side: "long" | "short";
        quantity: number;
        app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
        entryPrice: number;
        syncedAt: number;
        ownershipStatus: "owned" | "unowned" | "orphaned";
        positionKey: string;
    }, {
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">[]], "required", never>;
        positionKey: import("convex/values").VString<string, "required">;
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies"> | undefined, "optional">;
        ownershipStatus: import("convex/values").VUnion<"owned" | "unowned" | "orphaned", [import("convex/values").VLiteral<"owned" | "unowned" | "orphaned", "required">, import("convex/values").VLiteral<"owned" | "unowned" | "orphaned", "required">, ...import("convex/values").VLiteral<"owned" | "unowned" | "orphaned", "required">[]], "required", never>;
        instrument: import("convex/values").VString<string, "required">;
        side: import("convex/values").VUnion<"long" | "short", [import("convex/values").VLiteral<"long", "required">, import("convex/values").VLiteral<"short", "required">], "required", never>;
        quantity: import("convex/values").VFloat64<number, "required">;
        entryPrice: import("convex/values").VFloat64<number, "required">;
        currentPrice: import("convex/values").VFloat64<number | undefined, "optional">;
        unrealizedPnl: import("convex/values").VFloat64<number | undefined, "optional">;
        stopLoss: import("convex/values").VFloat64<number | undefined, "optional">;
        takeProfit: import("convex/values").VFloat64<number | undefined, "optional">;
        metadata: import("convex/values").VString<string | undefined, "optional">;
        syncedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "instrument" | "side" | "quantity" | "metadata" | "strategyId" | "app" | "currentPrice" | "entryPrice" | "unrealizedPnl" | "syncedAt" | "ownershipStatus" | "positionKey" | "stopLoss" | "takeProfit">, {
        by_app: ["app", "_creationTime"];
        by_app_strategy: ["app", "strategyId", "_creationTime"];
    }, {}, {}>;
    provider_working_orders: import("convex/server").TableDefinition<import("convex/values").VObject<{
        side?: "buy" | "sell" | undefined;
        limitPrice?: number | undefined;
        stopPrice?: number | undefined;
        metadata?: string | undefined;
        action?: "entry" | "adjustment" | "close" | "modify" | "cancel" | undefined;
        runId?: import("convex/values").GenericId<"strategy_runs"> | undefined;
        strategyId?: import("convex/values").GenericId<"strategies"> | undefined;
        avgFillPrice?: number | undefined;
        venue: string;
        instrument: string;
        quantity: number;
        orderId: string;
        app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
        status: "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out";
        filledQuantity: number;
        updatedAt: number;
        remainingQuantity: number;
        submittedAt: number;
        syncedAt: number;
        ownershipStatus: "owned" | "unowned" | "orphaned";
    }, {
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">[]], "required", never>;
        orderId: import("convex/values").VString<string, "required">;
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies"> | undefined, "optional">;
        runId: import("convex/values").VId<import("convex/values").GenericId<"strategy_runs"> | undefined, "optional">;
        ownershipStatus: import("convex/values").VUnion<"owned" | "unowned" | "orphaned", [import("convex/values").VLiteral<"owned" | "unowned" | "orphaned", "required">, import("convex/values").VLiteral<"owned" | "unowned" | "orphaned", "required">, ...import("convex/values").VLiteral<"owned" | "unowned" | "orphaned", "required">[]], "required", never>;
        venue: import("convex/values").VString<string, "required">;
        instrument: import("convex/values").VString<string, "required">;
        status: import("convex/values").VUnion<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", [import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">, import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">, ...import("convex/values").VLiteral<"pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out", "required">[]], "required", never>;
        action: import("convex/values").VUnion<"entry" | "adjustment" | "close" | "modify" | "cancel" | undefined, [import("convex/values").VLiteral<"entry" | "adjustment" | "close" | "modify" | "cancel", "required">, import("convex/values").VLiteral<"entry" | "adjustment" | "close" | "modify" | "cancel", "required">, ...import("convex/values").VLiteral<"entry" | "adjustment" | "close" | "modify" | "cancel", "required">[]], "optional", never>;
        side: import("convex/values").VUnion<"buy" | "sell" | undefined, [import("convex/values").VLiteral<"buy", "required">, import("convex/values").VLiteral<"sell", "required">], "optional", never>;
        quantity: import("convex/values").VFloat64<number, "required">;
        filledQuantity: import("convex/values").VFloat64<number, "required">;
        remainingQuantity: import("convex/values").VFloat64<number, "required">;
        limitPrice: import("convex/values").VFloat64<number | undefined, "optional">;
        stopPrice: import("convex/values").VFloat64<number | undefined, "optional">;
        avgFillPrice: import("convex/values").VFloat64<number | undefined, "optional">;
        metadata: import("convex/values").VString<string | undefined, "optional">;
        submittedAt: import("convex/values").VFloat64<number, "required">;
        updatedAt: import("convex/values").VFloat64<number, "required">;
        syncedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "venue" | "instrument" | "side" | "quantity" | "limitPrice" | "stopPrice" | "metadata" | "orderId" | "action" | "runId" | "strategyId" | "app" | "status" | "filledQuantity" | "avgFillPrice" | "updatedAt" | "remainingQuantity" | "submittedAt" | "syncedAt" | "ownershipStatus">, {
        by_app: ["app", "_creationTime"];
        by_app_strategy: ["app", "strategyId", "_creationTime"];
        by_app_status: ["app", "status", "_creationTime"];
    }, {}, {}>;
    manual_run_requests: import("convex/server").TableDefinition<import("convex/values").VObject<{
        strategyId: import("convex/values").GenericId<"strategies">;
        app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
        requestedAt: number;
    }, {
        strategyId: import("convex/values").VId<import("convex/values").GenericId<"strategies">, "required">;
        app: import("convex/values").VUnion<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", [import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">, ...import("convex/values").VLiteral<"alpaca-options" | "polymarket" | "mt5" | "binance-futures", "required">[]], "required", never>;
        requestedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "strategyId" | "app" | "requestedAt">, {
        by_app: ["app", "_creationTime"];
        by_strategy: ["strategyId", "_creationTime"];
    }, {}, {}>;
    users: import("convex/server").TableDefinition<import("convex/values").VObject<{
        name?: string | undefined;
        email?: string | undefined;
        phone?: string | undefined;
        image?: string | undefined;
        emailVerificationTime?: number | undefined;
        phoneVerificationTime?: number | undefined;
        isAnonymous?: boolean | undefined;
    }, {
        name: import("convex/values").VString<string | undefined, "optional">;
        image: import("convex/values").VString<string | undefined, "optional">;
        email: import("convex/values").VString<string | undefined, "optional">;
        emailVerificationTime: import("convex/values").VFloat64<number | undefined, "optional">;
        phone: import("convex/values").VString<string | undefined, "optional">;
        phoneVerificationTime: import("convex/values").VFloat64<number | undefined, "optional">;
        isAnonymous: import("convex/values").VBoolean<boolean | undefined, "optional">;
    }, "required", "name" | "email" | "phone" | "image" | "emailVerificationTime" | "phoneVerificationTime" | "isAnonymous">, {
        email: ["email", "_creationTime"];
        phone: ["phone", "_creationTime"];
    }, {}, {}>;
    authSessions: import("convex/server").TableDefinition<import("convex/values").VObject<{
        userId: import("convex/values").GenericId<"users">;
        expirationTime: number;
    }, {
        userId: import("convex/values").VId<import("convex/values").GenericId<"users">, "required">;
        expirationTime: import("convex/values").VFloat64<number, "required">;
    }, "required", "userId" | "expirationTime">, {
        userId: ["userId", "_creationTime"];
    }, {}, {}>;
    authAccounts: import("convex/server").TableDefinition<import("convex/values").VObject<{
        secret?: string | undefined;
        emailVerified?: string | undefined;
        phoneVerified?: string | undefined;
        userId: import("convex/values").GenericId<"users">;
        provider: string;
        providerAccountId: string;
    }, {
        userId: import("convex/values").VId<import("convex/values").GenericId<"users">, "required">;
        provider: import("convex/values").VString<string, "required">;
        providerAccountId: import("convex/values").VString<string, "required">;
        secret: import("convex/values").VString<string | undefined, "optional">;
        emailVerified: import("convex/values").VString<string | undefined, "optional">;
        phoneVerified: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "secret" | "userId" | "provider" | "providerAccountId" | "emailVerified" | "phoneVerified">, {
        userIdAndProvider: ["userId", "provider", "_creationTime"];
        providerAndAccountId: ["provider", "providerAccountId", "_creationTime"];
    }, {}, {}>;
    authRefreshTokens: import("convex/server").TableDefinition<import("convex/values").VObject<{
        firstUsedTime?: number | undefined;
        parentRefreshTokenId?: import("convex/values").GenericId<"authRefreshTokens"> | undefined;
        expirationTime: number;
        sessionId: import("convex/values").GenericId<"authSessions">;
    }, {
        sessionId: import("convex/values").VId<import("convex/values").GenericId<"authSessions">, "required">;
        expirationTime: import("convex/values").VFloat64<number, "required">;
        firstUsedTime: import("convex/values").VFloat64<number | undefined, "optional">;
        parentRefreshTokenId: import("convex/values").VId<import("convex/values").GenericId<"authRefreshTokens"> | undefined, "optional">;
    }, "required", "expirationTime" | "sessionId" | "firstUsedTime" | "parentRefreshTokenId">, {
        sessionId: ["sessionId", "_creationTime"];
        sessionIdAndParentRefreshTokenId: ["sessionId", "parentRefreshTokenId", "_creationTime"];
    }, {}, {}>;
    authVerificationCodes: import("convex/server").TableDefinition<import("convex/values").VObject<{
        emailVerified?: string | undefined;
        phoneVerified?: string | undefined;
        verifier?: string | undefined;
        expirationTime: number;
        provider: string;
        accountId: import("convex/values").GenericId<"authAccounts">;
        code: string;
    }, {
        accountId: import("convex/values").VId<import("convex/values").GenericId<"authAccounts">, "required">;
        provider: import("convex/values").VString<string, "required">;
        code: import("convex/values").VString<string, "required">;
        expirationTime: import("convex/values").VFloat64<number, "required">;
        verifier: import("convex/values").VString<string | undefined, "optional">;
        emailVerified: import("convex/values").VString<string | undefined, "optional">;
        phoneVerified: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "expirationTime" | "provider" | "emailVerified" | "phoneVerified" | "accountId" | "code" | "verifier">, {
        accountId: ["accountId", "_creationTime"];
        code: ["code", "_creationTime"];
    }, {}, {}>;
    authVerifiers: import("convex/server").TableDefinition<import("convex/values").VObject<{
        sessionId?: import("convex/values").GenericId<"authSessions"> | undefined;
        signature?: string | undefined;
    }, {
        sessionId: import("convex/values").VId<import("convex/values").GenericId<"authSessions"> | undefined, "optional">;
        signature: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "sessionId" | "signature">, {
        signature: ["signature", "_creationTime"];
    }, {}, {}>;
    authRateLimits: import("convex/server").TableDefinition<import("convex/values").VObject<{
        identifier: string;
        lastAttemptTime: number;
        attemptsLeft: number;
    }, {
        identifier: import("convex/values").VString<string, "required">;
        lastAttemptTime: import("convex/values").VFloat64<number, "required">;
        attemptsLeft: import("convex/values").VFloat64<number, "required">;
    }, "required", "identifier" | "lastAttemptTime" | "attemptsLeft">, {
        identifier: ["identifier", "_creationTime"];
    }, {}, {}>;
}, true>;
export default _default;
//# sourceMappingURL=schema.d.ts.map