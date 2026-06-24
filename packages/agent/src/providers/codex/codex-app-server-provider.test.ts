import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createLogger, type StrategyRunContext } from "@valiq-trading/core"
import { ConversationManager } from "../../conversation"
import { ToolRegistry } from "../../tool-registry"
import type { ToolExecutionEngine, ToolExecutionFatalFault } from "../../tool-execution-engine"
import type { AgentProviderRunArgs } from "../types"
import type { JsonRpcErrorPayload, JsonRpcId, JsonRpcMessage } from "./codex-json-rpc-client"
import {
    CodexAppServerProvider,
    buildCodexEnvironment,
    type CodexAppServerClient,
    type CodexAppServerClientFactoryArgs,
    type CodexAppServerProviderConfig,
    type CodexAppServerProviderDependencies,
} from "./codex-app-server-provider"
import { buildCodexAppServerArgs } from "./codex-app-server-config"

describe("CodexAppServerProvider", () => {
    it("accumulates assistant deltas, token usage, and final summary from notifications", async () => {
        let client: FakeCodexClient | undefined
        const provider = createProvider({
            createClient: (args) => {
                client = new FakeCodexClient(args, async (fake) => {
                    fake.emitNotification({
                        method: "item/agentMessage/delta",
                        params: { delta: "Codex " },
                    })
                    fake.emitNotification({
                        method: "item/agentMessage/delta",
                        params: { delta: "complete" },
                    })
                    fake.emitNotification({
                        method: "thread/tokenUsage/updated",
                        params: {
                            tokenUsage: {
                                last: {
                                    inputTokens: 17,
                                    outputTokens: 9,
                                    reasoningOutputTokens: 4,
                                },
                            },
                        },
                    })
                    fake.emitNotification({
                        method: "turn/completed",
                        params: {
                            threadId: "thread-1",
                            turn: {
                                id: "turn-1",
                                status: "completed",
                            },
                        },
                    })
                })
                return client
            },
        })

        const result = await provider.run(createRunArgs())

        expect(result.summary).toBe("Codex complete")
        expect(result.error).toBeUndefined()
        expect(result.usage).toMatchObject({
            promptTokens: 17,
            completionTokens: 9,
            reasoningTokens: 4,
        })
        expect(result.diagnostics).toMatchObject({
            provider: "codex",
            model: "codex-test",
            authMode: "chatgpt",
            codexThreadId: "thread-1",
            codexTurnIds: ["turn-1"],
            rateLimitSnapshotBefore: { before: true },
            rateLimitSnapshotAfter: { after: true },
        })
        expect(client?.requests.map((request) => request.method)).toContain("thread/start")
        expect(client?.requests.map((request) => request.method)).toContain("turn/start")
        expect(client?.requests.find((request) => request.method === "account/read")?.params).toMatchObject({
            refreshToken: true,
        })
        const threadStart = client?.requests.find((request) => request.method === "thread/start")
        expect(threadStart?.params).toMatchObject({
            runtimeWorkspaceRoots: [],
            approvalPolicy: "never",
            sandbox: "read-only",
            environments: [],
            dynamicTools: [],
            baseInstructions: "Trading system prompt",
            developerInstructions: null,
            config: {
                web_search: "disabled",
                approval_policy: "never",
                sandbox_mode: "read-only",
                allow_login_shell: false,
                features: {
                    apps: false,
                    browser_use: false,
                    browser_use_external: false,
                    computer_use: false,
                    image_generation: false,
                    multi_agent: false,
                    plugins: false,
                    shell_tool: false,
                    unified_exec: false,
                    web_search: false,
                    web_search_cached: false,
                    web_search_request: false,
                    workspace_dependencies: false,
                },
                plugins: {
                    "browser@openai-bundled": {
                        enabled: false,
                    },
                    "documents@openai-primary-runtime": {
                        enabled: false,
                    },
                    "github@openai-curated": {
                        enabled: false,
                    },
                    "presentations@openai-primary-runtime": {
                        enabled: false,
                    },
                    "spreadsheets@openai-primary-runtime": {
                        enabled: false,
                    },
                },
                mcp_servers: {
                    valiq_run: {
                        enabled: true,
                        required: true,
                        enabled_tools: ["fake_tool"],
                    },
                },
            },
        })
        const turnStart = client?.requests.find((request) => request.method === "turn/start")
        expect(turnStart?.params).toMatchObject({
            runtimeWorkspaceRoots: [],
            approvalPolicy: "never",
            sandbox: "read-only",
            environments: [],
        })
    })

    it("uses cached turn completion when Codex completes before wait registration", async () => {
        const provider = createProvider({
            createClient: (args) => new FakeCodexClient(args, async (fake) => {
                fake.emitNotification({
                    method: "item/agentMessage/delta",
                    params: { delta: "Early complete" },
                })
                fake.emitNotification({
                    method: "turn/completed",
                    params: {
                        threadId: "thread-1",
                        turn: {
                            id: "turn-1",
                            status: "completed",
                        },
                    },
                })
            }, {
                completeTurnBeforeResponse: true,
            }),
        })

        const result = await provider.run(createRunArgs())

        expect(result.summary).toBe("Early complete")
        expect(result.error).toBeUndefined()
    })

    it("resets run-scoped mutable state between provider runs", async () => {
        let run = 0
        const provider = createProvider({
            createClient: (args) => {
                run++
                return new FakeCodexClient(args, async (fake) => {
                    fake.emitNotification({
                        method: "item/agentMessage/delta",
                        params: { delta: run === 1 ? "First" : "Second" },
                    })
                    fake.emitNotification({
                        method: "turn/completed",
                        params: {
                            threadId: "thread-1",
                            turn: {
                                id: "turn-1",
                                status: "completed",
                            },
                        },
                    })
                })
            },
        })

        await expect(provider.run(createRunArgs())).resolves.toMatchObject({
            summary: "First",
        })
        await expect(provider.run(createRunArgs())).resolves.toMatchObject({
            summary: "Second",
            error: undefined,
        })
    })

    it("persists assistant transcript when post-turn provider reads fail", async () => {
        const provider = createProvider({
            createClient: (args) => new FakeCodexClient(args, async (fake) => {
                fake.emitNotification({
                    method: "item/agentMessage/delta",
                    params: { delta: "Need manual review" },
                })
                fake.emitNotification({
                    method: "turn/completed",
                    params: {
                        threadId: "thread-1",
                        turn: {
                            id: "turn-1",
                            status: "completed",
                        },
                    },
                })
            }, {
                rateLimitAfterError: new Error("rate limits unavailable"),
            }),
        })
        const runArgs = createRunArgs()

        const result = await provider.run(runArgs)

        expect(result.summary).toBe("Need manual review")
        expect(result.error).toBe("rate limits unavailable")
        const agentLogger = runArgs.agentLogger as { log: ReturnType<typeof vi.fn> }
        const assistantLog = agentLogger.log.mock.calls.find((call) => call[3] === "assistant")
        expect(assistantLog?.[2]).toBe(3)
        expect(assistantLog?.[4]).toBe("Need manual review")
    })

    it("builds a bounded Codex subprocess environment with only selected credentials", () => {
        const originalEnv = process.env
        process.env = {
            PATH: "/usr/bin",
            HOME: "/home/test",
            AWS_SECRET_ACCESS_KEY: "do-not-inherit",
            CODEX_ACCESS_TOKEN: "ambient-token",
        }

        try {
            const env = buildCodexEnvironment({
                provider: "codex",
                model: "codex-test",
                authMode: "access-token",
                codexAccessToken: "configured-token",
            }, "mcp-token")

            expect(env).toMatchObject({
                PATH: "/usr/bin",
                HOME: "/home/test",
                VALIQ_CODEX_MCP_TOKEN: "mcp-token",
                CODEX_ACCESS_TOKEN: "configured-token",
            })
            expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
        } finally {
            process.env = originalEnv
        }
    })

    it("isolates ChatGPT auth from inherited Codex config for provider runs", async () => {
        const originalEnv = process.env
        const sourceCodexHome = await mkdtemp(join(tmpdir(), "valiq-codex-source-"))
        const runDirectory = await mkdtemp(join(tmpdir(), "valiq-codex-run-"))
        let capturedEnv: Record<string, string | undefined> | undefined

        process.env = {
            PATH: "/usr/bin",
            HOME: "/home/test",
            CODEX_HOME: sourceCodexHome,
        }

        try {
            await writeFile(join(sourceCodexHome, "auth.json"), "{\"tokens\":true}")
            await writeFile(join(sourceCodexHome, "config.toml"), "[mcp_servers.openaiDeveloperDocs]\nenabled = true\n")

            const provider = createProvider({
                config: {
                    runDirectory,
                },
                createClient: (args) => {
                    capturedEnv = args.env
                    return new FakeCodexClient(args, async (fake) => {
                        fake.emitNotification({
                            method: "turn/completed",
                            params: {
                                threadId: "thread-1",
                                turn: {
                                    id: "turn-1",
                                    status: "completed",
                                },
                            },
                        })
                    })
                },
            })

            const result = await provider.run(createRunArgs())
            const isolatedCodexHome = join(runDirectory, "codex-home")

            expect(result.error).toBeUndefined()
            expect(capturedEnv?.CODEX_HOME).toBe(isolatedCodexHome)
            await expect(readFile(join(isolatedCodexHome, "auth.json"), "utf8")).resolves.toBe("{\"tokens\":true}")
            await expect(access(join(isolatedCodexHome, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" })
        } finally {
            process.env = originalEnv
            await rm(sourceCodexHome, { recursive: true, force: true })
            await rm(runDirectory, { recursive: true, force: true })
        }
    })

    it("uses file-backed ChatGPT credentials for app-server runs", () => {
        const args = buildCodexAppServerArgs({
            provider: "codex",
            model: "codex-test",
            authMode: "chatgpt",
        }, {
            url: "http://127.0.0.1:1234/mcp",
            token: "mcp-token",
            toolNames: ["fake_tool"],
            close: async () => undefined,
        })

        expect(args).toContain("cli_auth_credentials_store=\"file\"")
    })

    it("persists refreshed isolated ChatGPT auth back to the source Codex auth file", async () => {
        const originalEnv = process.env
        const sourceCodexHome = await mkdtemp(join(tmpdir(), "valiq-codex-source-"))
        const runDirectory = await mkdtemp(join(tmpdir(), "valiq-codex-run-"))
        const onChatGptAuthRefreshed = vi.fn(async () => undefined)
        const staleAuth = JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
                id_token: "old-id",
                access_token: "old-access",
                refresh_token: "refresh",
                account_id: "account-1",
            },
            last_refresh: "2026-06-19T16:00:00.000Z",
        }, null, 4)
        const refreshedAuth = JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
                id_token: "new-id",
                access_token: "new-access",
                refresh_token: "refresh",
                account_id: "account-1",
            },
            last_refresh: "2026-06-21T21:00:00.000Z",
        }, null, 4)

        process.env = {
            PATH: "/usr/bin",
            HOME: "/home/test",
            CODEX_HOME: sourceCodexHome,
        }

        try {
            await writeFile(join(sourceCodexHome, "auth.json"), staleAuth)

            const provider = createProvider({
                config: {
                    runDirectory,
                    onChatGptAuthRefreshed,
                },
                createClient: (args) => new FakeCodexClient(args, async (fake) => {
                    fake.emitNotification({
                        method: "turn/completed",
                        params: {
                            threadId: "thread-1",
                            turn: {
                                id: "turn-1",
                                status: "completed",
                            },
                        },
                    })
                }, {
                    accountReadSideEffect: async () => {
                        await writeFile(join(args.env.CODEX_HOME!, "auth.json"), refreshedAuth)
                    },
                }),
            })

            const result = await provider.run(createRunArgs())

            expect(result.error).toBeUndefined()
            await expect(readFile(join(sourceCodexHome, "auth.json"), "utf8")).resolves.toBe(refreshedAuth)
            expect(onChatGptAuthRefreshed).toHaveBeenCalledWith({
                authJson: refreshedAuth,
                accountId: "account-1",
                lastRefresh: "2026-06-21T21:00:00.000Z",
            })
        } finally {
            process.env = originalEnv
            await rm(sourceCodexHome, { recursive: true, force: true })
            await rm(runDirectory, { recursive: true, force: true })
        }
    })

    it("serializes ChatGPT auth refresh across concurrent provider runs", async () => {
        const originalEnv = process.env
        const sourceCodexHome = await mkdtemp(join(tmpdir(), "valiq-codex-source-"))
        const runDirectoryA = await mkdtemp(join(tmpdir(), "valiq-codex-run-"))
        const runDirectoryB = await mkdtemp(join(tmpdir(), "valiq-codex-run-"))
        const observedRefreshTokens: string[] = []

        process.env = {
            PATH: "/usr/bin",
            HOME: "/home/test",
            CODEX_HOME: sourceCodexHome,
        }

        try {
            await writeFile(join(sourceCodexHome, "auth.json"), buildAuthJson({
                idToken: "id-0",
                accessToken: "access-0",
                refreshToken: "refresh-0",
                lastRefresh: "2026-06-19T16:00:00.000Z",
            }))

            const createLockedProvider = (runDirectory: string) => createProvider({
                config: {
                    runDirectory,
                },
                createClient: (args) => new FakeCodexClient(args, async (fake) => {
                    fake.emitNotification({
                        method: "turn/completed",
                        params: {
                            threadId: "thread-1",
                            turn: {
                                id: "turn-1",
                                status: "completed",
                            },
                        },
                    })
                }, {
                    accountReadSideEffect: async () => {
                        const auth = JSON.parse(await readFile(join(args.env.CODEX_HOME!, "auth.json"), "utf8")) as {
                            tokens: {
                                refresh_token: string
                            }
                        }
                        observedRefreshTokens.push(auth.tokens.refresh_token)
                        const refreshIndex = observedRefreshTokens.length
                        await writeFile(join(args.env.CODEX_HOME!, "auth.json"), buildAuthJson({
                            idToken: `id-${refreshIndex}`,
                            accessToken: `access-${refreshIndex}`,
                            refreshToken: `refresh-${refreshIndex}`,
                            lastRefresh: `2026-06-21T21:00:0${refreshIndex}.000Z`,
                        }))
                    },
                }),
            })

            const [first, second] = await Promise.all([
                createLockedProvider(runDirectoryA).run(createRunArgs()),
                createLockedProvider(runDirectoryB).run(createRunArgs()),
            ])

            expect(first.error).toBeUndefined()
            expect(second.error).toBeUndefined()
            expect(observedRefreshTokens).toEqual(["refresh-0", "refresh-1"])
            const sourceAuth = JSON.parse(await readFile(join(sourceCodexHome, "auth.json"), "utf8")) as {
                tokens: {
                    refresh_token: string
                }
            }
            expect(sourceAuth.tokens.refresh_token).toBe("refresh-2")
        } finally {
            process.env = originalEnv
            await rm(sourceCodexHome, { recursive: true, force: true })
            await rm(runDirectoryA, { recursive: true, force: true })
            await rm(runDirectoryB, { recursive: true, force: true })
        }
    })

    it("does not infer access-token identity from requiresOpenaiAuth alone", async () => {
        const provider = createProvider({
            config: {
                authMode: "access-token",
                codexAccessToken: "test-token",
            },
            createClient: (args) => new FakeCodexClient(args, () => undefined, {
                accountRead: {
                    requiresOpenaiAuth: false,
                },
            }),
        })

        const result = await provider.run(createRunArgs())

        expect(result.error).toContain("Codex auth mode mismatch: expected access-token, app-server reported missing")
    })

    it("fails closed when Codex starts a non-run MCP server", async () => {
        let client: FakeCodexClient | undefined
        const provider = createProvider({
            createClient: (args) => {
                client = new FakeCodexClient(args, async (fake) => {
                    fake.emitNotification({
                        method: "mcpServer/startupStatus/updated",
                        params: {
                            name: "openaiDeveloperDocs",
                            status: "ready",
                            error: null,
                        },
                    })
                    fake.emitNotification({
                        method: "turn/completed",
                        params: {
                            threadId: "thread-1",
                            turn: {
                                id: "turn-1",
                                status: "completed",
                            },
                        },
                    })
                })
                return client
            },
        })

        const result = await provider.run(createRunArgs())

        expect(result.error).toContain("Codex started non-run MCP server openaiDeveloperDocs with status ready")
        expect(client?.requests.some((request) => request.method === "turn/interrupt")).toBe(true)
    })

    it("declines forbidden approval requests, interrupts the turn, and fails the run", async () => {
        let client: FakeCodexClient | undefined
        const provider = createProvider({
            createClient: (args) => {
                client = new FakeCodexClient(args, async (fake) => {
                    await fake.emitServerRequest({
                        id: "approval-1",
                        method: "item/commandExecution/requestApproval",
                        params: {},
                    })
                    fake.emitNotification({
                        method: "turn/completed",
                        params: {
                            threadId: "thread-1",
                            turn: {
                                id: "turn-1",
                                status: "completed",
                            },
                        },
                    })
                })
                return client
            },
        })

        const result = await provider.run(createRunArgs())

        expect(result.error).toContain("Codex attempted forbidden capability through item/commandExecution/requestApproval")
        expect(client?.responses).toEqual([{
            id: "approval-1",
            result: { decision: "decline" },
        }])
        expect(client?.requests.some((request) => request.method === "turn/interrupt")).toBe(true)
    })

    it("rejects forbidden permission requests, interrupts the turn, and fails the run", async () => {
        let client: FakeCodexClient | undefined
        const provider = createProvider({
            createClient: (args) => {
                client = new FakeCodexClient(args, async (fake) => {
                    await fake.emitServerRequest({
                        id: "permissions-1",
                        method: "item/permissions/requestApproval",
                        params: {},
                    })
                    fake.emitNotification({
                        method: "turn/completed",
                        params: {
                            threadId: "thread-1",
                            turn: {
                                id: "turn-1",
                                status: "completed",
                            },
                        },
                    })
                })
                return client
            },
        })

        const result = await provider.run(createRunArgs())

        expect(result.error).toContain("Codex attempted forbidden capability through item/permissions/requestApproval")
        expect(client?.rejections).toEqual([{
            id: "permissions-1",
            error: {
                code: -32000,
                message: "Codex attempted forbidden capability through item/permissions/requestApproval",
            },
        }])
        expect(client?.requests.some((request) => request.method === "turn/interrupt")).toBe(true)
    })

    it("interrupts the turn when the shared tool engine enters fatal state", async () => {
        let fatalFault: ToolExecutionFatalFault | undefined
        let triggerFatalFault: (() => Promise<void> | void) | undefined
        let client: FakeCodexClient | undefined
        const provider = createProvider({
            startRunToolServer: async (args) => {
                triggerFatalFault = args.onFatalFault
                return createFakeMcpServer()
            },
            createClient: (args) => {
                client = new FakeCodexClient(args, async (fake) => {
                    fatalFault = {
                        toolName: "propose_order",
                        toolResult: "{\"error\":\"credential missing\"}",
                        reason: "safety-critical propose_order tool failure",
                    }
                    await triggerFatalFault?.()
                    fake.emitNotification({
                        method: "turn/completed",
                        params: {
                            threadId: "thread-1",
                            turn: {
                                id: "turn-1",
                                status: "completed",
                            },
                        },
                    })
                })
                return client
            },
        })

        const result = await provider.run(createRunArgs({
            toolEngine: createFakeToolEngine(() => fatalFault),
        }))

        expect(result.error).toContain("Circuit breaker: safety-critical propose_order tool failure")
        expect(client?.requests.some((request) => request.method === "turn/interrupt")).toBe(true)
    })
})

