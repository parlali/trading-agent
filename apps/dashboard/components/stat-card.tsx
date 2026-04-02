import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PnlText } from "@/components/pnl-text"
import { formatCurrency } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { ReactNode } from "react"

type StatFormat = "currency" | "pnl" | "custom"

export function StatCard({
    label,
    value,
    format = "custom",
    size = "xl",
    children,
    className,
}: {
    label: string
    value?: number
    format?: StatFormat
    size?: "lg" | "xl" | "2xl"
    children?: ReactNode
    className?: string
}) {
    const textSize = size === "2xl" ? "text-2xl" : size === "xl" ? "text-xl" : "text-lg"

    return (
        <Card className={className}>
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                    {label}
                </CardTitle>
            </CardHeader>
            <CardContent>
                {children ?? (
                    format === "pnl" && value !== undefined ? (
                        <PnlText
                            value={value}
                            className={cn(textSize, "font-semibold")}
                        />
                    ) : (
                        <p className={cn(textSize, "font-semibold tabular-nums font-mono")}>
                            {format === "currency" && value !== undefined
                                ? formatCurrency(value)
                                : String(value ?? "")}
                        </p>
                    )
                )}
            </CardContent>
        </Card>
    )
}
