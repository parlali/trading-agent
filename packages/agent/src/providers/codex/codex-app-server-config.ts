import type { RunToolServer } from "../../mcp/run-tool-server"

export type CodexAuthMode = "chatgpt" | "access-token" | "api-key"
export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none"

export interface CodexAppServerProviderConfig {
    provider: "codex"
    model: string
    effort?: CodexReasoningEffort
    summary?: CodexReasoningSummary
    serviceTier?: string
    authMode: CodexAuthMode
    codexBin?: string
    codexAccessToken?: string
    openAiApiKey?: string
    requestTimeoutMs?: number
    turnTimeoutMs?: number
    runDirectory?: string
    appServerArgs?: string[]
    onChatGptAuthRefreshed?: (auth: CodexChatGptAuthRefreshSnapshot) => Promise<void>
}

export interface CodexChatGptAuthRefreshSnapshot {
    authJson: string
    accountId: string
    lastRefresh?: string
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000
export const CODEX_RUN_MCP_SERVER_NAME = "valiq_run"

const MCP_TOKEN_ENV_VAR = "VALIQ_CODEX_MCP_TOKEN"
const DISABLED_CODEX_FEATURE_NAMES = [
    "apps",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "multi_agent",
    "plugins",
    "shell_tool",
    "unified_exec",
    "web_search",
    "web_search_cached",
    "web_search_request",
    "workspace_dependencies",
] as const
const DISABLED_INHERITED_PLUGIN_NAMES = [
    "browser@openai-bundled",
    "documents@openai-primary-runtime",
    "github@openai-curated",
    "presentations@openai-primary-runtime",
    "spreadsheets@openai-primary-runtime",
] as const

export function buildCodexAppServerArgs(
    config: CodexAppServerProviderConfig,
    mcpServer: RunToolServer
): string[] {
    const overrides = buildCodexConfigOverrides(config, mcpServer)
    return [
        "app-server",
        "--strict-config",
        ...(config.appServerArgs ?? []),
        ...overrides.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    ]
}

export function buildCodexThreadConfig(mcpServer: RunToolServer): Record<string, unknown> {
    return {
        web_search: "disabled",
        approval_policy: "never",
        approvals_reviewer: "user",
        sandbox_mode: "read-only",
        allow_login_shell: false,
        features: Object.fromEntries(DISABLED_CODEX_FEATURE_NAMES.map((name) => [name, false])),
        plugins: Object.fromEntries(DISABLED_INHERITED_PLUGIN_NAMES.map((name) => [
            name,
            {
                enabled: false,
            },
        ])),
        mcp_servers: {
            [CODEX_RUN_MCP_SERVER_NAME]: {
                enabled: true,
                required: true,
                url: mcpServer.url,
                bearer_token_env_var: MCP_TOKEN_ENV_VAR,
                enabled_tools: mcpServer.toolNames,
                default_tools_approval_mode: "approve",
                tool_timeout_sec: 120,
            },
        },
    }
}

export function buildCodexEnvironment(
    config: CodexAppServerProviderConfig,
    mcpToken: string
): Record<string, string | undefined> {
    const env = pickCodexEnvironment(process.env, [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "TEMP",
        "TMP",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "CODEX_HOME",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
    ])

    return withCodexCredentials({
        ...env,
        [MCP_TOKEN_ENV_VAR]: mcpToken,
    }, config)
}

export function resolveBillingMode(authMode: CodexAuthMode): string {
    return authMode === "api-key" ? "platform-api" : "codex-subscription"
}

function buildCodexConfigOverrides(
    config: CodexAppServerProviderConfig,
    mcpServer: RunToolServer
): Array<[string, string]> {
    const overrides: Array<[string, string]> = [
        ["web_search", tomlString("disabled")],
        ["approval_policy", tomlString("never")],
        ["approvals_reviewer", tomlString("user")],
        ["sandbox_mode", tomlString("read-only")],
        ["allow_login_shell", "false"],
        ...DISABLED_CODEX_FEATURE_NAMES.map((name) =>
            [`features.${name}`, "false"] as [string, string]
        ),
        ...DISABLED_INHERITED_PLUGIN_NAMES.map((name) =>
            [`plugins.${tomlQuotedPathSegment(name)}.enabled`, "false"] as [string, string]
        ),
        [`mcp_servers.${CODEX_RUN_MCP_SERVER_NAME}.enabled`, "true"],
        [`mcp_servers.${CODEX_RUN_MCP_SERVER_NAME}.required`, "true"],
        [`mcp_servers.${CODEX_RUN_MCP_SERVER_NAME}.url`, tomlString(mcpServer.url)],
        [`mcp_servers.${CODEX_RUN_MCP_SERVER_NAME}.bearer_token_env_var`, tomlString(MCP_TOKEN_ENV_VAR)],
        [`mcp_servers.${CODEX_RUN_MCP_SERVER_NAME}.enabled_tools`, tomlStringArray(mcpServer.toolNames)],
        [`mcp_servers.${CODEX_RUN_MCP_SERVER_NAME}.default_tools_approval_mode`, tomlString("approve")],
        [`mcp_servers.${CODEX_RUN_MCP_SERVER_NAME}.tool_timeout_sec`, "120.0"],
    ]

    if (config.effort) {
        overrides.push(["model_reasoning_effort", tomlString(config.effort)])
    }
    if (config.summary) {
        overrides.push(["model_reasoning_summary", tomlString(config.summary)])
    }
    if (config.serviceTier) {
        overrides.push(["service_tier", tomlString(config.serviceTier)])
    }

    return overrides
}

function pickCodexEnvironment(
    env: Record<string, string | undefined>,
    names: string[]
): Record<string, string | undefined> {
    return Object.fromEntries(
        names
            .map((name) => [name, env[name]] as const)
            .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    )
}

function withCodexCredentials(
    env: Record<string, string | undefined>,
    config: CodexAppServerProviderConfig
): Record<string, string | undefined> {
    if (config.authMode === "access-token") {
        const accessToken = config.codexAccessToken ?? process.env.CODEX_ACCESS_TOKEN
        if (!accessToken) {
            throw new Error("Cannot run Codex provider: CODEX_ACCESS_TOKEN is required for access-token auth")
        }
        env.CODEX_ACCESS_TOKEN = accessToken
    }

    if (config.authMode === "api-key") {
        const apiKey = config.openAiApiKey ?? process.env.OPENAI_API_KEY
        if (!apiKey) {
            throw new Error("Cannot run Codex provider: OPENAI_API_KEY is required for api-key auth")
        }
        env.OPENAI_API_KEY = apiKey
    }

    return env
}

function tomlString(value: string): string {
    return JSON.stringify(value)
}

function tomlStringArray(values: string[]): string {
    return `[${values.map((value) => tomlString(value)).join(", ")}]`
}

function tomlQuotedPathSegment(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
}
