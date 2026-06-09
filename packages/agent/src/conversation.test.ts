import { describe, expect, it } from "vitest"
import { ConversationManager } from "./conversation"

describe("ConversationManager", () => {
    it("bounds persisted tool results before returning chat messages", () => {
        const conversation = new ConversationManager()
        conversation.addToolResult("call-1", "huge_tool", "x".repeat(8001))

        const [message] = conversation.getMessages()

        expect(message?.content).toContain("...[truncated from 8001 chars]")
        expect(message?.content?.length).toBeLessThan(8100)
        expect(message).toMatchObject({
            role: "tool",
            tool_call_id: "call-1",
            name: "huge_tool",
        })
    })
})
