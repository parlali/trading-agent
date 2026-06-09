import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface CodexChatGptAuthStatus {
    ready: boolean
    status: "ready" | "missing" | "invalid"
    codexHome: string
    authFilePath: string
    accountId: string | null
    lastRefresh: string | null
    message: string
}

export interface CodexChatGptAuthTokens {
    idToken: string
    accessToken: string
    refreshToken: string
    accountId: string
}

export function resolveCodexHome(env: Record<string, string | undefined> = process.env): string {
    const configuredHome = env.CODEX_HOME?.trim()
    if (configuredHome) {
        return configuredHome
    }

    const userHome = env.HOME?.trim() || homedir()
    return join(userHome, ".codex")
}

export function resolveCodexAuthFilePath(env: Record<string, string | undefined> = process.env): string {
    return join(resolveCodexHome(env), "auth.json")
}

export function inspectCodexChatGptAuthStatusSync(
    env: Record<string, string | undefined> = process.env
): CodexChatGptAuthStatus {
    const codexHome = resolveCodexHome(env)
    const authFilePath = resolveCodexAuthFilePath(env)

    if (!existsSync(authFilePath)) {
        return {
            ready: false,
            status: "missing",
            codexHome,
            authFilePath,
            accountId: null,
            lastRefresh: null,
            message: "Codex ChatGPT login is missing",
        }
    }

    try {
        const parsed = JSON.parse(readFileSync(authFilePath, "utf8")) as unknown
        const auth = readRecord(parsed)
        const tokens = readRecord(auth.tokens)
        const authMode = readString(auth.auth_mode)
        const accessToken = readString(tokens.access_token)
        const refreshToken = readString(tokens.refresh_token)
        const idToken = readString(tokens.id_token)
        const accountId = readString(tokens.account_id)
        const lastRefresh = readString(auth.last_refresh)

        if (authMode !== "chatgpt") {
            return invalidStatus(codexHome, authFilePath, "Codex auth file is not a ChatGPT login")
        }

        if (!accessToken || !refreshToken || !idToken || !accountId) {
            return invalidStatus(codexHome, authFilePath, "Codex ChatGPT login is incomplete")
        }

        return {
            ready: true,
            status: "ready",
            codexHome,
            authFilePath,
            accountId,
            lastRefresh,
            message: "Codex ChatGPT login is active",
        }
    } catch {
        return invalidStatus(codexHome, authFilePath, "Codex auth file could not be parsed")
    }
}

export function writeCodexChatGptAuthFileSync(args: {
    env?: Record<string, string | undefined>
    tokens: CodexChatGptAuthTokens
    refreshedAt?: Date
}): CodexChatGptAuthStatus {
    const env = args.env ?? process.env
    const authFilePath = resolveCodexAuthFilePath(env)
    const payload = {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
            id_token: args.tokens.idToken,
            access_token: args.tokens.accessToken,
            refresh_token: args.tokens.refreshToken,
            account_id: args.tokens.accountId,
        },
        last_refresh: (args.refreshedAt ?? new Date()).toISOString(),
    }

    mkdirSync(dirname(authFilePath), {
        recursive: true,
        mode: 0o700,
    })
    writeFileSync(authFilePath, `${JSON.stringify(payload, null, 4)}\n`, {
        mode: 0o600,
    })
    chmodSync(dirname(authFilePath), 0o700)
    chmodSync(authFilePath, 0o600)

    return inspectCodexChatGptAuthStatusSync(env)
}

function invalidStatus(codexHome: string, authFilePath: string, message: string): CodexChatGptAuthStatus {
    return {
        ready: false,
        status: "invalid",
        codexHome,
        authFilePath,
        accountId: null,
        lastRefresh: null,
        message,
    }
}

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function readString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null
}
