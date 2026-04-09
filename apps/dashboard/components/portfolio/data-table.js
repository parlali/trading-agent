import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell, } from "@/components/ui/table";
import { cn } from "@/lib/utils";
export function DataTable({ columns, data, getRowKey, className, }) {
    return (<Table className={className}>
            <TableHeader>
                <TableRow className="hover:bg-transparent">
                    {columns.map((col) => (<TableHead key={col.key} className={cn(col.align === "right" && "text-right", col.align === "center" && "text-center", col.headerClassName)}>
                            {col.header}
                        </TableHead>))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {data.map((item) => (<TableRow key={getRowKey(item)}>
                        {columns.map((col) => (<TableCell key={col.key} className={cn(col.align === "right" && "text-right", col.align === "center" && "text-center", col.cellClassName)}>
                                {col.render(item)}
                            </TableCell>))}
                    </TableRow>))}
            </TableBody>
        </Table>);
}
