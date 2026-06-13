import { z } from "zod/v4"
import {
    accountConfigSchema,
    strategyConfigSchema,
    validateStrategyConfig,
    type AccountConfig,
    type StrategyConfig,
} from "./config"

export const STRATEGY_MARKDOWN_VERSION = 1
export const STRATEGY_MARKDOWN_VERSION_MARKER = `<!-- strategy-doc:v${STRATEGY_MARKDOWN_VERSION} -->`

const strategyMarkdownConfigSchema = z.object({
    app: strategyConfigSchema.shape.app,
    accountId: strategyConfigSchema.shape.accountId,
    enabled: strategyConfigSchema.shape.enabled,
    schedule: strategyConfigSchema.shape.schedule,
    policy: strategyConfigSchema.shape.policy,
})

export type StrategyMarkdownConfig = z.infer<typeof strategyMarkdownConfigSchema>

export interface StrategyMarkdownDocument {
    version: typeof STRATEGY_MARKDOWN_VERSION
    accounts: AccountConfig[]
    strategies: StrategyConfig[]
}

export function parseStrategyMarkdownDocument(markdown: string): StrategyMarkdownDocument {
    const normalized = markdown.replace(/\r\n/g, "\n")

    if (!normalized.includes(STRATEGY_MARKDOWN_VERSION_MARKER)) {
        throw new Error(
            `Strategy document is missing version marker ${STRATEGY_MARKDOWN_VERSION_MARKER}`
        )
    }

    const accounts = parseAccountConfigs(normalized)
    const strategies: StrategyConfig[] = []
    const names = new Set<string>()
    const headings = Array.from(normalized.matchAll(/^(#{1,2})\s+(.+)$/gm)).map((match) => ({
        depth: match[1]?.length ?? 0,
        name: match[2]?.trim() ?? "",
        index: match.index ?? 0,
    }))
    let currentSectionName: string | null = null

    for (let index = 0; index < headings.length; index++) {
        const heading = headings[index]!

        if (heading.depth === 1) {
            currentSectionName = heading.name === "Strategies" ? null : heading.name
            continue
        }

        if (currentSectionName === null) {
            continue
        }

        const name = heading.name

        if (!name) {
            throw new Error("Strategy heading cannot be empty")
        }

        const sectionStart = heading.index
        const sectionEnd = headings[index + 1]?.index ?? normalized.length
        const section = normalized.slice(sectionStart, sectionEnd).trim()

        if (names.has(name)) {
            throw new Error(`Duplicate strategy heading: ${name}`)
        }

        let parsedConfig: unknown

        try {
            const configMatch = section.match(/```strategy\n([\s\S]*?)\n```/)

            if (!configMatch?.[1]) {
                throw new Error(`Missing \`\`\`strategy block for "${name}"`)
            }

            parsedConfig = JSON.parse(configMatch[1])
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`Invalid strategy config JSON for "${name}": ${message}`)
        }

        const config = strategyMarkdownConfigSchema.parse(parsedConfig)
        assertStrategyAccountDeclared(config, accounts, name)
        const contextMarker = "\n### Context\n"
        const contextIndex = section.indexOf(contextMarker)

        if (contextIndex === -1) {
            throw new Error(`Missing "### Context" section for "${name}"`)
        }

        const context = section.slice(contextIndex + contextMarker.length).trim()

        strategies.push(
            validateStrategyConfig({
                ...config,
                name,
                context,
            })
        )
        names.add(name)
    }

    if (strategies.length === 0) {
        throw new Error("No strategy sections found in markdown document")
    }

    return {
        version: STRATEGY_MARKDOWN_VERSION,
        accounts,
        strategies,
    }
}

function parseAccountConfigs(markdown: string): AccountConfig[] {
    const accounts: AccountConfig[] = []
    const seen = new Set<string>()

    for (const match of markdown.matchAll(/```account\n([\s\S]*?)\n```/g)) {
        const raw = match[1]
        if (!raw) {
            continue
        }

        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`Invalid account config JSON: ${message}`)
        }

        const entries = Array.isArray(parsed) ? parsed : [parsed]
        for (const entry of entries) {
            const account = accountConfigSchema.parse(entry)
            const key = buildAccountKey(account.app, account.accountId)
            if (seen.has(key)) {
                throw new Error(`Duplicate account declaration: ${key}`)
            }

            seen.add(key)
            accounts.push(account)
        }
    }

    return accounts
}

function assertStrategyAccountDeclared(
    strategy: StrategyMarkdownConfig,
    accounts: AccountConfig[],
    name: string
): void {
    const key = buildAccountKey(strategy.app, strategy.accountId)
    const declared = accounts.some((account) =>
        account.app === strategy.app && account.accountId === strategy.accountId
    )

    if (!declared) {
        throw new Error(`Strategy "${name}" references undeclared account ${key}`)
    }
}

function buildAccountKey(app: string, accountId: string): string {
    return `${app}:${accountId}`
}
