"use client"

import { useAction, useQuery } from "convex/react"
import { api, type Id, type McpToolApproval, type McpToolDiagnostic, type McpToolDiscoveryRequest, type McpToolInventoryResult } from "@valiq-trading/convex"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Loader2, RefreshCw, Save, Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/empty-state"
import { PageSkeleton } from "@/components/page-skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { McpDiagnosticsList, formatMcpDiagnosticReason } from "@/components/mcp-diagnostics-list"

type InventoryTool = McpToolInventoryResult["tools"][number]
type InventoryProvider = McpToolInventoryResult["providers"][number]

type ToolRow = {
    key: string
    providerId: string
    upstreamToolName: string
    registeredName: string
    schemaHash: string
    source?: string
    description: string
    available: boolean
    annotations?: InventoryTool["annotations"]
    diagnostics: McpToolDiagnostic[]
}

type DiscoveryToolRequest = McpToolDiscoveryRequest

const DEFAULT_DISCOVERY_TOOL_NAME = "discover_tools"

function toolKey(providerId: string, toolName: string): string {
    return `${providerId}\0${toolName}`
}

function shortHash(hash: string): string {
    return hash.slice(0, 12)
}

function parseMcpToolInventoryResult(value: unknown): McpToolInventoryResult {
    const record = readRecord(value, "MCP inventory result")
    return {
        providers: readArray(record.providers, "providers").map(parseInventoryProvider),
        tools: readArray(record.tools, "tools").map(parseInventoryTool),
        diagnostics: readArray(record.diagnostics, "diagnostics").map(parseInventoryDiagnostic),
    }
}

function parseInventoryProvider(value: unknown): InventoryProvider {
    const record = readRecord(value, "MCP provider")
    const status = readString(record.status, "provider.status")
    if (status !== "available" && status !== "unavailable") {
        throw new Error("MCP provider status is invalid")
    }

    return {
        id: readString(record.id, "provider.id"),
        toolCount: readNumber(record.toolCount, "provider.toolCount"),
        skippedCount: readNumber(record.skippedCount, "provider.skippedCount"),
        status,
        error: readOptionalString(record.error),
    }
}

function parseInventoryTool(value: unknown): InventoryTool {
    const record = readRecord(value, "MCP tool")
    const source = readString(record.source, "tool.source")
    if (!isMcpDiscoverySource(source)) {
        throw new Error("MCP tool source is invalid")
    }

    return {
        providerId: readString(record.providerId, "tool.providerId"),
        upstreamToolName: readString(record.upstreamToolName, "tool.upstreamToolName"),
        registeredName: readString(record.registeredName, "tool.registeredName"),
        description: readString(record.description, "tool.description"),
        source,
        schemaHash: readString(record.schemaHash, "tool.schemaHash"),
        inputSchema: readRecord(record.inputSchema, "tool.inputSchema"),
        annotations: parseMcpToolAnnotations(record.annotations),
    }
}

function parseMcpToolAnnotations(value: unknown): InventoryTool["annotations"] | undefined {
    if (value === undefined) {
        return undefined
    }

    const record = readRecord(value, "tool.annotations")
    const annotations = {
        readOnlyHint: readOptionalBoolean(record.readOnlyHint, "tool.annotations.readOnlyHint"),
        destructiveHint: readOptionalBoolean(record.destructiveHint, "tool.annotations.destructiveHint"),
        openWorldHint: readOptionalBoolean(record.openWorldHint, "tool.annotations.openWorldHint"),
    }

    return Object.values(annotations).some((entry) => entry !== undefined)
        ? annotations
        : undefined
}

function parseInventoryDiagnostic(value: unknown): McpToolDiagnostic {
    const record = readRecord(value, "MCP diagnostic")
    const source = readOptionalString(record.source)
    if (source !== undefined && !isMcpDiscoverySource(source)) {
        throw new Error("MCP diagnostic source is invalid")
    }
    const reason = readString(record.reason, "diagnostic.reason")
    if (!isMcpToolDiagnosticReason(reason)) {
        throw new Error("MCP diagnostic reason is invalid")
    }

    return {
        providerId: readString(record.providerId, "diagnostic.providerId"),
        upstreamToolName: readOptionalString(record.upstreamToolName),
        registeredName: readOptionalString(record.registeredName),
        source,
        reason,
        message: readString(record.message, "diagnostic.message"),
        schemaReason: readOptionalString(record.schemaReason),
        annotationReason: readOptionalString(record.annotationReason),
    }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`)
    }

    return value as Record<string, unknown>
}

function readArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array`)
    }

    return value
}

