"use client"

import { use } from "react"
import { useStrategy } from "@/hooks/use-strategy"
import { Skeleton } from "@/components/ui/skeleton"
import { StrategyForm } from "@/components/strategy-form"
import type { VenueApp } from "@/lib/constants"

export default function EditStrategyPage({
    params,
}: {
    params: Promise<{ id: string }>
}) {
    const { id } = use(params)
    const { data: strategy, isLoading, notFound } = useStrategy(id)

    if (isLoading) {
        return (
            <div className="max-w-2xl space-y-6">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-96" />
            </div>
        )
    }

    if (notFound || !strategy) {
        return (
            <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Strategy not found</p>
            </div>
        )
    }

    return (
        <div className="max-w-2xl space-y-6">
            <h2 className="text-lg font-semibold">Edit {strategy.name}</h2>
            <StrategyForm
                mode="edit"
                initialData={{
                    id: strategy._id,
                    app: strategy.app as VenueApp,
                    name: strategy.name,
                    enabled: strategy.enabled,
                    schedule: strategy.schedule,
                    policy: (strategy.policy ?? {}) as Record<string, unknown>,
                    context: strategy.context,
                }}
            />
        </div>
    )
}
