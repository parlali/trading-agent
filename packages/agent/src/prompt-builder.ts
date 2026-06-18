import {
    getAccountEquity,
    type StrategyRunContext,
} from "@valiq-trading/core"

function formatCurrency(amount: number, currency = "USD"): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amount)
}

export function buildSystemPrompt(
    context: StrategyRunContext,
    toolDescriptions: Array<{ name: string; description: string }>
): string {
    const sections: string[] = []

    sections.push(buildRoleSection())
    sections.push(buildCurrentTimestamp(context.timestamp))
    sections.push(buildStrategyContext(context))
    if (context.operationalMemory && context.operationalMemory.length > 0) {
        sections.push(buildOperationalMemorySection(
            context.operationalMemory,
            context.promptSanitizer?.blockedIdentifiers ?? []
        ))
    }
    if (context.pendingOrders && context.pendingOrders.length > 0) {
        sections.push(buildPendingOrdersSection(context))
    }
    if (context.runtimeContextLines && context.runtimeContextLines.length > 0) {
        sections.push(buildRuntimeContextSection(
            sanitizePromptLines(
                context.runtimeContextLines,
                context.promptSanitizer?.blockedIdentifiers ?? []
            )
        ))
    }
    sections.push(buildAccountSnapshot(context))
    sections.push(buildPositionsSnapshot(context))
    sections.push(buildPolicySection(context))
    sections.push(buildToolsSection(toolDescriptions))
    sections.push(buildRulesSection(context.schedule, context.trigger))

    return sections.join("\n\n")
}

function buildRoleSection(): string {
    return [
        "You are an autonomous trading agent. Your job is to analyze market conditions, manage positions, and execute trades according to your strategy configuration.",
        "",
        "You operate within a strict risk framework. Every order you propose goes through a deterministic risk validation layer before execution. You cannot bypass this layer.",
        "",
        "Think step by step. Research thoroughly before acting. The risk engine protects against invalid trades -- your job is to find and execute opportunities, not to second-guess the safety net.",
    ].join("\n")
}

function buildCurrentTimestamp(timestampMs: number): string {
    const date = new Date(timestampMs)
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ]
    const dayName = dayNames[date.getUTCDay()]
    const monthName = monthNames[date.getUTCMonth()]
    const day = date.getUTCDate()
    const year = date.getUTCFullYear()
    const hours = String(date.getUTCHours()).padStart(2, "0")
    const minutes = String(date.getUTCMinutes()).padStart(2, "0")

    return [
        "## Current Date & Time",
        "",
        `${dayName}, ${monthName} ${day}, ${year} -- ${hours}:${minutes} UTC`,
    ].join("\n")
}

function buildStrategyContext(context: StrategyRunContext): string {
    return [
        "## Strategy Context",
        "",
        context.context,
    ].join("\n")
}

function buildPendingOrdersSection(context: StrategyRunContext): string {
    const pendingOrders = context.pendingOrders ?? []
    const lines = pendingOrders.map((order) => {
        const ageMinutes = Math.max(Math.round((context.timestamp - order.submittedAt) / 60000), 0)
        const submittedAt = formatTimestamp(order.submittedAt)
        const limitPrice = order.limitPrice !== undefined ? ` | Limit: ${order.limitPrice}` : ""
        const avgFillPrice = order.avgFillPrice !== undefined ? ` | Avg Fill: ${order.avgFillPrice}` : ""

        return [
            `- ${order.orderId}`,
            `  Structure/Instrument: ${order.instrument}`,
            `  Status: ${order.status} | Action: ${order.action} | Filled: ${order.filledQuantity}/${order.quantity} | Remaining: ${order.remainingQuantity}${limitPrice}${avgFillPrice}`,
            `  Submitted: ${submittedAt} (${ageMinutes} minutes ago)`,
            `  Recommended Next Action: ${order.recommendedAction}`,
        ].join("\n")
    })

    return [
        "## Pending Orders To Resume",
        "",
        "These were refreshed from the live venue at run start. Treat them as current working orders that may need supervision before considering any new entry.",
        "",
        ...lines,
    ].join("\n")
}

function buildRuntimeContextSection(runtimeContextLines: string[]): string {
    return [
        "## System Context Digest",
        "",
        "Canonical system-authored state snapshot for this run:",
        ...runtimeContextLines,
    ].join("\n")
}