class FakeCodexClient implements CodexAppServerClient {
    readonly requests: Array<{ method: string; params?: unknown }> = []
    readonly responses: Array<{ id: JsonRpcId; result: unknown }> = []
    readonly rejections: Array<{ id: JsonRpcId; error: JsonRpcErrorPayload }> = []
    private rateLimitReads = 0

    constructor(
        private readonly args: CodexAppServerClientFactoryArgs,
        private readonly completeTurn: (client: FakeCodexClient) => Promise<void> | void,
        private readonly options: {
            completeTurnBeforeResponse?: boolean
            accountRead?: unknown
            accountReadSideEffect?: () => Promise<void> | void
            rateLimitAfterError?: Error
        } = {}
    ) {}

    async initialize(): Promise<unknown> {
        this.requests.push({ method: "initialize" })
        return {}
    }

    async request(method: string, params?: unknown): Promise<unknown> {
        this.requests.push({ method, params })

        if (method === "account/read") {
            await this.options.accountReadSideEffect?.()
            return this.options.accountRead ?? {
                account: {
                    type: "chatgpt",
                },
                requiresOpenaiAuth: false,
            }
        }
        if (method === "account/rateLimits/read") {
            this.rateLimitReads++
            if (this.rateLimitReads > 1 && this.options.rateLimitAfterError) {
                throw this.options.rateLimitAfterError
            }
            return this.rateLimitReads === 1
                ? { rateLimits: { before: true } }
                : { rateLimits: { after: true } }
        }
        if (method === "thread/start") {
            return { thread: { id: "thread-1" } }
        }
        if (method === "turn/start") {
            if (this.options.completeTurnBeforeResponse) {
                await this.completeTurn(this)
            } else {
                setTimeout(() => {
                    void this.completeTurn(this)
                }, 0)
            }
            return { turn: { id: "turn-1" } }
        }
        if (method === "turn/interrupt") {
            return {}
        }

        throw new Error(`Unexpected request ${method}`)
    }

