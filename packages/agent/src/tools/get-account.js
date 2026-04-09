import { createToolDefinition } from "../tool-contracts";
export function createGetAccountTool(pipeline) {
    return createToolDefinition({
        name: "get_account",
        handler: async () => {
            const account = await pipeline.getAccountState();
            return { account };
        },
    });
}
