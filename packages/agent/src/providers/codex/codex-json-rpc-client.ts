import type { Logger } from "@valiq-trading/core"

export type JsonRpcId = string | number

export interface JsonRpcErrorPayload {
    code: number
    message: string
    data?: unknown
}

export interface JsonRpcMessage {
    jsonrpc?: "2.0"
    id?: JsonRpcId
    method?: string
    params?: unknown
    result?: unknown
    error?: JsonRpcErrorPayload
}

export interface CodexJsonRpcTransport {
    writeLine(line: string): Promise<void>
    close(): void
    onMessage(handler: (message: JsonRpcMessage) => void): void
    onError(handler: (error: Error) => void): void
    onClose(handler: () => void): void
}

export interface CodexJsonRpcClientConfig {
    transport: CodexJsonRpcTransport
    logger?: Logger
    requestTimeoutMs?: number
    onNotification?: (message: JsonRpcMessage) => void
    onServerRequest?: (message: JsonRpcMessage, client: CodexJsonRpcClient) => Promise<void> | void
}

export interface CodexAppServerSpawnConfig {
    command: string
    args: string[]
    env?: Record<string, string | undefined>
    cwd?: string
    logger?: Logger
    requestTimeoutMs?: number
    onNotification?: CodexJsonRpcClientConfig["onNotification"]
    onServerRequest?: CodexJsonRpcClientConfig["onServerRequest"]
}

interface PendingRequest {
    resolve(value: unknown): void
    reject(reason: Error): void
    timer: ReturnType<typeof setTimeout>
}

interface BunFileSink {
    write(data: Uint8Array | string): number | Promise<number>
    flush?(): void | Promise<void>
    end?(): void | Promise<void>
}

type BunStdin = WritableStream<Uint8Array> | BunFileSink

type ProcessStdinWriter = {
    write(data: Uint8Array): Promise<void>
    close(): Promise<void>
}

type BunSpawnProcess = {
    stdin: BunStdin
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
    kill(signal?: string): void
}

type BunRuntime = {
    spawn(args: string[], options: {
        stdin: "pipe"
        stdout: "pipe"
        stderr: "pipe"
        cwd?: string
        env?: Record<string, string | undefined>
    }): BunSpawnProcess
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

export class CodexJsonRpcClient {
    private nextId = 1
    private closed = false
    private readonly pending = new Map<JsonRpcId, PendingRequest>()
    private readonly requestTimeoutMs: number

    constructor(private readonly config: CodexJsonRpcClientConfig) {
        this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
        config.transport.onMessage((message) => this.handleMessage(message))
        config.transport.onError((error) => this.handleTransportError(error))
        config.transport.onClose(() => this.handleTransportClosed())
    }

    static spawn(config: CodexAppServerSpawnConfig): CodexJsonRpcClient {
        return new CodexJsonRpcClient({
            transport: spawnCodexAppServerTransport(config),
            logger: config.logger,
            requestTimeoutMs: config.requestTimeoutMs,
            onNotification: config.onNotification,
            onServerRequest: config.onServerRequest,
        })
    }

    async initialize(): Promise<unknown> {
        const result = await this.request("initialize", {
            clientInfo: {
                name: "valiq-trading-backend",
                version: "1.0.0",
            },
            capabilities: {
                experimentalApi: true,
            },
        })
        await this.notify("initialized", {})
        return result
    }

    async request(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
        if (this.closed) {
            throw new Error(`Cannot send Codex app-server request ${method}: transport is closed`)
        }

        const id = this.nextId++
        const requestPromise = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`Codex app-server request timed out: ${method}`))
            }, timeoutMs)
            this.pending.set(id, { resolve, reject, timer })
        })

        try {
            await this.write({ id, method, params })
        } catch (error) {
            const pending = this.pending.get(id)
            if (pending) {
                clearTimeout(pending.timer)
                this.pending.delete(id)
            }
            throw error
        }

        return await requestPromise
    }

    async notify(method: string, params?: unknown): Promise<void> {
        if (this.closed) {
            return
        }
        await this.write({ method, params })
    }

    async respond(id: JsonRpcId, result: unknown): Promise<void> {
        await this.write({ id, result })
    }

    async reject(id: JsonRpcId, error: JsonRpcErrorPayload): Promise<void> {
        await this.write({ id, error })
    }

    close(): void {
        if (this.closed) {
            return
        }
        this.closed = true
        this.config.transport.close()
        this.rejectAllPending(new Error("Codex app-server transport closed"))
    }

    private async write(message: JsonRpcMessage): Promise<void> {
        await this.config.transport.writeLine(JSON.stringify({
            jsonrpc: "2.0",
            ...message,
        }))
    }

    private handleMessage(message: JsonRpcMessage): void {
        if (message.id !== undefined && !message.method) {
            const pending = this.pending.get(message.id)
            if (!pending) {
                this.config.logger?.warn("Received Codex app-server response for unknown request", {
                    id: message.id,
                })
                return
            }

            clearTimeout(pending.timer)
            this.pending.delete(message.id)

            if (message.error) {
                pending.reject(new Error(`Codex app-server error ${message.error.code}: ${message.error.message}`))
                return
            }

            pending.resolve(message.result)
            return
        }

        if (message.id !== undefined && message.method) {
            if (!this.config.onServerRequest) {
                void this.reject(message.id, {
                    code: -32601,
                    message: "server request handler missing",
                }).catch((error) => {
                    this.config.logger?.error("Codex app-server server-request rejection failed", {
                        method: message.method,
                        error: error instanceof Error ? error.message : String(error),
                    })
                })
                return
            }

            void Promise.resolve(this.config.onServerRequest(message, this)).catch((error) => {
                const messageText = error instanceof Error ? error.message : String(error)
                this.config.logger?.error("Codex app-server server-request handler failed", {
                    method: message.method,
                    error: messageText,
                })
                void this.reject(message.id!, {
                    code: -32000,
                    message: messageText,
                }).catch((rejectError) => {
                    this.config.logger?.error("Codex app-server server-request error response failed", {
                        method: message.method,
                        error: rejectError instanceof Error ? rejectError.message : String(rejectError),
                    })
                })
            })
            return
        }

        if (message.method) {
            this.config.onNotification?.(message)
        }
    }

    private handleTransportError(error: Error): void {
        this.config.logger?.error("Codex app-server transport error", {
            error: error.message,
        })
        this.rejectAllPending(error)
    }

    private handleTransportClosed(): void {
        if (this.closed) {
            return
        }
        this.closed = true
        this.rejectAllPending(new Error("Codex app-server transport closed"))
    }

    private rejectAllPending(error: Error): void {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer)
            pending.reject(error)
            this.pending.delete(id)
        }
    }
}