function buildOperationalMemorySection(
    memories: NonNullable<StrategyRunContext["operationalMemory"]>,
    blockedIdentifiers: string[]
): string {
    const lines = [
        "## Strategy Operational Memory",
        "",
        "Typed strategy-scoped lessons derived from completed run evidence. These are advisory only.",
        "Current provider truth, current positions, current account state, risk checks, ownership, accounting, and order lifecycle state always override memory.",
        "",
    ]

    for (const memory of memories) {
        const source = memory.sources[0]
        const sourceText = source
            ? `sourceRun=${source.runId ?? "unknown"} sourceTime=${formatTimestamp(source.timestamp)}`
            : "sourceRun=unknown"
        const scopeParts = [
            `app=${memory.scope.app}`,
            `account=${memory.scope.accountId}`,
            memory.scope.providerId ? `provider=${memory.scope.providerId}` : undefined,
            memory.scope.toolName ? `tool=${memory.scope.toolName}` : undefined,
            memory.scope.upstreamToolName ? `upstream=${memory.scope.upstreamToolName}` : undefined,
            memory.scope.schemaHash ? `schema=${memory.scope.schemaHash.slice(0, 12)}` : undefined,
            memory.scope.instrument ? `instrument=${memory.scope.instrument}` : undefined,
        ].filter((part): part is string => Boolean(part))
        lines.push(
            `- ${memory.type} | severity=${memory.severity} | confidence=${memory.confidence.toFixed(2)} | ${scopeParts.join(" ")} | ${sourceText}`,
            `  Summary: ${memory.lesson.summary}`,
            `  Evidence: attempts=${memory.evidence.attemptCount} successes=${memory.evidence.successCount} failures=${memory.evidence.failureCount}`,
            `  Provider truth: ${memory.lesson.providerTruth}`
        )
        if (memory.lesson.useWhen) {
            lines.push(`  Use when: ${memory.lesson.useWhen}`)
        }
        if (memory.lesson.avoidWhen) {
            lines.push(`  Avoid when: ${memory.lesson.avoidWhen}`)
        }
        if (memory.lesson.requiredArgumentShape !== undefined) {
            lines.push(`  Required argument shape: ${formatMemoryJson(memory.lesson.requiredArgumentShape)}`)
        }
        if (memory.lesson.correctedExample !== undefined) {
            lines.push(`  Corrected example: ${formatMemoryJson(memory.lesson.correctedExample)}`)
        }
    }

    return sanitizePromptLines(lines, blockedIdentifiers).join("\n")
}

function formatMemoryJson(value: unknown): string {
    const json = JSON.stringify(value)
    if (!json) {
        return "null"
    }

    return json.length > 800
        ? `${json.slice(0, 800)} [truncated]`
        : json
}

function buildAccountSnapshot(context: StrategyRunContext): string {
    const acct = context.accountState
    return [
        "## Current Account State",
        "",
        `- Balance: ${formatCurrency(acct.balance)}`,
        `- Equity / Net Liq: ${formatCurrency(getAccountEquity(acct))}`,
        `- Buying Power: ${formatCurrency(acct.buyingPower)}`,
        `- Margin Used: ${formatCurrency(acct.marginUsed)}`,
        `- Margin Available: ${formatCurrency(acct.marginAvailable)}`,
        `- Open P&L: ${formatCurrency(acct.openPnl)}`,
        `- Day P&L: ${formatCurrency(acct.dayPnl)}`,
    ].join("\n")
}

function buildPositionsSnapshot(context: StrategyRunContext): string {
    if (context.positions.length === 0) {
        return [
            "## Current Positions",
            "",
            "No open positions.",
        ].join("\n")
    }

    const lines = context.positions.map((pos) => {
        const pnl = pos.unrealizedPnl !== undefined ? ` | P&L: ${formatCurrency(pos.unrealizedPnl)}` : ""
        const price = pos.currentPrice !== undefined ? ` | Current: ${pos.currentPrice}` : ""
        return `- ${pos.instrument}: ${pos.side} ${pos.quantity} @ ${pos.entryPrice}${price}${pnl}`
    })

    return [
        "## Current Positions",
        "",
        ...lines,
    ].join("\n")
}

