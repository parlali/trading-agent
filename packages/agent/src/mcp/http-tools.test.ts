import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createLogger } from "@valiq-trading/core"
import { ToolExecutionEngine } from "../tool-execution-engine"
import { ToolRegistry } from "../tool-registry"
import {
    createHttpMcpToolBindingResolution,
    createHttpMcpToolBindings,
    discoverHttpMcpToolInventory,
    hashMcpToolSchema,
    type McpToolDiagnostic,
} from "./http-tools"
import { createScopedMcpProviderConfig } from "./provider-scope"

describe("HTTP MCP tool bindings", () => {
    const servers: Array<{ close: () => void }> = []

    afterEach(() => {
        for (const server of servers.splice(0)) {
            server.close()
        }
        vi.restoreAllMocks()
    })

    it("discovers namespaced MCP tools and calls the upstream tool name", async () => {
        const receivedCalls: Array<{
            body: Record<string, unknown>
            authorization?: string
        }> = []
        const server = await startMcpServer(async (request, response) => {
            if (request.headers.authorization !== "Bearer secret") {
                response.writeHead(401, { "Content-Type": "text/plain" })
                response.end("missing bearer token")
                return
            }

            const body = await readJsonBody(request)
            receivedCalls.push({
                body,
                authorization: request.headers.authorization,
            })
            const method = body.method

            if (method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "research-server", version: "1.0.0" },
                })
                return
            }

            if (method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "search",
                        description: "Search external research",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" },
                            },
                            required: ["query"],
                        },
                    }],
                })
                return
            }

            if (method === "tools/call") {
                writeJsonRpc(response, body.id, {
                    content: [{
                        type: "text",
                        text: "research result",
                    }],
                })
                return
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const tools = await createHttpMcpToolBindings({
            providers: [{
                id: "macro",
                url: server.url,
                token: "secret",
                allowedTools: ["search"],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(tools.map((tool) => tool.name)).toEqual(["mcp_macro_search"])
        expect(tools[0]?.category).toBe("research")

        const result = await tools[0]?.handler({ query: "rates" })

        expect(result).toMatchObject({
            content: [{
                type: "text",
                text: "research result",
            }],
        })
        expect(receivedCalls.find((call) => call.body.method === "initialize")?.authorization).toBe("Bearer secret")
        expect(receivedCalls.find((call) => call.body.method === "tools/list")?.authorization).toBe("Bearer secret")
        expect(receivedCalls.find((call) => call.body.method === "tools/call")).toMatchObject({
            authorization: "Bearer secret",
            body: {
                params: {
                    name: "search",
                    arguments: { query: "rates" },
                },
            },
        })
    })

    it("does not expose MCP tools without an explicit read-only allowlist", async () => {
        const server = await createSingleToolServer("search")
        servers.push(server)

        const tools = await createHttpMcpToolBindings({
            providers: [{
                id: "macro",
                url: server.url,
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(tools).toEqual([])
    })

    it("discovers provider-gated MCP tools from optional tools/discover and binds only approved tools", async () => {
        const receivedMethods: string[] = []
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)
            receivedMethods.push(String(body.method))

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "discover-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [],
                })
                return
            }

            if (body.method === "tools/discover") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "gated_search",
                        description: "Search a gated provider catalog",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" },
                            },
                            required: ["query"],
                        },
                    }],
                })
                return
            }

            if (body.method === "tools/call") {
                writeJsonRpc(response, body.id, {
                    content: [{
                        type: "text",
                        text: "gated result",
                    }],
                })
                return
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const inventory = await discoverHttpMcpToolInventory({
            providers: [{
                id: "macro",
                url: server.url,
                discoveryTools: [{
                    name: "tool_search",
                    inputs: [{ query: "", limit: 50 }],
                }],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(inventory.inventory).toMatchObject([{
            providerId: "macro",
            upstreamToolName: "gated_search",
            registeredName: "mcp_macro_gated_search",
            source: "tools/discover",
        }])
        expect(receivedMethods).toContain("tools/discover")

        const resolution = await createHttpMcpToolBindingResolution({
            providers: [{
                id: "macro",
                url: server.url,
                approvedTools: [{
                    name: "gated_search",
                    registeredName: "mcp_macro_gated_search",
                    schemaHash: inventory.inventory[0]?.schemaHash,
                }],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(resolution.bindings.map((tool) => tool.name)).toEqual(["mcp_macro_gated_search"])
        await expect(resolution.bindings[0]?.handler({ query: "earnings" })).resolves.toMatchObject({
            content: [{
                type: "text",
                text: "gated result",
            }],
        })
    })

    it("discovers nested MCP tools through bounded provider discovery and binds only approved nested tools", async () => {
        const receivedCalls: string[] = []
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)
            receivedCalls.push(String(body.method))

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "nested-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "tool_search",
                        description: "Discover hidden tools",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" },
                                limit: { type: "number" },
                            },
                            required: ["query"],
                        },
                        annotations: {
                            readOnlyHint: true,
                        },
                    }],
                })
                return
            }

            if (body.method === "tools/call") {
                const params = body.params as Record<string, unknown>
                if (params.name === "tool_search") {
                    writeJsonRpc(response, body.id, {
                        structuredContent: {
                            tools: [{
                                name: "nested_search",
                                description: "Nested search",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        query: { type: "string" },
                                    },
                                    required: ["query"],
                                },
                            }],
                        },
                        content: [],
                    })
                    return
                }

                if (params.name === "nested_search") {
                    writeJsonRpc(response, body.id, {
                        content: [{
                            type: "text",
                            text: "nested result",
                        }],
                    })
                    return
                }
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const inventory = await discoverHttpMcpToolInventory({
            providers: [{
                id: "macro",
                url: server.url,
                discoveryTools: [{
                    name: "tool_search",
                    inputs: [{ query: "", limit: 50 }],
                }],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(inventory.inventory.map((tool) => tool.upstreamToolName)).toContain("nested_search")
        expect(inventory.inventory.map((tool) => tool.upstreamToolName)).toContain("tool_search")
        expect(inventory.diagnostics.some((diagnostic) =>
            diagnostic.upstreamToolName === "tool_search" && diagnostic.reason === "discovery_tool"
        )).toBe(false)

        const resolution = await createHttpMcpToolBindingResolution({
            providers: [{
                id: "macro",
                url: server.url,
                discoveryTools: [{
                    name: "tool_search",
                    inputs: [{ query: "", limit: 50 }],
                }],
                approvedTools: [{
                    name: "nested_search",
                }],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(resolution.bindings.map((tool) => tool.name)).toEqual(["mcp_macro_nested_search"])
        expect(receivedCalls).toContain("tools/call")

        const result = await resolution.bindings[0]?.handler({ query: "rates" })
        expect(result).toMatchObject({
            content: [{
                type: "text",
                text: "nested result",
            }],
        })
    })

    it("does not derive tool approvals from an unapproved discovery tool", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "unapproved-discovery-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [
                        {
                            name: "discover_tools",
                            description: "Discover hidden tools",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    query: { type: "string" },
                                },
                            },
                        },
                        {
                            name: "safe_status",
                            description: "Read status",
                            inputSchema: {
                                type: "object",
                                properties: {},
                            },
                        },
                    ],
                })
                return
            }

            if (body.method === "tools/call") {
                const params = body.params as Record<string, unknown>
                if (params.name === "discover_tools") {
                    writeJsonRpc(response, body.id, {
                        structuredContent: {
                            tools: [{
                                name: "nested_search",
                                description: "Nested search",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        query: { type: "string" },
                                    },
                                },
                            }],
                        },
                        content: [],
                    })
                    return
                }

                writeJsonRpc(response, body.id, {
                    content: [{
                        type: "text",
                        text: "status",
                    }],
                })
                return
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const resolution = await createHttpMcpToolBindingResolution({
            providers: [{
                id: "macro",
                url: server.url,
                approvedTools: [{
                    name: "safe_status",
                }],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(resolution.bindings.map((tool) => tool.name)).toEqual(["mcp_macro_safe_status"])
        expect(resolution.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                upstreamToolName: "nested_search",
                reason: "not_whitelisted",
            }),
        ]))
    })

    it("deduplicates identical MCP tools across discovery refreshes without diagnostics", async () => {
        const sharedSearchTool = {
            name: "market_context",
            description: "Read market context",
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string" },
                },
                required: ["query"],
            },
            annotations: {
                readOnlyHint: true,
            },
        }
        const discoveryTool = {
            name: "discover_tools",
            description: "Discover provider tools",
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string" },
                    limit: { type: "number" },
                },
                required: ["query"],
            },
            annotations: {
                readOnlyHint: true,
            },
        }
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "refresh-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [discoveryTool, sharedSearchTool],
                })
                return
            }

            if (body.method === "tools/discover") {
                writeJsonRpc(response, body.id, {
                    tools: [sharedSearchTool],
                })
                return
            }

            if (body.method === "tools/call") {
                writeJsonRpc(response, body.id, {
                    structuredContent: {
                        tools: [sharedSearchTool],
                    },
                    content: [],
                })
                return
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const inventory = await discoverHttpMcpToolInventory({
            providers: [{
                id: "macro",
                url: server.url,
                discoveryTools: [{
                    name: "discover_tools",
                    inputs: [{ query: "", limit: 50 }],
                }],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(inventory.inventory.map((tool) => tool.upstreamToolName)).toEqual([
            "discover_tools",
            "market_context",
        ])
        expect(inventory.diagnostics.some((diagnostic) => diagnostic.reason === "duplicate_upstream_tool")).toBe(false)

        const resolution = await createHttpMcpToolBindingResolution({
            providers: [{
                id: "macro",
                url: server.url,
                discoveryTools: [{
                    name: "discover_tools",
                    inputs: [{ query: "", limit: 50 }],
                }],
                approvedTools: [
                    { name: "discover_tools" },
                    { name: "market_context" },
                ],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(resolution.bindings.map((tool) => tool.name)).toEqual([
            "mcp_macro_discover_tools",
            "mcp_macro_market_context",
            "mcp_macro_call_discovered_tool",
        ])
        expect(resolution.diagnostics.some((diagnostic) => diagnostic.reason === "duplicate_upstream_tool")).toBe(false)
    })

    it("fails closed and records a diagnostic for conflicting repeated upstream MCP tools", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "conflict-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "market_context",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" },
                            },
                            required: ["query"],
                        },
                    }],
                })
                return
            }

            if (body.method === "tools/discover") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "market_context",
                        inputSchema: {
                            type: "object",
                            properties: {
                                symbol: { type: "string" },
                            },
                            required: ["symbol"],
                        },
                    }],
                })
                return
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const inventory = await discoverHttpMcpToolInventory({
            providers: [{
                id: "macro",
                url: server.url,
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(inventory.inventory).toEqual([])
        expect(inventory.diagnostics).toContainEqual(expect.objectContaining({
            providerId: "macro",
            upstreamToolName: "market_context",
            registeredName: "mcp_macro_market_context",
            source: "tools/discover",
            reason: "duplicate_upstream_tool",
            schemaReason: expect.stringContaining("first tools/list schema"),
        }))

        const resolution = await createHttpMcpToolBindingResolution({
            providers: [{
                id: "macro",
                url: server.url,
                approvedTools: [{
                    name: "market_context",
                }],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(resolution.bindings).toEqual([])
        expect(resolution.diagnostics).toContainEqual(expect.objectContaining({
            upstreamToolName: "market_context",
            reason: "duplicate_upstream_tool",
        }))
        expect(resolution.diagnostics.some((diagnostic) =>
            diagnostic.upstreamToolName === "market_context" && diagnostic.reason === "tool_disappeared"
        )).toBe(false)
    })

    it("replays persisted category discovery inputs before binding approved nested tools", async () => {
        const receivedDiscoveryInputs: unknown[] = []
        const marketContextInputSchema = {
            type: "object",
            properties: {},
        }
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "category-discovery-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "discover_tools",
                        description: "Discover category tools",
                        inputSchema: {
                            type: "object",
                            properties: {
                                category: { type: "string" },
                            },
                            required: ["category"],
                        },
                    }],
                })
                return
            }

            if (body.method === "tools/call") {
                const params = body.params as Record<string, unknown>
                if (params.name === "discover_tools") {
                    receivedDiscoveryInputs.push(params.arguments)
                    const input = params.arguments as Record<string, unknown> | undefined
                    writeJsonRpc(response, body.id, {
                        structuredContent: {
                            tools: input?.category === "macro_analysis"
                                ? [{
                                    name: "get_current_market_context",
                                    description: "Current macro context",
                                    inputSchema: marketContextInputSchema,
                                }]
                                : [],
                        },
                        content: [],
                    })
                    return
                }

                if (params.name === "get_current_market_context") {
                    writeJsonRpc(response, body.id, {
                        content: [{
                            type: "text",
                            text: "macro context",
                        }],
                    })
                    return
                }
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const persistedWhitelist = {
            discoveryTools: [{
                providerId: "core_api",
                toolName: "discover_tools",
                input: { category: "macro_analysis" },
            }],
            tools: [{
                providerId: "core_api",
                toolName: "get_current_market_context",
                registeredName: "mcp_core_api_get_current_market_context",
                schemaHash: hashMcpToolSchema(marketContextInputSchema),
            }],
        }
        const scopedProvider = createScopedMcpProviderConfig({
            provider: {
                id: "core_api",
                url: server.url,
            },
            tools: persistedWhitelist.tools,
            discoveryRequests: persistedWhitelist.discoveryTools,
        })

        const resolution = await createHttpMcpToolBindingResolution({
            providers: [scopedProvider],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(scopedProvider.discoveryTools).toEqual([{
            name: "discover_tools",
            inputs: [{ category: "macro_analysis" }],
        }])
        expect(scopedProvider.approvedTools).toEqual([{
            name: "get_current_market_context",
            registeredName: "mcp_core_api_get_current_market_context",
            schemaHash: hashMcpToolSchema(marketContextInputSchema),
        }])
        expect(receivedDiscoveryInputs).toEqual([{ category: "macro_analysis" }])
        expect(resolution.bindings.map((tool) => tool.name)).toEqual(["mcp_core_api_get_current_market_context"])
        await expect(resolution.bindings[0]?.handler({})).resolves.toMatchObject({
            content: [{
                type: "text",
                text: "macro context",
            }],
        })
    })

    it("treats tools returned by an approved discovery tool as derived approvals", async () => {
        const receivedToolCalls: Array<{ name: string, arguments: unknown }> = []
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "dynamic-discovery-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "discover_tools",
                        description: "Discover provider tools",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" },
                                limit: { type: "number" },
                            },
                            required: ["query"],
                        },
                    }],
                })
                return
            }

            if (body.method === "tools/call") {
                const params = body.params as Record<string, unknown>
                receivedToolCalls.push({
                    name: String(params.name),
                    arguments: params.arguments,
                })

                if (params.name === "discover_tools") {
                    const input = params.arguments as Record<string, unknown> | undefined
                    const query = input?.query
                    writeJsonRpc(response, body.id, {
                        structuredContent: {
                            tools: [{
                                name: query === "rates" ? "dynamic_lookup" : "catalog_lookup",
                                description: query === "rates" ? "Dynamic lookup" : "Catalog lookup",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        query: { type: "string" },
                                    },
                                    required: ["query"],
                                },
                            }],
                        },
                        content: [],
                    })
                    return
                }

                if (params.name === "catalog_lookup") {
                    writeJsonRpc(response, body.id, {
                        content: [{
                            type: "text",
                            text: "catalog result",
                        }],
                    })
                    return
                }

                if (params.name === "dynamic_lookup") {
                    writeJsonRpc(response, body.id, {
                        content: [{
                            type: "text",
                            text: "dynamic result",
                        }],
                    })
                    return
                }
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const registry = new ToolRegistry()
        const diagnostics: McpToolDiagnostic[] = []
        const resolution = await createHttpMcpToolBindingResolution({
            providers: [{
                id: "macro",
                url: server.url,
                approvedTools: [
                    { name: "discover_tools" },
                ],
            }],
            logger: createLogger({ minLevel: "fatal" }),
            dynamicToolRegistry: registry,
            dynamicDiagnostics: diagnostics,
        })

        for (const binding of resolution.bindings) {
            registry.register(binding)
        }

        expect(resolution.bindings.map((tool) => tool.name)).toEqual([
            "mcp_macro_discover_tools",
            "mcp_macro_catalog_lookup",
            "mcp_macro_call_discovered_tool",
        ])
        expect(resolution.diagnostics.some((diagnostic) => diagnostic.reason === "not_whitelisted")).toBe(false)
        expect(receivedToolCalls).toContainEqual({
            name: "discover_tools",
            arguments: { query: "", limit: 100 },
        })
        expect(registry.has("mcp_macro_dynamic_lookup")).toBe(false)

        await registry.get("mcp_macro_discover_tools")?.handler({ query: "rates" })

        expect(registry.has("mcp_macro_dynamic_lookup")).toBe(true)
        expect(diagnostics.some((diagnostic) => diagnostic.reason === "tool_disappeared")).toBe(false)

        const result = await registry.get("mcp_macro_dynamic_lookup")?.handler({ query: "cpi" })
        expect(result).toMatchObject({
            content: [{
                type: "text",
                text: "dynamic result",
            }],
        })

        const dispatched = await registry.get("mcp_macro_call_discovered_tool")?.handler({
            toolName: "dynamic_lookup",
            arguments: { query: "cpi" },
        })
        expect(dispatched).toMatchObject({
            content: [{
                type: "text",
                text: "dynamic result",
            }],
        })
    })

    it("dispatches tools discovered by name after the provider refreshes tools/list", async () => {
        let discovered = false
        const receivedToolCalls: Array<{ name: string, arguments: unknown }> = []
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "name-only-discovery-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [
                        {
                            name: "discover_tools",
                            description: "Discover provider tools",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    category: { type: "string" },
                                },
                                required: ["category"],
                            },
                        },
                        ...(discovered ? [{
                            name: "name_only_lookup",
                            description: "Lookup discovered after category selection",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    symbol: { type: "string" },
                                },
                                required: ["symbol"],
                            },
                        }] : []),
                    ],
                })
                return
            }

            if (body.method === "tools/call") {
                const params = body.params as Record<string, unknown>
                receivedToolCalls.push({
                    name: String(params.name),
                    arguments: params.arguments,
                })

                if (params.name === "discover_tools") {
                    const input = params.arguments as Record<string, unknown> | undefined
                    if (input?.category !== "macro_analysis") {
                        writeJsonRpc(response, body.id, {
                            content: [{
                                type: "text",
                                text: JSON.stringify({ error: "category required" }),
                            }],
                            structuredContent: {
                                error: "category required",
                            },
                            isError: true,
                        })
                        return
                    }

                    discovered = true
                    writeJsonRpc(response, body.id, {
                        structuredContent: {
                            category: "macro_analysis",
                            newly_available_tools: ["name_only_lookup"],
                        },
                        content: [],
                    })
                    return
                }

                if (params.name === "name_only_lookup") {
                    writeJsonRpc(response, body.id, {
                        content: [{
                            type: "text",
                            text: "name-only result",
                        }],
                    })
                    return
                }
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const registry = new ToolRegistry()
        const diagnostics: McpToolDiagnostic[] = []
        const resolution = await createHttpMcpToolBindingResolution({
            providers: [{
                id: "macro",
                url: server.url,
                approvedTools: [
                    { name: "discover_tools" },
                ],
            }],
            logger: createLogger({ minLevel: "fatal" }),
            dynamicToolRegistry: registry,
            dynamicDiagnostics: diagnostics,
        })

        for (const binding of resolution.bindings) {
            registry.register(binding)
        }

        expect(resolution.bindings.map((tool) => tool.name)).toEqual([
            "mcp_macro_discover_tools",
            "mcp_macro_call_discovered_tool",
        ])
        expect(registry.has("mcp_macro_name_only_lookup")).toBe(false)

        await registry.get("mcp_macro_discover_tools")?.handler({ category: "macro_analysis" })

        expect(registry.has("mcp_macro_name_only_lookup")).toBe(true)
        expect(diagnostics.some((diagnostic) =>
            diagnostic.upstreamToolName === "name_only_lookup" && diagnostic.reason === "not_whitelisted"
        )).toBe(false)

        const dispatched = await registry.get("mcp_macro_call_discovered_tool")?.handler({
            toolName: "name_only_lookup",
            arguments: { symbol: "SPY" },
        })
        expect(dispatched).toMatchObject({
            content: [{
                type: "text",
                text: "name-only result",
            }],
        })
        expect(receivedToolCalls).toContainEqual({
            name: "name_only_lookup",
            arguments: { symbol: "SPY" },
        })
    })

    it("fails closed when an approved MCP tool schema hash changes", async () => {
        const server = await createSingleToolServer("search")
        servers.push(server)

        const resolution = await createHttpMcpToolBindingResolution({
            providers: [{
                id: "macro",
                url: server.url,
                approvedTools: [{
                    name: "search",
                    registeredName: "mcp_macro_search",
                    schemaHash: "b".repeat(64),
                }],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(resolution.bindings).toEqual([])
        expect(resolution.diagnostics).toContainEqual(expect.objectContaining({
            providerId: "macro",
            upstreamToolName: "search",
            reason: "schema_changed",
        }))
    })

    it("records disappeared approved tools without exposing replacements", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "empty-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, { tools: [] })
                return
            }

            writeJsonRpc(response, body.id, { content: [] })
        })
        servers.push(server)

        const resolution = await createHttpMcpToolBindingResolution({
            providers: [{
                id: "macro",
                url: server.url,
                approvedTools: [{
                    name: "search",
                    registeredName: "mcp_macro_search",
                    schemaHash: "a".repeat(64),
                }],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(resolution.bindings).toEqual([])
        expect(resolution.diagnostics).toContainEqual(expect.objectContaining({
            providerId: "macro",
            upstreamToolName: "search",
            reason: "tool_disappeared",
        }))
    })

    it("surfaces allowlisted MCP tools that declare destructive or open-world annotations", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "unsafe-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [
                        {
                            name: "place_order",
                            inputSchema: {
                                type: "object",
                                properties: {},
                            },
                            annotations: {
                                destructiveHint: true,
                            },
                        },
                        {
                            name: "web_browse",
                            inputSchema: {
                                type: "object",
                                properties: {},
                            },
                            annotations: {
                                openWorldHint: true,
                            },
                        },
                    ],
                })
                return
            }

            writeJsonRpc(response, body.id, { content: [] })
        })
        servers.push(server)

        const resolution = await createHttpMcpToolBindingResolution({
            providers: [{
                id: "unsafe",
                url: server.url,
                allowedTools: ["place_order", "web_browse"],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(resolution.bindings.map((tool) => tool.name)).toEqual([
            "mcp_unsafe_place_order",
            "mcp_unsafe_web_browse",
        ])
        expect(resolution.inventory).toEqual(expect.arrayContaining([
            expect.objectContaining({
                upstreamToolName: "place_order",
                annotations: {
                    destructiveHint: true,
                },
            }),
            expect.objectContaining({
                upstreamToolName: "web_browse",
                annotations: {
                    openWorldHint: true,
                },
            }),
        ]))
        expect(resolution.diagnostics.some((diagnostic) => diagnostic.reason === "unsafe_annotation")).toBe(false)
    })

    it("records malformed annotation diagnostics without hiding allowlisted MCP tools", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "malformed-annotations-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [
                        {
                            name: "place_order",
                            inputSchema: {
                                type: "object",
                                properties: {},
                            },
                            annotations: {
                                destructiveHint: "true",
                            },
                        },
                        {
                            name: "web_browse",
                            inputSchema: {
                                type: "object",
                                properties: {},
                            },
                            annotations: {
                                openWorldHint: "true",
                            },
                        },
                    ],
                })
                return
            }

            writeJsonRpc(response, body.id, { content: [] })
        })
        servers.push(server)

        const resolution = await createHttpMcpToolBindingResolution({
            providers: [{
                id: "unsafe",
                url: server.url,
                allowedTools: ["place_order", "web_browse"],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(resolution.bindings.map((tool) => tool.name)).toEqual([
            "mcp_unsafe_place_order",
            "mcp_unsafe_web_browse",
        ])
        expect(resolution.inventory.map((tool) => tool.upstreamToolName)).toEqual([
            "place_order",
            "web_browse",
        ])
        expect(resolution.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                upstreamToolName: "place_order",
                reason: "unsafe_annotation",
                annotationReason: "destructiveHint must be boolean",
            }),
            expect.objectContaining({
                upstreamToolName: "web_browse",
                reason: "unsafe_annotation",
                annotationReason: "openWorldHint must be boolean",
            }),
        ]))
    })

    it("degrades repeated MCP research failures through tool category", async () => {
        const tools = await createHttpMcpToolBindings({
            providers: [{
                id: "macro",
                url: await createFailingMcpServerUrl(),
                allowedTools: ["search"],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })
        const registry = new ToolRegistry()
        for (const tool of tools) {
            registry.register(tool)
        }
        const engine = new ToolExecutionEngine({
            tools: registry,
            context: {
                runId: "run-mcp",
                strategyId: "strategy-mcp",
                app: "polymarket",
                timestamp: Date.now(),
                trigger: "cron",
                positions: [],
                accountState: {
                    balance: 0,
                    equity: 0,
                    buyingPower: 0,
                    marginUsed: 0,
                    marginAvailable: 0,
                    openPnl: 0,
                    dayPnl: 0,
                },
                policy: {},
                context: "",
            },
            logger: createLogger({ minLevel: "fatal" }),
            runStartedAt: Date.now(),
            runTimeoutMs: 60_000,
            maxRepeatedToolErrors: 3,
        })

        for (let index = 0; index < 3; index++) {
            await engine.executeMcpCall("mcp_macro_search", { query: "rates" }, `call-${index}`)
        }

        expect(engine.getOutcome().fatalFault).toBeUndefined()
        expect(engine.getOutcome().degradedResearch(true)).toMatchObject({
            active: true,
            decisionUnderDegradedContext: true,
            toolFailureCount: 1,
        })
    })

    it("publishes remote schema but leaves detailed argument validation to the provider", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "schema-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "search",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" },
                            },
                            required: ["query"],
                        },
                    }],
                })
                return
            }

            writeJsonRpc(response, body.id, { content: [] })
        })
        servers.push(server)

        const tools = await createHttpMcpToolBindings({
            providers: [{
                id: "macro",
                url: server.url,
                allowedTools: ["search"],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(tools[0]?.parameters.safeParse({ query: "rates" }).success).toBe(true)
        expect(tools[0]?.parameters.safeParse({ query: 42 }).success).toBe(true)
        expect(tools[0]?.jsonSchema).toMatchObject({
            required: ["query"],
        })
    })

    it("skips MCP tools with malformed nested input schema fields", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "bad-schema-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [
                        {
                            name: "bad_properties",
                            inputSchema: {
                                type: "object",
                                properties: "x",
                            },
                        },
                        {
                            name: "bad_required",
                            inputSchema: {
                                type: "object",
                                required: [1],
                            },
                        },
                        {
                            name: "bad_additional",
                            inputSchema: {
                                type: "object",
                                additionalProperties: "no",
                            },
                        },
                    ],
                })
                return
            }

            writeJsonRpc(response, body.id, { content: [] })
        })
        servers.push(server)

        const tools = await createHttpMcpToolBindings({
            providers: [{
                id: "macro",
                url: server.url,
                allowedTools: ["bad_properties", "bad_required", "bad_additional"],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(tools).toEqual([])
    })

    it("records malformed top-level MCP tools as skipped-tool diagnostics", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "malformed-list-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [
                        {
                            name: "valid_search",
                            inputSchema: {
                                type: "object",
                                properties: {},
                            },
                        },
                        {
                            name: "bad_description",
                            description: 42,
                            inputSchema: {
                                type: "object",
                                properties: {},
                            },
                        },
                        {
                            name: "bad_input",
                            inputSchema: "not-object",
                        },
                        {
                            description: "missing name",
                            inputSchema: {
                                type: "object",
                                properties: {},
                            },
                        },
                    ],
                })
                return
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const inventory = await discoverHttpMcpToolInventory({
            providers: [{
                id: "macro",
                url: server.url,
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(inventory.inventory.map((tool) => tool.upstreamToolName)).toEqual(["valid_search"])
        expect(inventory.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                upstreamToolName: "bad_description",
                reason: "malformed_tool",
            }),
            expect.objectContaining({
                upstreamToolName: "bad_input",
                reason: "schema_incompatible",
                schemaReason: "inputSchema must be an object",
            }),
            expect.objectContaining({
                reason: "invalid_name",
            }),
        ]))
        expect(inventory.diagnostics.some((diagnostic) => diagnostic.reason === "provider_unavailable")).toBe(false)
    })

    it("records malformed nested discovery results as skipped-tool diagnostics", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "malformed-nested-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "catalog_search",
                        inputSchema: {
                            type: "object",
                            properties: {},
                        },
                    }],
                })
                return
            }

            if (body.method === "tools/call") {
                writeJsonRpc(response, body.id, {
                    structuredContent: {
                        tools: [
                            {
                                name: "nested_valid",
                                inputSchema: {
                                    type: "object",
                                    properties: {},
                                },
                            },
                            {
                                name: "nested_bad",
                                inputSchema: "not-object",
                            },
                            {
                                description: "missing name",
                            },
                        ],
                    },
                })
                return
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const inventory = await discoverHttpMcpToolInventory({
            providers: [{
                id: "macro",
                url: server.url,
                discoveryTools: [{
                    name: "catalog_search",
                    inputs: [{}],
                }],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(inventory.inventory.map((tool) => tool.upstreamToolName)).toEqual(["catalog_search", "nested_valid"])
        expect(inventory.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                upstreamToolName: "nested_bad",
                source: "tool_search",
                reason: "schema_incompatible",
                schemaReason: "inputSchema must be an object",
            }),
            expect.objectContaining({
                source: "tool_search",
                reason: "invalid_name",
            }),
        ]))
    })

    it("rejects malformed MCP tools/call content blocks at the transport boundary", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "bad-call-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "search",
                        inputSchema: {
                            type: "object",
                            properties: {},
                        },
                    }],
                })
                return
            }

            if (body.method === "tools/call") {
                writeJsonRpc(response, body.id, {
                    content: [1],
                })
                return
            }

            writeJsonRpc(response, body.id, { content: [] })
        })
        servers.push(server)

        const tools = await createHttpMcpToolBindings({
            providers: [{
                id: "macro",
                url: server.url,
                allowedTools: ["search"],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        await expect(tools[0]?.handler({})).rejects.toThrow("malformed tools/call content")
    })

    it("does not collide names for remote tools that differ after the old truncation point", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "name-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [
                        {
                            name: `research_${"a".repeat(48)}_one`,
                            inputSchema: {
                                type: "object",
                                properties: {},
                            },
                        },
                        {
                            name: `research_${"a".repeat(48)}_two`,
                            inputSchema: {
                                type: "object",
                                properties: {},
                            },
                        },
                    ],
                })
                return
            }

            writeJsonRpc(response, body.id, { content: [] })
        })
        servers.push(server)

        const tools = await createHttpMcpToolBindings({
            providers: [{
                id: "macro",
                url: server.url,
                allowedTools: [
                    `research_${"a".repeat(48)}_one`,
                    `research_${"a".repeat(48)}_two`,
                ],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(new Set(tools.map((tool) => tool.name)).size).toBe(2)
        expect(tools.map((tool) => tool.name).every((name) => name.length <= 64)).toBe(true)
    })

    it("does not collide names for distinct raw names that sanitize to the same slug", async () => {
        const firstServer = await createSingleToolServer("search")
        const secondServer = await createSingleToolServer("search")
        servers.push(firstServer, secondServer)

        const tools = await createHttpMcpToolBindings({
            providers: [
                {
                    id: "macro.ai",
                    url: firstServer.url,
                    allowedTools: ["search"],
                },
                {
                    id: "macro-ai",
                    url: secondServer.url,
                    allowedTools: ["search"],
                },
            ],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(new Set(tools.map((tool) => tool.name)).size).toBe(2)
        expect(tools.map((tool) => tool.name).every((name) => name.length <= 64)).toBe(true)
    })

    it("bounds tools/list pagination before registering tools", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "loop-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [],
                    nextCursor: "same-cursor",
                })
                return
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        await expect(createHttpMcpToolBindings({
            providers: [{
                id: "macro",
                url: server.url,
                allowedTools: ["search"],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })).rejects.toThrow("returned repeated cursor")
    })

    it("waits for matching JSON-RPC responses in MCP event streams", async () => {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "sse-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeSse(response, [
                    {
                        jsonrpc: "2.0",
                        method: "notifications/progress",
                        params: {},
                    },
                    {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            tools: [{
                                name: "search",
                                inputSchema: {
                                    type: "object",
                                    properties: {},
                                },
                            }],
                        },
                    },
                ])
                return
            }

            writeJsonRpc(response, body.id, { content: [] })
        })
        servers.push(server)

        const tools = await createHttpMcpToolBindings({
            providers: [{
                id: "macro",
                url: server.url,
                allowedTools: ["search"],
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(tools.map((tool) => tool.name)).toEqual(["mcp_macro_search"])
    })

    async function createFailingMcpServerUrl(): Promise<string> {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "failing-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "search",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" },
                            },
                        },
                    }],
                })
                return
            }

            if (body.method === "tools/call") {
                writeJsonRpcError(response, body.id, -32000, "provider unavailable")
                return
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)
        return server.url
    }

    async function createSingleToolServer(toolName: string): Promise<{ url: string; close: () => void }> {
        return await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "single-tool-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: toolName,
                        inputSchema: {
                            type: "object",
                            properties: {},
                        },
                    }],
                })
                return
            }

            writeJsonRpc(response, body.id, { content: [] })
        })
    }
})

async function startMcpServer(
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
): Promise<{ url: string; close: () => void }> {
    const server = createServer((request, response) => {
        handler(request, response).catch((error) => {
            response.writeHead(500, { "Content-Type": "text/plain" })
            response.end(error instanceof Error ? error.message : String(error))
        })
    })

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve)
    })

    const address = server.address()
    if (!address || typeof address === "string") {
        throw new Error("Test MCP server did not bind to a TCP port")
    }

    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => server.close(),
    }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

function writeJsonRpc(response: ServerResponse, id: unknown, result: unknown): void {
    writeJson(response, {
        jsonrpc: "2.0",
        id,
        result,
    })
}

function writeJsonRpcError(response: ServerResponse, id: unknown, code: number, message: string): void {
    writeJson(response, {
        jsonrpc: "2.0",
        id,
        error: {
            code,
            message,
        },
    })
}

function writeJson(response: ServerResponse, body: unknown): void {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(body))
}

function writeSse(response: ServerResponse, events: unknown[]): void {
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    for (const event of events) {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    response.end()
}
