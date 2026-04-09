import { action } from "./_generated/server";
import { v } from "convex/values";
import { requireServiceToken } from "./lib/authGuards";
function readEnv() {
    return globalThis.process?.env ?? {};
}
export const resolveSecrets = action({
    args: {
        keys: v.array(v.string()),
        serviceToken: v.string(),
    },
    handler: async (_ctx, args) => {
        requireServiceToken(args.serviceToken);
        const resolved = {};
        const env = readEnv();
        for (const key of args.keys) {
            resolved[key] = env[key] ?? null;
        }
        return resolved;
    },
});
