import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export function CardList<T>({
    data,
    getKey,
    renderCard,
    className,
}: {
    data: T[]
    getKey: (item: T) => string
    renderCard: (item: T) => ReactNode
    className?: string
}) {
    return (
        <div className={cn("space-y-2", className)}>
            {data.map((item) => (
                <div key={getKey(item)}>{renderCard(item)}</div>
            ))}
        </div>
    )
}
