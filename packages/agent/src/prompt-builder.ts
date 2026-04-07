import { stripMetadataBlock, type StrategyRunContext } from "@valiq-trading/core"

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
    if (context.previousRunSummary) {
        sections.push(buildPreviousRunSection(context.previousRunSummary, context.timestamp))
    }
    if (context.runtimeContextLines && context.runtimeContextLines.length > 0) {
        sections.push(buildRuntimeContextSection(context.runtimeContextLines))
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

function buildPreviousRunSection(
    previousRun: { summary: string; endedAt: number },
    currentTimestamp: number
): string {
    const minutesAgo = Math.round((currentTimestamp - previousRun.endedAt) / 60000)
    const cleanSummary = stripMetadataBlock(previousRun.summary)
    return [
        "## Previous Run Handoff",
        "",
        `The following is a summary written by the previous run of this strategy, ${minutesAgo} minutes ago. It is a snapshot of what the agent observed, decided, and recommends you start with.`,
        "",
        "**How to use this:**",
        "- Treat this as stale context, not current truth. Prices, odds, and news may have changed.",
        "- Use it to avoid redundant research. If the previous run already mapped out the landscape, you can start from where it left off instead of re-discovering everything from scratch.",
        "- If you have open positions, this tells you why they were opened and what the thesis was.",
        "- Do NOT blindly continue the previous run's plan. Verify key assumptions before acting.",
        "- If the situation has materially changed, discard this context and start fresh.",
        "",
        "---",
        "",
        cleanSummary,
        "",
        "---",
    ].join("\n")
}

function buildRuntimeContextSection(runtimeContextLines: string[]): string {
    return [
        "## Runtime Context",
        "",
        ...runtimeContextLines,
    ].join("\n")
}

function buildAccountSnapshot(context: StrategyRunContext): string {
    const acct = context.accountState
    return [
        "## Current Account State",
        "",
        `- Balance: ${formatCurrency(acct.balance)}`,
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
    const policyLines = Object.entries(context.policy).map(
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
            "If an order is rejected (invalid params, insufficient RR, or broker error), the rejection is returned to you. Adjust your parameters and retry if appropriate.",
        )
    } else if (context.app === "binance-futures") {
        const maxRisk = context.policy.maxRiskPercent ?? 1
        const maxLeverage = context.policy.maxLeverage ?? 3

        lines.push(
            "",
            "## Binance Futures Order Requirements",
            "",
            "When proposing entries, you MUST provide:",
            "- stopLoss: absolute stop-loss price (always required)",
            "- EITHER takeProfit (absolute price) OR riskRewardRatio, not both",
            "",
            `You must NEVER specify quantity manually. Position size is calculated automatically from stop distance and maxRiskPercent (${maxRisk}%).`,
            "",
            `Leverage defaults to policy maxLeverage and can never exceed ${maxLeverage}x.`,
            "",
            "For filled entries, the system attempts to attach protective SL/TP orders automatically. If the order is still pending, monitor fill status and run propose_adjustment once the position opens.",
            "",
            "If an order is rejected, revise parameters and retry only with materially different inputs.",
        )
    }

    return lines.join("\n")
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
        "3. If an order is rejected by the risk engine, do not retry with the same parameters.",
        "4. For limit orders, monitor fill status and adjust or cancel if not filling.",
        "5. When your analysis is complete and all actions are taken, respond with a final summary.",
        "6. Your summary is handed off to the next run of this strategy as context. Write it as a briefing for your future self:",
        "   - What is the current market landscape relevant to this strategy?",
        "   - What positions are open and what is the thesis behind each?",
        "   - What actions did you take (or chose not to) and why?",
        "   - What should the next run check first or watch for?",
        "   - What key data points or prices did you observe (so the next run can detect changes)?",
        "   - Keep it dense and factual. No filler. This is an operational handoff, not a report.",
        `7. Self-scheduling: You can request an earlier callback by appending a metadata block to the END of your summary.${scheduleInfo} Only request a callback SHORTER than your normal interval -- requests at or beyond your normal schedule are ignored since the cron already covers that.`,
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
            "- Do NOT redo full market research. The previous run already gathered that context and handed it off to you above.",
            "- Focus on: checking positions, evaluating if your thesis still holds, adjusting or closing positions, and monitoring fills.",
            "- Use research tools (web_search, web_fetch, query_valiq_research, query_valiq_data) only if something specific changed that invalidates your previous analysis.",
            "- Research tool call budgets are halved for callback runs. Use them wisely.",
            "- If nothing has changed and no action is needed, write a brief summary and exit. Do not burn tokens re-analyzing a static situation.",
        )
    }

    return rules.join("\n")
}
