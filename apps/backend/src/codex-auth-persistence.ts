import type { TradingBackendClient } from "@valiq-trading/convex"
import {
    inspectCodexChatGptAuthStatusSync,
    restoreCodexChatGptAuthFileSync,
    type CodexChatGptAuthFileSnapshot,
} from "./codex-auth"

type CodexAuthPersistenceLogger = {
    info(message: string, metadata?: Record<string, unknown>): void
    warn(message: string, metadata?: Record<string, unknown>): void
}

export async function restoreCodexChatGptAuthFromControlPlane(args: {
    backend: TradingBackendClient
    env?: Record<string, string | undefined>
    logger: CodexAuthPersistenceLogger
}): Promise<void> {
    const env = args.env ?? process.env
    const localStatus = inspectCodexChatGptAuthStatusSync(env)
    const persisted = await args.backend.getCodexChatGptAuth()
    if (localStatus.ready && !shouldRestorePersistedAuth(localStatus.lastRefresh, persisted?.lastRefresh ?? null)) {
        args.logger.info("Codex ChatGPT auth already available locally", {
            hasAccountId: Boolean(localStatus.accountId),
            lastRefresh: localStatus.lastRefresh,
        })
        return
    }

    if (!persisted) {
        args.logger.warn("Codex ChatGPT auth is not available locally and no persisted auth record exists")
        return
    }

    try {
        const restored = restoreCodexChatGptAuthFileSync({
            env,
            authJson: persisted.authJson,
        })
        args.logger.info("Restored Codex ChatGPT auth from control plane", {
            hasAccountId: Boolean(restored.accountId),
            lastRefresh: restored.lastRefresh,
            persistedUpdatedAt: persisted.updatedAt,
        })
    } catch (error) {
        args.logger.warn("Failed to restore persisted Codex ChatGPT auth", {
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

function shouldRestorePersistedAuth(localLastRefresh: string | null, persistedLastRefresh: string | null): boolean {
    if (!persistedLastRefresh) {
        return false
    }
    if (!localLastRefresh) {
        return true
    }

    const localTime = Date.parse(localLastRefresh)
    const persistedTime = Date.parse(persistedLastRefresh)
    if (!Number.isFinite(persistedTime)) {
        return false
    }
    if (!Number.isFinite(localTime)) {
        return true
    }

    return persistedTime > localTime
}

export async function persistCodexChatGptAuthToControlPlane(args: {
    backend: TradingBackendClient
    auth: CodexChatGptAuthFileSnapshot
    logger: CodexAuthPersistenceLogger
}): Promise<void> {
    await args.backend.storeCodexChatGptAuth({
        authJson: args.auth.authJson,
        accountId: args.auth.accountId,
        lastRefresh: args.auth.lastRefresh,
    })
    args.logger.info("Persisted Codex ChatGPT auth to control plane", {
        hasAccountId: Boolean(args.auth.accountId),
        lastRefresh: args.auth.lastRefresh,
    })
}
