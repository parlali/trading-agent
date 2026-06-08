export const CODEX_APP_SERVER_REQUEST_METHODS = [
    "initialize",
    "account/read",
    "account/rateLimits/read",
    "thread/start",
    "turn/start",
    "turn/interrupt",
] as const

export const CODEX_APP_SERVER_NOTIFICATION_METHODS = [
    "item/agentMessage/delta",
    "item/started",
    "item/completed",
    "item/mcpToolCall/progress",
    "thread/tokenUsage/updated",
    "account/rateLimits/updated",
    "turn/completed",
    "mcpServer/startupStatus/updated",
    "error",
    "warning",
    "configWarning",
    "guardianWarning",
] as const

export const CODEX_APP_SERVER_CLIENT_NOTIFICATION_METHODS = [
    "initialized",
] as const

export const CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS = [
    "item/commandExecution/requestApproval",
    "execCommandApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "applyPatchApproval",
] as const

export type CodexAppServerRequestMethod = typeof CODEX_APP_SERVER_REQUEST_METHODS[number]
export type CodexAppServerNotificationMethod = typeof CODEX_APP_SERVER_NOTIFICATION_METHODS[number]
export type CodexAppServerClientNotificationMethod = typeof CODEX_APP_SERVER_CLIENT_NOTIFICATION_METHODS[number]
export type CodexAppServerApprovalRequestMethod = typeof CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS[number]

export interface CodexAuthStatus {
    authMethod: "apikey" | "chatgpt" | "chatgptAuthTokens" | "agentIdentity" | null
    authToken?: string | null
    requiresOpenaiAuth?: boolean | null
}

export interface CodexAccountReadResponse {
    account?: {
        type?: "apiKey" | "chatgpt" | "amazonBedrock" | "agentIdentity"
    } | null
    authMode?: CodexAuthStatus["authMethod"]
    authMethod?: CodexAuthStatus["authMethod"]
    requiresOpenaiAuth?: boolean | null
}

export interface CodexTurn {
    id?: string
    status?: "completed" | "interrupted" | "failed" | "inProgress"
    error?: {
        message?: string
        additionalDetails?: string | null
    } | null
}

export interface CodexTurnCompletion {
    threadId: string
    turn: CodexTurn
}

export interface CodexTokenUsageNotification {
    tokenUsage?: {
        total?: CodexTokenUsageBreakdown
        last?: CodexTokenUsageBreakdown
    }
}

export interface CodexTokenUsageBreakdown {
    totalTokens?: number
    inputTokens?: number
    outputTokens?: number
    reasoningOutputTokens?: number
}
