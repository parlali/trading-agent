import type { McpToolDiagnostic } from "@valiq-trading/convex"
import { AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from "@/components/ui/card"

export function formatMcpDiagnosticReason(reason: string): string {
    return reason.replaceAll("_", " ")
}

export function McpDiagnosticsList({
    diagnostics,
    title = "MCP Diagnostics",
}: {
    diagnostics: McpToolDiagnostic[]
    title?: string
}) {
    if (diagnostics.length === 0) {
        return null
    }

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="h-4 w-4 text-signal-warning" />
                    {title}
                </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
                <div className="overflow-hidden rounded-md border border-border-subtle">
                    {diagnostics.map((diagnostic, index) => (
                        <div
                            key={`${diagnostic.providerId}-${diagnostic.upstreamToolName ?? "provider"}-${diagnostic.reason}-${index}`}
                            className="grid gap-1 border-b border-border-subtle px-3 py-2 text-xs last:border-b-0 md:grid-cols-[10rem_minmax(0,1fr)_10rem]"
                        >
                            <code className="truncate text-muted-foreground">{diagnostic.providerId}</code>
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="truncate font-medium">{diagnostic.upstreamToolName ?? "provider"}</span>
                                    <Badge variant="outline" className="text-[10px]">
                                        {formatMcpDiagnosticReason(diagnostic.reason)}
                                    </Badge>
                                </div>
                                <p className="text-muted-foreground">{diagnostic.message}</p>
                                {diagnostic.schemaReason ? (
                                    <p className="text-signal-warning">{diagnostic.schemaReason}</p>
                                ) : null}
                                {diagnostic.annotationReason ? (
                                    <p className="text-signal-warning">{diagnostic.annotationReason}</p>
                                ) : null}
                            </div>
                            <code className="truncate text-muted-foreground">{diagnostic.registeredName ?? diagnostic.source ?? ""}</code>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    )
}