function readString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`)
    }

    return value
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value
        : undefined
}

function readNumber(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number`)
    }

    return value
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
    if (value === undefined) {
        return undefined
    }

    if (typeof value !== "boolean") {
        throw new Error(`${label} must be a boolean`)
    }

    return value
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
    let parsed: unknown
    try {
        parsed = JSON.parse(value.trim() || "{}") as unknown
    } catch (error) {
        throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON object`)
    }

    return parsed as Record<string, unknown>
}

function mergeDiscoveryToolRequests(
    current: readonly DiscoveryToolRequest[],
    incoming: readonly DiscoveryToolRequest[]
): DiscoveryToolRequest[] {
    const requestsByKey = new Map<string, DiscoveryToolRequest>()

    for (const request of [...current, ...incoming]) {
        const providerId = request.providerId.trim()
        const toolName = request.toolName.trim()
        if (!providerId || !toolName) {
            continue
        }

        requestsByKey.set(discoveryRequestKey({
            providerId,
            toolName,
            input: request.input,
        }), {
            providerId,
            toolName,
            input: request.input,
        })
    }

    return Array.from(requestsByKey.values()).sort((left, right) =>
        compareCodeUnits(discoveryRequestKey(left), discoveryRequestKey(right))
    )
}

function discoveryRequestKey(request: DiscoveryToolRequest): string {
    return `${request.providerId}\0${request.toolName}\0${stableJsonKey(request.input)}`
}

function stableJsonKey(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableJsonKey(entry)).join(",")}]`
    }
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => compareCodeUnits(left, right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonKey(entry)}`)
            .join(",")}}`
    }

    return JSON.stringify(value)
}

function compareCodeUnits(left: string, right: string): number {
    if (left < right) {
        return -1
    }
    if (left > right) {
        return 1
    }

    return 0
}

function isMcpDiscoverySource(value: string): value is InventoryTool["source"] {
    return value === "tools/list" || value === "tools/discover" || value === "tool_search"
}

function isMcpToolDiagnosticReason(value: string): value is McpToolDiagnostic["reason"] {
    return [
        "provider_unavailable",
        "provider_blocked",
        "strategy_whitelist_missing",
        "strategy_whitelist_empty",
        "provider_not_configured",
        "not_whitelisted",
        "tool_disappeared",
        "schema_changed",
        "registered_name_changed",
        "schema_incompatible",
        "unsafe_annotation",
        "invalid_name",
        "malformed_tool",
        "duplicate_upstream_tool",
        "duplicate_registered_name",
        "discovery_tool",
        "nested_discovery_failed",
        "nested_discovery_unsupported_schema",
        "discovery_limit_exceeded",
    ].includes(value)
}

function buildSelectedTools(
    selectedKeys: Set<string>,
    availableTools: InventoryTool[],
    persistedTools: McpToolApproval[]
): McpToolApproval[] {
    const availableByKey = new Map(availableTools.map((tool) => [toolKey(tool.providerId, tool.upstreamToolName), tool]))
    const persistedByKey = new Map(persistedTools.map((tool) => [toolKey(tool.providerId, tool.toolName), tool]))
    const tools: McpToolApproval[] = []

    for (const key of selectedKeys) {
        const availableTool = availableByKey.get(key)
        if (availableTool) {
            tools.push({
                providerId: availableTool.providerId,
                toolName: availableTool.upstreamToolName,
                registeredName: availableTool.registeredName,
                schemaHash: availableTool.schemaHash,
                annotations: availableTool.annotations,
            })
            continue
        }

        const persistedTool = persistedByKey.get(key)
        if (persistedTool) {
            tools.push(persistedTool)
        }
    }

    return tools.sort((left, right) =>
        compareCodeUnits(`${left.providerId}\0${left.toolName}`, `${right.providerId}\0${right.toolName}`)
    )
}

function filterDiscoveryRequestsForSelectedTools(
    discoveryTools: readonly DiscoveryToolRequest[],
    tools: readonly McpToolApproval[]
): DiscoveryToolRequest[] {
    const selectedProviderIds = new Set(tools.map((tool) => tool.providerId))
    return discoveryTools.filter((request) => selectedProviderIds.has(request.providerId))
}

