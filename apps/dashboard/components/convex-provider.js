"use client";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { useMemo } from "react";
export function ConvexClientProvider({ children }) {
    const client = useMemo(() => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL), []);
    return (<ConvexAuthProvider client={client}>
            {children}
        </ConvexAuthProvider>);
}
