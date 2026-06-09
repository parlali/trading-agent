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
    if (localStatus.ready) {
        args.logger.info("Codex ChatGPT auth already available locally", {
            hasAccountId: Boolean(localStatus.accountId),
            lastRefresh: localStatus.lastRefresh,
        })
        return
    }

    const persisted = await args.backend.getCodexChatGptAuth()
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
