import type { ReactNode } from "react"
import {
    Table,
    TableHeader,
    TableBody,
    TableHead,
    TableRow,
    TableCell,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

export type Column<T> = {
    key: string
    header: string
    align?: "left" | "right" | "center"
    headerClassName?: string
    cellClassName?: string
    render: (item: T) => ReactNode
}

export function DataTable<T>({
    columns,
    data,
    getRowKey,
    className,
}: {
    columns: Column<T>[]
    data: T[]
    getRowKey: (item: T) => string
    className?: string
}) {
    return (
        <Table className={className}>
            <TableHeader>
                <TableRow className="hover:bg-transparent">
                    {columns.map((col) => (
                        <TableHead
                            key={col.key}
                            className={cn(
                                col.align === "right" && "text-right",
                                col.align === "center" && "text-center",
                                col.headerClassName,
                            )}
                        >
                            {col.header}
                        </TableHead>
                    ))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {data.map((item) => (
                    <TableRow key={getRowKey(item)}>
                        {columns.map((col) => (
                            <TableCell
                                key={col.key}
                                className={cn(
                                    col.align === "right" && "text-right",
                                    col.align === "center" && "text-center",
                                    col.cellClassName,
                                )}
                            >
                                {col.render(item)}
                            </TableCell>
                        ))}
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    )
}
