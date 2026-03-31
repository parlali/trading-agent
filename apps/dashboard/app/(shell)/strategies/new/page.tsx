"use client"

import { StrategyForm } from "@/components/strategy-form"

export default function NewStrategyPage() {
    return (
        <div className="max-w-2xl space-y-6">
            <h2 className="text-lg font-semibold">New Strategy</h2>
            <StrategyForm mode="create" />
        </div>
    )
}
