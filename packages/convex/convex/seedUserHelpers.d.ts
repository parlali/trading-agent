export declare const findUserByEmail: import("convex/server").RegisteredQuery<"internal", {
    email: string;
}, Promise<{
    _id: import("convex/values").GenericId<"authAccounts">;
    _creationTime: number;
    secret?: string | undefined | undefined;
    emailVerified?: string | undefined | undefined;
    phoneVerified?: string | undefined | undefined;
    userId: import("convex/values").GenericId<"users">;
    provider: string;
    providerAccountId: string;
} | null>>;
export declare const insertUser: import("convex/server").RegisteredMutation<"internal", {
    email: string;
}, Promise<import("convex/values").GenericId<"users">>>;
export declare const insertAuthAccount: import("convex/server").RegisteredMutation<"internal", {
    email: string;
    userId: import("convex/values").GenericId<"users">;
    secret: string;
}, Promise<import("convex/values").GenericId<"authAccounts">>>;
//# sourceMappingURL=seedUserHelpers.d.ts.map