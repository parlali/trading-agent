import { describe, expect, it } from "vitest"
import {
    parseStrategyMarkdownDocument,
    STRATEGY_MARKDOWN_VERSION_MARKER,
} from "./strategy-documents.ts"

describe("parseStrategyMarkdownDocument", () => {
    it("ignores top-level operator notes outside provider sections", () => {
        const markdown = `# Strategies

${STRATEGY_MARKDOWN_VERSION_MARKER}

## Operator Notes: Expected External Positions

These notes document manual exposure handling.

# Polymarket

## PM: Example

\`\`\`strategy
{
    "app": "polymarket",
    "enabled": true,
    "schedule": "*/20 * * * *",
    "policy": {
        "model": "openai/gpt-5.4",
        "maxBet": {
            "mode": "percentage",
            "value": 10
        },
        "dryRun": true
    }
}
\`\`\`

### Context

Example context
`

        const document = parseStrategyMarkdownDocument(markdown)

        expect(document.strategies).toHaveLength(1)
        expect(document.strategies[0]).toMatchObject({
            name: "PM: Example",
            app: "polymarket",
        })
    })

    it("fails closed for malformed strategy sections inside provider groups", () => {
        const markdown = `# Strategies

${STRATEGY_MARKDOWN_VERSION_MARKER}

# Polymarket

## PM: Missing Block

### Context

This should still fail because it is inside a provider section.
`

        expect(() => parseStrategyMarkdownDocument(markdown)).toThrow(
            'Invalid strategy config JSON for "PM: Missing Block": Missing ```strategy block for "PM: Missing Block"'
        )
    })
})
