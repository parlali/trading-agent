export const AGENT_CHAT_TOOL_PAYLOAD_SCHEMA_VERSION = 1

export type AgentChatToolPayload = {
    schemaVersion: typeof AGENT_CHAT_TOOL_PAYLOAD_SCHEMA_VERSION
    encoding: "json"
    json: string
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export function encodeAgentChatToolPayload(value: unknown): AgentChatToolPayload | undefined {
    if (value === undefined) {
        return undefined
    }

    return {
        schemaVersion: AGENT_CHAT_TOOL_PAYLOAD_SCHEMA_VERSION,
        encoding: "json",
        json: stringifyCanonicalJson(toJsonValue(value, "$", new WeakSet<object>())),
    }
}

export function decodeAgentChatToolPayload(payload: AgentChatToolPayload | undefined): unknown {
    if (!payload) {
        return undefined
    }
    if (
        payload.schemaVersion !== AGENT_CHAT_TOOL_PAYLOAD_SCHEMA_VERSION ||
        payload.encoding !== "json"
    ) {
        throw new Error(`Unsupported agent chat tool payload envelope version ${payload.schemaVersion}`)
    }

    return JSON.parse(payload.json) as unknown
}

function toJsonValue(value: unknown, path: string, seen: WeakSet<object>): JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return value
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`Agent chat tool payload contains non-finite number at ${path}`)
        }
        return value
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => {
            if (item === undefined) {
                throw new Error(`Agent chat tool payload contains undefined array item at ${path}[${index}]`)
            }
            return toJsonValue(item, `${path}[${index}]`, seen)
        })
    }
    if (value && typeof value === "object") {
        if (seen.has(value)) {
            throw new Error(`Agent chat tool payload contains circular reference at ${path}`)
        }
        if (!isPlainObject(value)) {
            throw new Error(`Agent chat tool payload contains non-plain object at ${path}`)
        }

        seen.add(value)
        const record = value as Record<string, unknown>
        const jsonRecord: { [key: string]: JsonValue } = {}
        for (const key of Object.keys(record).sort()) {
            const entry = record[key]
            if (entry === undefined) {
                throw new Error(`Agent chat tool payload contains undefined object field at ${path}.${key}`)
            }
            jsonRecord[key] = toJsonValue(entry, `${path}.${key}`, seen)
        }
        seen.delete(value)
        return jsonRecord
    }

    throw new Error(`Agent chat tool payload contains unsupported value at ${path}`)
}

function stringifyCanonicalJson(value: JsonValue): string {
    return JSON.stringify(value)
}

function isPlainObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}
