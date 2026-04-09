import { describe, expect, it } from "vitest"
import { createMT5ModifyOrderTool } from "./modify-order-mt5"

describe("createMT5ModifyOrderTool", () => {
    it("requires at least one protective level change", () => {
        const tool = createMT5ModifyOrderTool({
            modifyOrder: async () => {
                throw new Error("not used")
            },
            getOrderSnapshot: async () => null,
        } as never)

        const result = tool.parameters.safeParse({
            orderId: 12345,
        })

        expect(result.success).toBe(false)
    })
})
