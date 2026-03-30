"use client"

import { ConvexProvider, ConvexReactClient } from "convex/react"
import { useMemo, type ReactNode } from "react"

export function ConvexClientProvider({ children }: { children: ReactNode }) {
    const client = useMemo(
        () => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!),
        [],
    )

    return (
        <ConvexProvider client={client}>
            {children}
        </ConvexProvider>
    )
}
