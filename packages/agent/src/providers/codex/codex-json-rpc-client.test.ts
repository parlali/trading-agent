import { describe, expect, it } from "vitest"
import {
    CodexJsonRpcClient,
    createProcessStdinWriter,
    type CodexJsonRpcTransport,
    type JsonRpcMessage,
} from "./codex-json-rpc-client"

class FakeTransport implements CodexJsonRpcTransport {
    readonly writes: JsonRpcMessage[] = []
    private messageHandler: ((message: JsonRpcMessage) => void) | undefined
    private errorHandler: ((error: Error) => void) | undefined
    private closeHandler: (() => void) | undefined

    async writeLine(line: string): Promise<void> {
        this.writes.push(JSON.parse(line) as JsonRpcMessage)
    }

    close(): void {
        this.closeHandler?.()
    }

    onMessage(handler: (message: JsonRpcMessage) => void): void {
        this.messageHandler = handler
    }

    onError(handler: (error: Error) => void): void {
        this.errorHandler = handler
    }

    onClose(handler: () => void): void {
        this.closeHandler = handler
    }

    emit(message: JsonRpcMessage): void {
        this.messageHandler?.(message)
    }

    emitError(error: Error): void {
        this.errorHandler?.(error)
    }
}

describe("CodexJsonRpcClient", () => {
    it("declares experimental API capability during initialize", async () => {
        const transport = new FakeTransport()
        const client = new CodexJsonRpcClient({
            transport,
            requestTimeoutMs: 1000,
        })

        const initialized = client.initialize()
        expect(transport.writes[0]).toMatchObject({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                capabilities: {
                    experimentalApi: true,
                },
            },
        })
        transport.emit({ id: 1, result: { ok: true } })

        await expect(initialized).resolves.toEqual({ ok: true })
        expect(transport.writes).toContainEqual({
            jsonrpc: "2.0",
            method: "initialized",
            params: {},
        })
    })

    it("correlates out-of-order JSON-RPC responses by id", async () => {
        const transport = new FakeTransport()
        const client = new CodexJsonRpcClient({
            transport,
            requestTimeoutMs: 1000,
        })

        const first = client.request("first", { index: 1 })
        const second = client.request("second", { index: 2 })

        expect(transport.writes).toMatchObject([
            { jsonrpc: "2.0", id: 1, method: "first", params: { index: 1 } },
            { jsonrpc: "2.0", id: 2, method: "second", params: { index: 2 } },
        ])

        transport.emit({ id: 2, result: { value: "second-result" } })
        transport.emit({ id: 1, result: { value: "first-result" } })

        await expect(first).resolves.toEqual({ value: "first-result" })
        await expect(second).resolves.toEqual({ value: "second-result" })
    })

    it("routes server requests to the supplied handler", async () => {
        const transport = new FakeTransport()
        const client = new CodexJsonRpcClient({
            transport,
            requestTimeoutMs: 1000,
            onServerRequest: async (message, activeClient) => {
                await activeClient.respond(message.id!, { decision: "decline" })
            },
        })

        transport.emit({
            id: "approval-1",
            method: "item/commandExecution/requestApproval",
            params: {},
        })

        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(client).toBeInstanceOf(CodexJsonRpcClient)
        expect(transport.writes).toContainEqual({
            jsonrpc: "2.0",
            id: "approval-1",
            result: { decision: "decline" },
        })
    })

    it("rejects server requests when no handler is registered", async () => {
        const transport = new FakeTransport()
        new CodexJsonRpcClient({
            transport,
            requestTimeoutMs: 1000,
        })

        transport.emit({
            id: "server-request-1",
            method: "unknown/request",
            params: {},
        })

        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(transport.writes).toContainEqual({
            jsonrpc: "2.0",
            id: "server-request-1",
            error: {
                code: -32601,
                message: "server request handler missing",
            },
        })
    })

    it("sends JSON-RPC errors when server request handlers throw", async () => {
        const transport = new FakeTransport()
        new CodexJsonRpcClient({
            transport,
            requestTimeoutMs: 1000,
            onServerRequest: async () => {
                throw new Error("approval path failed")
            },
        })

        transport.emit({
            id: "server-request-2",
            method: "item/permissions/requestApproval",
            params: {},
        })

        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(transport.writes).toContainEqual({
            jsonrpc: "2.0",
            id: "server-request-2",
            error: {
                code: -32000,
                message: "approval path failed",
            },
        })
    })

    it("writes subprocess input through Bun FileSink stdin", async () => {
        const writes: string[] = []
        const flushed: string[] = []
        let ended = false
        const writer = createProcessStdinWriter({
            write(data) {
                writes.push(new TextDecoder().decode(data as Uint8Array))
                return data.length
            },
            flush() {
                flushed.push("flush")
            },
            end() {
                ended = true
            },
        })

        await writer.write(new TextEncoder().encode("{\"id\":1}\n"))
        await writer.close()

        expect(writes).toEqual(["{\"id\":1}\n"])
        expect(flushed).toEqual(["flush"])
        expect(ended).toBe(true)
    })
})