    async respond(id: JsonRpcId, result: unknown): Promise<void> {
        this.responses.push({ id, result })
    }

    async reject(id: JsonRpcId, error: JsonRpcErrorPayload): Promise<void> {
        this.rejections.push({ id, error })
    }

    close(): void {}

    emitNotification(message: JsonRpcMessage): void {
        this.args.onNotification(message)
    }

    async emitServerRequest(message: JsonRpcMessage): Promise<void> {
        await this.args.onServerRequest(message, this)
    }
}

function createProvider(
    dependencies: Partial<CodexAppServerProviderDependencies> & {
        config?: Partial<CodexAppServerProviderConfig>
    }
): CodexAppServerProvider {
    const { config, ...providerDependencies } = dependencies
    return new CodexAppServerProvider({
        provider: "codex",
        model: "codex-test",
        authMode: "chatgpt",
        runDirectory: "/tmp/valiq-codex-provider-test",
        turnTimeoutMs: 1000,
        requestTimeoutMs: 1000,
        ...config,
    }, {
        startRunToolServer: async () => createFakeMcpServer(),
        ...providerDependencies,
    })
}

function buildAuthJson(args: {
    idToken: string
    accessToken: string
    refreshToken: string
    lastRefresh: string
}): string {
    return JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
            id_token: args.idToken,
            access_token: args.accessToken,
            refresh_token: args.refreshToken,
            account_id: "account-1",
        },
        last_refresh: args.lastRefresh,
    }, null, 4)
}

