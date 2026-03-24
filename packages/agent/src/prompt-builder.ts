import type { StrategyRunContext } from "@valiq-trading/core"
import { formatCurrency } from "@valiq-trading/core"

export function buildSystemPrompt(
    context: StrategyRunContext,
    toolDescriptions: Array<{ name: string; description: string }>
): string {
    const sections: string[] = []

    sections.push(buildRoleSection())
    sections.push(buildStrategyContext(context))
    sections.push(buildAccountSnapshot(context))
    sections.push(buildPositionsSnapshot(context))
    sections.push(buildPolicySection(context))
    sections.push(buildToolsSection(toolDescriptions))
    sections.push(buildRulesSection())

    return sections.join("\n\n")
}

function buildRoleSection(): string {
    return [
        "You are an autonomous trading agent. Your job is to analyze market conditions, manage positions, and execute trades according to your strategy configuration.",
        "",
        "You operate within a strict risk framework. Every order you propose goes through a deterministic risk validation layer before execution. You cannot bypass this layer.",
        "",
        "Think step by step. Research thoroughly before acting. When in doubt, do nothing.",
    ].join("\n")
}

function buildStrategyContext(context: StrategyRunContext): string {
    return [
        "## Strategy Context",
        "",
        context.context,
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

    return [
        "## Policy Constraints",
        "",
        "The following constraints are enforced automatically by the risk engine. Orders violating these will be rejected.",
        "",
        ...policyLines,
    ].join("\n")
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

function buildRulesSection(): string {
    return [
        "## Operating Rules",
        "",
        "1. Always check current positions and account state before proposing any trades.",
        "2. Use research tools to gather market context before making decisions.",
        "3. Propose one action at a time. Wait for the result before proceeding.",
        "4. If an order is rejected by the risk engine, do not retry with the same parameters.",
        "5. For limit orders, monitor fill status and adjust or cancel if not filling.",
        "6. When your analysis is complete and all actions are taken, respond with a text summary of what you did and why.",
        "7. Keep your final summary concise: what you observed, what you did (or chose not to do), and why.",
    ].join("\n")
}
