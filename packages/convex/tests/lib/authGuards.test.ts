import { describe, expect, it } from "vitest"
import { requireServiceTokenForContext } from "../../convex/lib/authGuards"

describe("auth guards", () => {
    it("fails closed when service-token auth context is missing", () => {
        const originalToken = process.env.BACKEND_SERVICE_TOKEN
        process.env.BACKEND_SERVICE_TOKEN = "test-token"

        try {
            expect(() => requireServiceTokenForContext("test-token", {})).toThrow(
                "Machine-only action requires backend service token context"
            )
        } finally {
            if (originalToken === undefined) {
                delete process.env.BACKEND_SERVICE_TOKEN
            } else {
                process.env.BACKEND_SERVICE_TOKEN = originalToken
            }
        }
    })

    it("accepts matching service-token auth context", () => {
        expect(() => requireServiceTokenForContext("test-token", {
            backendServiceToken: "test-token",
        })).not.toThrow()
    })
})