function createRunArgs(
    options: {
        toolEngine?: ToolExecutionEngine
    } = {}
): AgentProviderRunArgs {
    const conversation = new ConversationManager()
    conversation.addSystemMessage("Trading system prompt")
    conversation.addUserMessage("Run strategy")

    return {
        conversation,
        context: createContext(),
        tools: new ToolRegistry(),
        toolEngine: options.toolEngine ?? createFakeToolEngine(() => undefined),
        logger: createLogger({ minLevel: "fatal" }),
        agentLogger: {
            log: vi.fn(async () => undefined),
        },
        maxIterations: 1,
        maxConsecutiveErrors: 1,
        runStartedAt: Date.now(),
        runTimeoutMs: 10_000,
    }
}

function createContext(): StrategyRunContext {
    return {
        runId: "run-codex-provider-test",
        strategyId: "strategy-codex-provider-test",
        app: "polymarket",
        timestamp: Date.now(),
        trigger: "cron",
        positions: [],
        accountState: {
            balance: 10_000,
            equity: 10_000,
            buyingPower: 10_000,
            marginUsed: 0,
            marginAvailable: 10_000,
            openPnl: 0,
            dayPnl: 0,
        },
        policy: {
            dryRun: true,
            llm: {
                provider: "codex",
                model: "codex-test",
                authMode: "chatgpt",
            },
        },
        context: "test",
    }
}

function createFakeMcpServer() {
    return {
        url: "http://127.0.0.1:1/mcp",
        token: "test-token",
        toolNames: ["fake_tool"],
        close: vi.fn(async () => undefined),
    }
}

function createFakeToolEngine(
    readFatalFault: () => ToolExecutionFatalFault | undefined
): ToolExecutionEngine {
    return {
        getOutcome: () => ({
            opportunityCoverage: {
                researched: 0,
                qualified: 0,
                rejectedByModel: 0,
                rejectedByRisk: 0,
                submitted: 0,
                filled: 0,
                closed: 0,
                realizedPnl: 0,
            },
            toolCallCount: 0,
            degradedResearch: () => ({
                active: false,
                reasons: [],
                toolFailureCount: 0,
                retryCount: 0,
                decisionUnderDegradedContext: false,
            }),
            fatalFault: readFatalFault(),
        }),
    } as unknown as ToolExecutionEngine
}