function buildPolicySection(context: StrategyRunContext): string {
    const policyLines = Object.entries(toModelVisiblePolicy(context.policy)).map(
        ([key, value]) => `- ${key}: ${JSON.stringify(value)}`
    )

    const lines = [
        "## Policy Constraints",
        "",
        "The following constraints are enforced automatically by the risk engine. Orders violating these will be rejected.",
        "",
        ...policyLines,
    ]

    if (context.app === "mt5") {
        const maxRisk = context.policy.maxRiskPercent ?? 2
        const minRR = context.policy.minRiskReward ?? 0.5

        lines.push(
            "",
            "## MT5 Order Requirements",
            "",
            "When proposing orders, you MUST provide:",
            "- stopLoss: absolute price level for your stop-loss (always required)",
            "- EITHER takeProfit (absolute price) OR riskRewardRatio (e.g. 2.0), not both",
            "",
            `You must NEVER specify lot size / quantity. The system calculates position size automatically so that hitting your stop-loss loses exactly ${maxRisk}% of the account balance.`,
            "",
            `If takeProfit is given as an absolute price, the implied risk-reward ratio must be >= ${minRR}. Orders below this threshold will be rejected.`,
            "",
            "Lifecycle expectations:",
            "- Use `modify_order` only to change stop-loss and/or take-profit on an existing MT5 position using its numeric ticket",
            "- Do not use `modify_order` to change quantity, entry price, or replace a pending order",
            "- If a pending MT5 entry order already exists, manage or cancel it before proposing another one unless the typed strategy policy explicitly allows overlap",
            "",
            "If an order is rejected (invalid params, insufficient RR, or broker error), the rejection is returned to you. Adjust your parameters and retry if appropriate.",
        )
    } else if (context.app === "alpaca-options") {
        lines.push(
            "",
            "## Alpaca Multi-Leg Credit Structure Requirements",
            "",
            "Use `propose_order` only for new 2-leg or 4-leg multi-leg credit entries.",
            "- Structure identity is derived from the provider order and normalized leg set. Quantity is state, not identity.",
            "- Each leg instrument must be a valid OCC option symbol",
            "- Supported entry structures:",
            "  - 2-leg one-sided credit vertical: bull put (`sell_to_open` put + `buy_to_open` lower put) or bear call (`sell_to_open` call + `buy_to_open` higher call)",
            "  - 4-leg iron condor: two `sell_to_open` shorts and two `buy_to_open` wings",
            "- Use quantity as the number of full structures and leg quantity `1` for each leg",
            "- Supported order type: `limit` only",
            "- Supported time in force: `day` only",
            "- `limitPrice` is the positive net price for the full structure, not a per-leg price",
            "- For entries, pass the net credit as a positive number. The system handles Alpaca's signed `mleg` wire `limit_price` internally",
            "",
            "Lifecycle expectations:",
            "- Use `modify_order` only to improve or reduce the limit price on a still-working entry order",
            "- Manage filled structures with `propose_close`, and working entries with `modify_order`",
            "- Use `get_order_status` and `wait_for_order_update` to supervise working orders",
            "- Use `propose_close` to close an already-filled credit vertical or iron condor structure",
            "- Do not submit single-leg options, partial structures, stop orders, or duplicate replacement entries",
        )
    } else if (context.app === "polymarket") {
        lines.push(
            "",
            "## Polymarket Discovery Requirements",
            "",
            "Use `search_markets` as a Gamma-backed discovery pass only. Treat the returned list as candidate metadata plus token IDs, not execution-grade pricing.",
            "- Start with the top-liquid market list for the category or query you care about",
            "- Narrow to only your top candidate markets before requesting live venue data",
            "- Prefer the returned `tokenHandle` for `get_market_price`, `get_order_book`, and `propose_order`; do not shorten or rewrite token IDs",
            "- Call `get_market_price` and `get_order_book` individually for only those top candidate token handles before sizing or placing any trade. Treat `executionCost` from venue tools as the canonical liquidity/tradability signal.",
            "- `propose_order` requires the exact `tokenHandle` from discovery, or the exact canonical token ID plus condition ID, market slug, question, and outcome. Never place an order using only a condition ID, event slug, or question string.",
            "- Before using `propose_order`, compare the candidate token ID and condition ID against `get_positions`. If the strategy already holds that token or another outcome from the same condition ID, do not submit another entry; only monitor or use `propose_close` if risk should be reduced.",
            "- Use `propose_close` to reduce or exit existing positions. Polymarket does not support `modify_order` or `propose_adjustment` in this runtime.",
            "- Supported order semantics are market or limit with gtc, ioc, or fok. Do not use stop orders, stop prices, or day time in force.",
            "- Only opt into `search_markets` live price enrichment if you have a specific reason, and keep the token count tightly bounded",
        )
    }

    return lines.join("\n")
}

function sanitizePromptLines(lines: string[], blockedIdentifiers: string[]): string[] {
    const blocked = normalizeBlockedIdentifiers(blockedIdentifiers)
    if (blocked.length === 0) {
        return lines
    }

    return lines.filter((line) => !containsBlockedIdentifier(line, blocked))
}

function normalizeBlockedIdentifiers(blockedIdentifiers: string[]): string[] {
    return Array.from(
        new Set(
            blockedIdentifiers
                .map((identifier) => identifier.trim().toLowerCase())
                .filter((identifier) => identifier.length >= 4)
        )
    )
}

