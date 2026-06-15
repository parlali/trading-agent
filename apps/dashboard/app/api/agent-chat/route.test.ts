import { afterEach, describe, expect, it, vi } from "vitest"
import { requireDashboardUser } from "@/lib/codex-oauth-server"
import { GET, POST } from "./route"

vi.mock("@/lib/codex-oauth-server", () => ({
    requireDashboardUser: vi.fn(),
}))

describe("dashboard agent chat API route", () => {
    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env.BACKEND_URL
        delete process.env.BACKEND_SERVICE_TOKEN
    })

    it("rejects unauthenticated requests before backend proxy", async () => {
        vi.mocked(requireDashboardUser).mockRejectedValue(new Error("Dashboard authentication required"))
        const fetchSpy = vi.spyOn(globalThis, "fetch")

        const response = await POST(createRequest({
            message: "hello",
        }))

        expect(response.status).toBe(401)
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("rejects unsupported execution evidence fields before backend proxy", async () => {
        vi.mocked(requireDashboardUser).mockResolvedValue(undefined)
        const fetchSpy = vi.spyOn(globalThis, "fetch")

        const response = await POST(createRequest({
            message: "hello",
            model: "attacker/model",
            messages: [],
            toolOutputs: [],
        }))

        expect(response.status).toBe(400)
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("proxies only bounded chat fields after dashboard authentication", async () => {
        vi.mocked(requireDashboardUser).mockResolvedValue(undefined)
        process.env.BACKEND_URL = "http://backend.test"
        process.env.BACKEND_SERVICE_TOKEN = "backend-token"
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", {
            headers: {
                "content-type": "text/plain",
            },
        }))

        const request = createRequest({
            message: "hello",
            chatSessionId: "session-1",
            chatMessageId: "message-1",
            mode: "mcp",
        })
        const response = await POST(request)

        expect(response.status).toBe(200)
        expect(fetchSpy).toHaveBeenCalledWith(new URL("/agent-chat", "http://backend.test"), expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
                message: "hello",
                chatSessionId: "session-1",
                chatMessageId: "message-1",
                mode: "mcp",
            }),
            signal: request.signal,
        }))
    })

    it("proxies bounded chat session id for server transcript inventory", async () => {
        vi.mocked(requireDashboardUser).mockResolvedValue(undefined)
        process.env.BACKEND_URL = "http://backend.test"
        process.env.BACKEND_SERVICE_TOKEN = "backend-token"
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
            ok: true,
        }), {
            headers: {
                "content-type": "application/json",
            },
        }))
        const request = new Request("http://dashboard.test/api/agent-chat?chatSessionId=session-1", {
            method: "GET",
            headers: {
                authorization: "Bearer user-token",
            },
        })

        const response = await GET(request)

        expect(response.status).toBe(200)
        expect(fetchSpy).toHaveBeenCalledWith(new URL("/agent-chat?chatSessionId=session-1", "http://backend.test"), expect.objectContaining({
            method: "GET",
            signal: request.signal,
        }))
    })

    it("returns sanitized gateway failures when backend fetch rejects", async () => {
        vi.mocked(requireDashboardUser).mockResolvedValue(undefined)
        process.env.BACKEND_URL = "http://backend.test"
        process.env.BACKEND_SERVICE_TOKEN = "backend-token"
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed: backend secret"))

        await expectProxyFailureForPostAndGet(502, "An internal error occurred")
    })

    it("returns sanitized service failures when backend URL is missing", async () => {
        vi.mocked(requireDashboardUser).mockResolvedValue(undefined)
        process.env.BACKEND_SERVICE_TOKEN = "backend-token"
        const fetchSpy = vi.spyOn(globalThis, "fetch")

        await expectProxyFailureForPostAndGet(503, "An internal error occurred")
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("returns sanitized service failures when backend service token is missing", async () => {
        vi.mocked(requireDashboardUser).mockResolvedValue(undefined)
        process.env.BACKEND_URL = "http://backend.test"
        const fetchSpy = vi.spyOn(globalThis, "fetch")

        await expectProxyFailureForPostAndGet(503, "An internal error occurred")
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("sanitizes backend 5xx responses while preserving status", async () => {
        vi.mocked(requireDashboardUser).mockResolvedValue(undefined)
        process.env.BACKEND_URL = "http://backend.test"
        process.env.BACKEND_SERVICE_TOKEN = "backend-token"
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
            error: "backend secret stack",
        }), {
            status: 500,
            headers: {
                "content-type": "application/json",
            },
        }))

        await expectProxyFailureForPostAndGet(500, "An internal error occurred")
    })
})

function createRequest(body: Record<string, unknown>): Request {
    return new Request("http://dashboard.test/api/agent-chat", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: "Bearer user-token",
        },
        body: JSON.stringify(body),
    })
}

function createGetRequest(): Request {
    return new Request("http://dashboard.test/api/agent-chat?chatSessionId=session-1", {
        method: "GET",
        headers: {
            authorization: "Bearer user-token",
        },
    })
}

async function expectProxyFailureForPostAndGet(status: number, error: string): Promise<void> {
    const postResponse = await POST(createRequest({
        message: "hello",
    }))
    const getResponse = await GET(createGetRequest())

    expect(postResponse.status).toBe(status)
    expect(await postResponse.json()).toMatchObject({ error })
    expect(getResponse.status).toBe(status)
    expect(await getResponse.json()).toMatchObject({ error })
}
