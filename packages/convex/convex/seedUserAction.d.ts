import type { Id } from "./_generated/dataModel";
type SeedUserResult = {
    status: "already_exists";
    email: string;
} | {
    status: "created";
    email: string;
    userId: Id<"users">;
};
export declare const seedUser: import("convex/server").RegisteredAction<"internal", {
    email: string;
    password: string;
}, Promise<SeedUserResult>>;
export {};
//# sourceMappingURL=seedUserAction.d.ts.map