export function spawnCodexAppServerTransport(config: CodexAppServerSpawnConfig): CodexJsonRpcTransport {
    const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
    if (!bun) {
        throw new Error("Codex app-server provider requires Bun runtime")
    }

    const process = bun.spawn([config.command, ...config.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: config.cwd,
        env: config.env,
    })

    const transport = new ProcessJsonRpcTransport(process, config.logger)
    transport.start()
    return transport
}

class ProcessJsonRpcTransport implements CodexJsonRpcTransport {
    private readonly messageHandlers = new Set<(message: JsonRpcMessage) => void>()
    private readonly errorHandlers = new Set<(error: Error) => void>()
    private readonly closeHandlers = new Set<() => void>()
    private readonly writer: ProcessStdinWriter
    private readonly encoder = new TextEncoder()
    private writeQueue = Promise.resolve()
    private closed = false

    constructor(
        private readonly process: BunSpawnProcess,
        private readonly logger?: Logger
    ) {
        this.writer = createProcessStdinWriter(process.stdin)
    }

    start(): void {
        void readJsonLines(
            this.process.stdout,
            (message) => this.emitMessage(message),
            (error) => this.emitError(error)
        )
        void readTextLines(
            this.process.stderr,
            (line) => {
                if (line.trim().length > 0) {
                    this.logger?.warn("Codex app-server stderr", { message: line })
                }
            },
            (error) => this.emitError(error)
        )
        void this.process.exited.then((exitCode) => {
            this.logger?.info("Codex app-server exited", { exitCode })
            this.emitClose()
        }).catch((error) => {
            this.emitError(error instanceof Error ? error : new Error(String(error)))
        })
    }

    async writeLine(line: string): Promise<void> {
        this.writeQueue = this.writeQueue.then(async () => {
            if (this.closed) {
                throw new Error("Cannot write to closed Codex app-server transport")
            }
            await this.writer.write(this.encoder.encode(`${line}\n`))
        })
        await this.writeQueue
    }

    close(): void {
        if (this.closed) {
            return
        }
        this.closed = true
        void this.writer.close().catch(() => undefined)
        this.process.kill("SIGTERM")
        this.emitClose()
    }

    onMessage(handler: (message: JsonRpcMessage) => void): void {
        this.messageHandlers.add(handler)
    }

    onError(handler: (error: Error) => void): void {
        this.errorHandlers.add(handler)
    }

    onClose(handler: () => void): void {
        this.closeHandlers.add(handler)
    }

    private emitMessage(message: JsonRpcMessage): void {
        for (const handler of this.messageHandlers) {
            handler(message)
        }
    }

    private emitError(error: Error): void {
        for (const handler of this.errorHandlers) {
            handler(error)
        }
    }

    private emitClose(): void {
        for (const handler of this.closeHandlers) {
            handler()
        }
    }
}

export function createProcessStdinWriter(stdin: BunStdin): ProcessStdinWriter {
    if (isWritableStream(stdin)) {
        const writer = stdin.getWriter()
        return {
            async write(data) {
                await writer.write(data)
            },
            async close() {
                await writer.close()
            },
        }
    }

    return {
        async write(data) {
            await stdin.write(data)
            await stdin.flush?.()
        },
        async close() {
            await stdin.end?.()
        },
    }
}

function isWritableStream(stdin: BunStdin): stdin is WritableStream<Uint8Array> {
    return typeof (stdin as Partial<WritableStream<Uint8Array>>).getWriter === "function"
}

async function readJsonLines(
    stream: ReadableStream<Uint8Array>,
    onMessage: (message: JsonRpcMessage) => void,
    onError: (error: Error) => void
): Promise<void> {
    await readTextLines(stream, (line) => {
        const trimmed = line.trim()
        if (trimmed.length === 0) {
            return
        }

        try {
            onMessage(JSON.parse(trimmed) as JsonRpcMessage)
        } catch (error) {
            onError(error instanceof Error ? error : new Error(String(error)))
        }
    }, onError)
}

async function readTextLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
    onError: (error: Error) => void
): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""
            for (const line of lines) {
                onLine(line)
            }
        }

        buffer += decoder.decode()
        if (buffer.trim().length > 0) {
            onLine(buffer)
        }
    } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)))
    } finally {
        reader.releaseLock()
    }
}
