export declare function requireUser(ctx: {
    auth: {
        getUserIdentity: () => Promise<unknown>;
    };
}): Promise<void>;
export declare function requireServiceToken(serviceToken: string): void;
export declare function requireUserOrServiceToken(ctx: {
    auth: {
        getUserIdentity: () => Promise<unknown>;
    };
}, serviceToken?: string): Promise<void>;
//# sourceMappingURL=authGuards.d.ts.map