function ToolCheckbox({
    checked,
    onChange,
    label,
}: {
    checked: boolean
    onChange: (checked: boolean) => void
    label: string
}) {
    return (
        <label className="flex h-5 w-5 shrink-0 items-center justify-center">
            <input
                type="checkbox"
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
                aria-label={label}
                className="h-4 w-4 cursor-pointer rounded border-border accent-primary"
            />
        </label>
    )
}

function ToolAnnotationBadges({ annotations }: { annotations?: InventoryTool["annotations"] }) {
    if (!annotations?.destructiveHint && !annotations?.openWorldHint && annotations?.readOnlyHint !== true) {
        return null
    }

    return (
        <div className="flex flex-wrap items-center gap-1">
            {annotations.destructiveHint ? (
                <Badge variant="destructive" className="text-[10px]">destructive</Badge>
            ) : null}
            {annotations.openWorldHint ? (
                <Badge variant="secondary" className="text-[10px]">open-world</Badge>
            ) : null}
            {annotations.readOnlyHint === true ? (
                <Badge variant="outline" className="text-[10px]">read-only</Badge>
            ) : null}
        </div>
    )
}

function ProviderSection({
    provider,
    rows,
    selectedKeys,
    onToggle,
}: {
    provider: InventoryProvider | { id: string, toolCount: number, skippedCount: number, status: "available" | "unavailable", error?: string }
    rows: ToolRow[]
    selectedKeys: Set<string>
    onToggle: (key: string, checked: boolean) => void
}) {
    return (
        <Card>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <CardTitle className="flex items-center gap-2 text-sm">
                            <span className="truncate font-mono">{provider.id}</span>
                            <Badge variant={provider.status === "available" ? "secondary" : "destructive"} className="text-[10px]">
                                {provider.status}
                            </Badge>
                        </CardTitle>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{rows.length} tools</Badge>
                        {provider.skippedCount > 0 ? (
                            <Badge variant="secondary" className="text-[10px]">{provider.skippedCount} skipped</Badge>
                        ) : null}
                    </div>
                </div>
            </CardHeader>
            <CardContent className="pt-0">
                {provider.error ? (
                    <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {provider.error}
                    </div>
                ) : null}
                {rows.length === 0 ? (
                    <div className="rounded-md border border-border-subtle px-3 py-2 text-xs text-muted-foreground">
                        No selectable tools
                    </div>
                ) : (
                    <div className="overflow-hidden rounded-md border border-border-subtle">
                        <div className="grid grid-cols-[2rem_minmax(0,1fr)_8rem_7rem] gap-2 border-b border-border-subtle bg-muted/40 px-3 py-2 text-[11px] font-medium text-muted-foreground">
                            <span />
                            <span>Tool</span>
                            <span>Source</span>
                            <span>Schema</span>
                        </div>
                        {rows.map((row) => (
                            <div
                                key={row.key}
                                className="grid grid-cols-[2rem_minmax(0,1fr)_8rem_7rem] gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0"
                            >
                                <ToolCheckbox
                                    checked={selectedKeys.has(row.key)}
                                    onChange={(checked) => onToggle(row.key, checked)}
                                    label={`${row.providerId} ${row.upstreamToolName}`}
                                />
                                <div className="min-w-0 space-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate font-mono text-xs font-medium">{row.upstreamToolName}</span>
                                        {!row.available ? (
                                            <Badge variant="destructive" className="text-[10px]">unavailable</Badge>
                                        ) : null}
                                    </div>
                                    <ToolAnnotationBadges annotations={row.annotations} />
                                    <p className="line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
                                    <code className="block truncate text-[11px] text-muted-foreground">{row.registeredName}</code>
                                    {row.diagnostics.length > 0 ? (
                                        <div className="space-y-1">
                                            {row.diagnostics.map((diagnostic, index) => (
                                                <p key={`${diagnostic.reason}-${index}`} className="text-[11px] text-signal-warning">
                                                    {formatMcpDiagnosticReason(diagnostic.reason)}
                                                    {diagnostic.schemaReason ? `: ${diagnostic.schemaReason}` : ""}
                                                    {diagnostic.annotationReason ? `: ${diagnostic.annotationReason}` : ""}
                                                </p>
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                                <div className="self-start">
                                    <Badge variant="outline" className="text-[10px]">{row.source ?? "missing"}</Badge>
                                </div>
                                <code className="self-start truncate text-[11px] text-muted-foreground">{shortHash(row.schemaHash)}</code>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

export default function McpToolsPage() {
    const strategies = useQuery(api.queries.getAllStrategies, {})
    const discoverInventory = useAction(api.actions.discoverMcpToolInventory)
    const setWhitelist = useAction(api.actions.setStrategyMcpToolWhitelist)
    const [selectedStrategyId, setSelectedStrategyId] = useState<string>("")
    const [inventory, setInventory] = useState<McpToolInventoryResult | null>(null)
    const [loadingInventory, setLoadingInventory] = useState(false)
    const [saving, setSaving] = useState(false)
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
    const [discoveryProviderId, setDiscoveryProviderId] = useState("")
    const [discoveryToolName, setDiscoveryToolName] = useState(DEFAULT_DISCOVERY_TOOL_NAME)
    const [discoveryInputJson, setDiscoveryInputJson] = useState("{}")
    const [lastDiscoveryTools, setLastDiscoveryTools] = useState<DiscoveryToolRequest[]>([])

    useEffect(() => {
        if (!selectedStrategyId && strategies && strategies.length > 0) {
            setSelectedStrategyId(String(strategies[0]._id))
        }
    }, [selectedStrategyId, strategies])

    const whitelist = useQuery(
        api.queries.getStrategyMcpToolWhitelist,
        selectedStrategyId ? { strategyId: selectedStrategyId as Id<"strategies"> } : "skip"
    )
    const whitelistReady = selectedStrategyId
        ? whitelist !== undefined && (whitelist === null || String(whitelist.strategyId) === selectedStrategyId)
        : false

    const loadInventory = useCallback(async (discoveryTools: DiscoveryToolRequest[] = []): Promise<boolean> => {
        setLoadingInventory(true)
        try {
            const result = parseMcpToolInventoryResult(await discoverInventory(
                discoveryTools.length > 0 ? { discoveryTools } : {}
            ))
            setInventory(result)
            setLastDiscoveryTools(discoveryTools)
            return true
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to refresh MCP inventory")
            return false
        } finally {
            setLoadingInventory(false)
        }
    }, [discoverInventory])

    useEffect(() => {
        void loadInventory()
    }, [loadInventory])

    useEffect(() => {
        setInventory(null)
        setSelectedKeys(new Set())
        setLastDiscoveryTools([])
    }, [selectedStrategyId])

    useEffect(() => {
        if (!discoveryProviderId && inventory?.providers[0]) {
            setDiscoveryProviderId(inventory.providers[0].id)
        }
    }, [discoveryProviderId, inventory])

    useEffect(() => {
        if (!whitelistReady) {
            return
        }

        const persistedDiscoveryTools = mergeDiscoveryToolRequests([], whitelist?.discoveryTools ?? [])
        setSelectedKeys(new Set((whitelist?.tools ?? []).map((tool) => toolKey(tool.providerId, tool.toolName))))
        setLastDiscoveryTools(persistedDiscoveryTools)
        void loadInventory(persistedDiscoveryTools)
    }, [loadInventory, whitelist, whitelistReady])

    const selectedStrategy = useMemo(() =>
        strategies?.find((strategy) => String(strategy._id) === selectedStrategyId),
    [selectedStrategyId, strategies])

    const rowsByProvider = useMemo(() => {
        const diagnosticsByKey = new Map<string, McpToolDiagnostic[]>()
        const availableKeys = new Set<string>()
        const rows = new Map<string, ToolRow[]>()

        for (const diagnostic of inventory?.diagnostics ?? []) {
            if (!diagnostic.upstreamToolName) {
                continue
            }
            const key = toolKey(diagnostic.providerId, diagnostic.upstreamToolName)
            const current = diagnosticsByKey.get(key) ?? []
            current.push(diagnostic)
            diagnosticsByKey.set(key, current)
        }

        for (const tool of inventory?.tools ?? []) {
            const key = toolKey(tool.providerId, tool.upstreamToolName)
            availableKeys.add(key)
            const providerRows = rows.get(tool.providerId) ?? []
            providerRows.push({
                key,
                providerId: tool.providerId,
                upstreamToolName: tool.upstreamToolName,
                registeredName: tool.registeredName,
                schemaHash: tool.schemaHash,
                source: tool.source,
                description: tool.description,
                available: true,
                annotations: tool.annotations,
                diagnostics: diagnosticsByKey.get(key) ?? [],
            })
            rows.set(tool.providerId, providerRows)
        }

        for (const tool of whitelist?.tools ?? []) {
            const key = toolKey(tool.providerId, tool.toolName)
            if (availableKeys.has(key)) {
                continue
            }

            const providerRows = rows.get(tool.providerId) ?? []
            providerRows.push({
                key,
                providerId: tool.providerId,
                upstreamToolName: tool.toolName,
                registeredName: tool.registeredName,
                schemaHash: tool.schemaHash,
                annotations: tool.annotations,
                description: "Previously selected tool is not available in the latest provider inventory",
                available: false,
                diagnostics: diagnosticsByKey.get(key) ?? [{
                    providerId: tool.providerId,
                    upstreamToolName: tool.toolName,
                    registeredName: tool.registeredName,
                    reason: "tool_disappeared",
                    message: "Selected MCP tool was not discovered from the provider",
                }],
            })
            rows.set(tool.providerId, providerRows)
        }

        for (const providerRows of rows.values()) {
            providerRows.sort((left, right) => left.upstreamToolName.localeCompare(right.upstreamToolName))
        }

        return rows
    }, [inventory, whitelist])

    const providers = useMemo(() => {
        const providerById = new Map((inventory?.providers ?? []).map((provider) => [provider.id, provider]))
        for (const providerId of rowsByProvider.keys()) {
            if (!providerById.has(providerId)) {
                providerById.set(providerId, {
                    id: providerId,
                    toolCount: rowsByProvider.get(providerId)?.length ?? 0,
                    skippedCount: 0,
                    status: "unavailable",
                })
            }
        }

        return Array.from(providerById.values()).sort((left, right) => left.id.localeCompare(right.id))
    }, [inventory, rowsByProvider])

    const visibleDiagnostics = useMemo(() => {
        const diagnostics = [...(inventory?.diagnostics ?? [])]
        const availableKeys = new Set((inventory?.tools ?? []).map((tool) => toolKey(tool.providerId, tool.upstreamToolName)))

        for (const tool of whitelist?.tools ?? []) {
            const key = toolKey(tool.providerId, tool.toolName)
            if (!availableKeys.has(key) && !diagnostics.some((diagnostic) =>
                diagnostic.providerId === tool.providerId && diagnostic.upstreamToolName === tool.toolName
            )) {
                diagnostics.push({
                    providerId: tool.providerId,
                    upstreamToolName: tool.toolName,
                    registeredName: tool.registeredName,
                    reason: "tool_disappeared",
                    message: "Selected MCP tool was not discovered from the provider",
                })
            }
        }

        return diagnostics
    }, [inventory, whitelist])

    function handleToggle(key: string, checked: boolean) {
        setSelectedKeys((current) => {
            const next = new Set(current)
            if (checked) {
                next.add(key)
            } else {
                next.delete(key)
            }
            return next
        })
    }

    async function handleSave() {
        if (!selectedStrategyId || !inventory || !whitelistReady || loadingInventory) {
            return
        }

        setSaving(true)
        try {
            const tools = buildSelectedTools(selectedKeys, inventory.tools, whitelist?.tools ?? [])
            const discoveryTools = filterDiscoveryRequestsForSelectedTools(lastDiscoveryTools, tools)
            await setWhitelist({
                strategyId: selectedStrategyId as Id<"strategies">,
                tools,
                approvalReason: "dashboard_mcp_tools",
                ...(discoveryTools.length > 0 ? { discoveryTools } : {}),
            })
            toast.success("MCP tool scope saved")
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to save MCP tool scope")
        } finally {
            setSaving(false)
        }
    }

    async function handleRunDiscovery() {
        const providerId = discoveryProviderId.trim()
        const toolName = discoveryToolName.trim()
        if (!providerId) {
            toast.error("Select an MCP provider before running discovery")
            return
        }
        if (!toolName) {
            toast.error("Discovery tool name is required")
            return
        }

        try {
            const discoveryTools = mergeDiscoveryToolRequests(lastDiscoveryTools, [{
                providerId,
                toolName,
                input: parseJsonObject(discoveryInputJson, "Discovery input"),
            }])
            const refreshed = await loadInventory(discoveryTools)
            if (refreshed) {
                toast.success("MCP discovery refreshed")
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to run MCP discovery")
        }
    }

    if (strategies === undefined) {
        return <PageSkeleton count={3} height="h-20" spacing="space-y-4" />
    }

    if (strategies.length === 0) {
        return (
            <EmptyState
                icon={Search}
                title="No strategies"
                description="No strategies configured"
            />
        )
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Select value={selectedStrategyId} onValueChange={setSelectedStrategyId}>
                        <SelectTrigger className="w-full md:w-[28rem]">
                            <SelectValue placeholder="Select strategy" />
                        </SelectTrigger>
                        <SelectContent>
                            {strategies.map((strategy) => (
                                <SelectItem key={strategy._id} value={String(strategy._id)}>
                                    {strategy.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {selectedStrategy ? (
                        <div className="hidden shrink-0 items-center gap-2 md:flex">
                            <VenueBadge app={selectedStrategy.app} />
                            <code className="text-xs text-muted-foreground">{selectedStrategy.accountId}</code>
                        </div>
                    ) : null}
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={() => void loadInventory(lastDiscoveryTools)} disabled={loadingInventory}>
                        {loadingInventory ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        Refresh
                    </Button>
                    <Button onClick={handleSave} disabled={saving || loadingInventory || !inventory || !selectedStrategyId || !whitelistReady}>
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        Save
                    </Button>
                </div>
            </div>

            <div className="grid gap-2 rounded-md border border-border-subtle px-3 py-3 md:grid-cols-[minmax(10rem,14rem)_minmax(12rem,18rem)_minmax(0,1fr)_auto] md:items-end">
                <div className="space-y-1">
                    <p className="text-[11px] text-muted-foreground">Discovery provider</p>
                    <Select
                        value={discoveryProviderId}
                        onValueChange={setDiscoveryProviderId}
                        disabled={!inventory || inventory.providers.length === 0 || loadingInventory}
                    >
                        <SelectTrigger className="h-9 w-full">
                            <SelectValue placeholder="Provider" />
                        </SelectTrigger>
                        <SelectContent>
                            {inventory?.providers.map((provider) => (
                                <SelectItem key={provider.id} value={provider.id}>
                                    {provider.id}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="space-y-1">
                    <p className="text-[11px] text-muted-foreground">Discovery tool</p>
                    <Input
                        value={discoveryToolName}
                        onChange={(event) => setDiscoveryToolName(event.target.value)}
                        placeholder={DEFAULT_DISCOVERY_TOOL_NAME}
                        className="h-9 font-mono text-xs"
                    />
                </div>
                <div className="space-y-1">
                    <p className="text-[11px] text-muted-foreground">Input JSON</p>
                    <Textarea
                        value={discoveryInputJson}
                        onChange={(event) => setDiscoveryInputJson(event.target.value)}
                        placeholder='{"category":"news"}'
                        className="min-h-9 font-mono text-xs"
                    />
                </div>
                <Button
                    variant="outline"
                    onClick={() => void handleRunDiscovery()}
                    disabled={loadingInventory || !inventory || inventory.providers.length === 0}
                    className="h-9"
                >
                    {loadingInventory ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    Run
                </Button>
            </div>

            <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-md border border-border-subtle px-3 py-2">
                    <p className="text-[11px] text-muted-foreground">Providers</p>
                    <p className="text-lg font-semibold">{inventory?.providers.length ?? 0}</p>
                </div>
                <div className="rounded-md border border-border-subtle px-3 py-2">
                    <p className="text-[11px] text-muted-foreground">Discovered</p>
                    <p className="text-lg font-semibold">{inventory?.tools.length ?? 0}</p>
                </div>
                <div className="rounded-md border border-border-subtle px-3 py-2">
                    <p className="text-[11px] text-muted-foreground">Enabled</p>
                    <p className="text-lg font-semibold">{selectedKeys.size}</p>
                </div>
                <div className="rounded-md border border-border-subtle px-3 py-2">
                    <p className="text-[11px] text-muted-foreground">Discovery Calls</p>
                    <p className="text-lg font-semibold">{lastDiscoveryTools.length}</p>
                </div>
            </div>

            {loadingInventory && !inventory ? (
                <PageSkeleton count={3} height="h-28" spacing="space-y-4" />
            ) : providers.length === 0 ? (
                <EmptyState
                    icon={Search}
                    title="No MCP providers"
                    description="No MCP providers configured"
                />
            ) : (
                <div className="space-y-4">
                    {providers.map((provider) => (
                        <ProviderSection
                            key={provider.id}
                            provider={provider}
                            rows={rowsByProvider.get(provider.id) ?? []}
                            selectedKeys={selectedKeys}
                            onToggle={handleToggle}
                        />
                    ))}
                    <McpDiagnosticsList diagnostics={visibleDiagnostics} title="Diagnostics" />
                </div>
            )}
        </div>
    )
}
