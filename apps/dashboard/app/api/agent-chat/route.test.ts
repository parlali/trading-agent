import { afterEach, describe, expect, it, vi } from "vitest"
import { requireDashboardUser } from "@/lib/codex-oauth-server"
import { POST } from "./route"

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

        const response = await POST(createRequest({
            message: "hello",
            chatSessionId: "session-1",
            chatMessageId: "message-1",
            mode: "mcp",
        }))

        expect(response.status).toBe(200)
        expect(fetchSpy).toHaveBeenCalledWith(new URL("/agent-chat", "http://backend.test"), expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
                message: "hello",
                chatSessionId: "session-1",
                chatMessageId: "message-1",
                mode: "mcp",
            }),
        }))
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
