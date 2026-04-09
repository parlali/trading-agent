import { z } from "zod/v4";
import { strategyConfigSchema, validateStrategyConfig } from "./config";
export const STRATEGY_MARKDOWN_VERSION = 1;
export const STRATEGY_MARKDOWN_VERSION_MARKER = `<!-- strategy-doc:v${STRATEGY_MARKDOWN_VERSION} -->`;
const strategyMarkdownConfigSchema = z.object({
    app: strategyConfigSchema.shape.app,
    enabled: strategyConfigSchema.shape.enabled,
    schedule: strategyConfigSchema.shape.schedule,
    policy: strategyConfigSchema.shape.policy,
});
export function parseStrategyMarkdownDocument(markdown) {
    const normalized = markdown.replace(/\r\n/g, "\n");
    if (!normalized.includes(STRATEGY_MARKDOWN_VERSION_MARKER)) {
        throw new Error(`Strategy document is missing version marker ${STRATEGY_MARKDOWN_VERSION_MARKER}`);
    }
    const strategies = [];
    const names = new Set();
    const headings = Array.from(normalized.matchAll(/^##\s+(.+)$/gm));
    const sectionBoundaries = Array.from(normalized.matchAll(/^#{1,2}\s+.+$/gm))
        .map((match) => match.index ?? 0);
    for (let index = 0; index < headings.length; index++) {
        const heading = headings[index];
        const rawName = heading[1];
        if (!rawName) {
            throw new Error("Strategy heading cannot be empty");
        }
        const name = rawName.trim();
        const sectionStart = heading.index ?? 0;
        const sectionEnd = sectionBoundaries.find((boundary) => boundary > sectionStart) ?? normalized.length;
        const section = normalized.slice(sectionStart, sectionEnd).trim();
        if (names.has(name)) {
            throw new Error(`Duplicate strategy heading: ${name}`);
        }
        let parsedConfig;
        try {
            const configMatch = section.match(/```strategy\n([\s\S]*?)\n```/);
            if (!configMatch?.[1]) {
                throw new Error(`Missing \`\`\`strategy block for "${name}"`);
            }
            parsedConfig = JSON.parse(configMatch[1]);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid strategy config JSON for "${name}": ${message}`);
        }
        const config = strategyMarkdownConfigSchema.parse(parsedConfig);
        const contextMarker = "\n### Context\n";
        const contextIndex = section.indexOf(contextMarker);
        if (contextIndex === -1) {
            throw new Error(`Missing "### Context" section for "${name}"`);
        }
        const context = section.slice(contextIndex + contextMarker.length).trim();
        strategies.push(validateStrategyConfig({
            ...config,
            name,
            context,
        }));
        names.add(name);
    }
    if (strategies.length === 0) {
        throw new Error("No strategy sections found in markdown document");
    }
    return {
        version: STRATEGY_MARKDOWN_VERSION,
        strategies,
    };
}