function containsBlockedIdentifier(line: string, blockedIdentifiers: string[]): boolean {
    const normalizedLine = line.toLowerCase()
    return blockedIdentifiers.some((identifier) => normalizedLine.includes(identifier))
}

function toModelVisiblePolicy(policy: Record<string, unknown>): Record<string, unknown> {
    const sanitized = sanitizePolicyValue(policy)

    return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
        ? sanitized as Record<string, unknown>
        : {}
}

function sanitizePolicyValue(value: unknown, path: string[] = []): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizePolicyValue(entry, path))
    }

    if (!value || typeof value !== "object") {
        return value
    }

    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
        const nextPath = [...path, key]
        if (isHiddenPolicyPath(nextPath)) {
            continue
        }

        result[key] = sanitizePolicyValue(entry, nextPath)
    }

    return result
}

function isHiddenPolicyPath(path: string[]): boolean {
    const joined = path.join(".")
    return joined === "llm" ||
        joined === "model" ||
        joined === "reasoning" ||
        joined === "safety.expectedExternalInstruments"
}

function formatTimestamp(timestampMs: number): string {
    return new Date(timestampMs).toISOString().replace(".000Z", "Z")
}

function buildToolsSection(
    toolDescriptions: Array<{ name: string; description: string }>
): string {
    if (toolDescriptions.length === 0) {
        return "## Available Tools\n\nNo tools available."
    }

    const lines = toolDescriptions.map(
        (t) => `- **${t.name}**: ${t.description}`
    )

    return [
        "## Available Tools",
        "",
        ...lines,
    ].join("\n")
}

function buildRulesSection(schedule?: string, trigger?: string): string {
    const scheduleInfo = schedule ? ` Your normal cron schedule is \`${schedule}\`.` : ""

    const rules = [
        "## Operating Rules",
        "",
        "1. Your current positions and account state are already provided above. Do NOT call get_positions or get_account at the start -- that data is already in this prompt. Only call them later if you need a refresh after placing an order.",
        "2. Follow the INFORMATION GATHERING order in your strategy context. Start with the research/data tools specified there, not with generic web searches.",
        "3. Treat venue-owned market data as execution truth. Research/data tools can inform your thesis, but any live prices, spreads, execution-cost readings, or current levels from them are advisory only and must yield to venue tools when they disagree.",
        "4. If an order is rejected by the risk engine, do not retry with the same parameters.",
        "5. For limit orders, monitor fill status and adjust or cancel if not filling.",
        "6. When your analysis is complete and all actions are taken, respond with a final summary.",
        "7. Your summary may be converted into short-lived structured run_handoff_fact memory after the run completes. Write it as a briefing for the next run:",
        "   - What is the current market landscape relevant to this strategy?",
        "   - What positions are open and what is the thesis behind each?",
        "   - What actions did you take (or chose not to) and why?",
        "   - What should the next run check first or watch for?",
        "   - What key data points or prices did you observe (so the next run can detect changes)?",
        "   - Keep it dense and factual. No filler. This is an operational handoff, not a report.",
        `8. Self-scheduling: You can request an earlier callback by appending a metadata block to the END of your summary.${scheduleInfo} Only request a callback SHORTER than your normal interval -- requests at or beyond your normal schedule are ignored since the cron already covers that.`,
        "   ```",
        "   ---METADATA---",
        '   {"nextRunInMinutes": 5}',
        "   ---END METADATA---",
        "   ```",
        "   Guidelines:",
        "   - 5-10 minutes: active position monitoring, fast-moving markets",
        "   - 10-15 minutes: developing situations worth watching closely",
        "   - Omit the block entirely if the normal cron schedule is sufficient",
        "   - Valid range: 2-240 minutes. Minimum 5-minute gap between oneshot-triggered runs is enforced",
    ]

    if (trigger === "callback") {
        rules.push(
            "",
            "## CALLBACK RUN -- HARD CONSTRAINTS",
            "",
            "This is a CALLBACK run, not a scheduled cron run. You requested this callback to manage positions or react to a known event.",
            "",
            "- Do NOT redo full market research if the structured operational memory above already contains a fresh latest-run handoff.",
            "- Focus on: checking positions, evaluating if your thesis still holds, adjusting or closing positions, and monitoring fills.",
            "- Use research tools (web_search, web_fetch, or configured MCP research tools) only if something specific changed that invalidates the fresh latest-run handoff.",
            "- Configured MCP research tools have a two-call callback budget instead of the normal four-call scheduled-run budget. Use them wisely.",
            "- If nothing has changed and no action is needed, write a brief summary and exit. Do not burn tokens re-analyzing a static situation.",
        )
    }

    return rules.join("\n")
}
