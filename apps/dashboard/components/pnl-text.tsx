import { cn } from "@/lib/utils"
import { formatSignedCurrency } from "@/lib/format"

export function PnlText({
    value,
    className,
    currency = "USD",
}: {
    value: number
    className?: string
    currency?: string
}) {
    return (
        <span
            className={cn(
                "tabular-nums font-mono",
                value > 0 && "text-profit",
                value < 0 && "text-loss",
                value === 0 && "text-neutral",
                className,
            )}
        >
            {formatSignedCurrency(value, currency)}
        </span>
    )
}
