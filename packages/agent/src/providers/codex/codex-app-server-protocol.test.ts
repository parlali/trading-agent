import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import {
    CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS,
    CODEX_APP_SERVER_CLIENT_NOTIFICATION_METHODS,
    CODEX_APP_SERVER_NOTIFICATION_METHODS,
    CODEX_APP_SERVER_REQUEST_METHODS,
} from "./codex-app-server-protocol"

function hasCodexCli(): boolean {
    return spawnSync("codex", ["--version"], {
        stdio: "ignore",
    }).status === 0
}

describe("Codex app-server protocol compatibility", () => {
    it.skipIf(!hasCodexCli())("keeps the locally used method names present in generated Codex schemas", async () => {
        const directory = await mkdtemp(join(tmpdir(), "valiq-codex-schema-"))

        try {
            const result = spawnSync("codex", [
                "app-server",
                "generate-json-schema",
                "--out",
                directory,
            ], {
                encoding: "utf8",
            })
            const stderr = result.stderr
            const stdout = result.stdout

            expect(`${stdout}${stderr}`).not.toContain("CODEX_ACCESS_TOKEN")
            expect(result.status, stderr || stdout).toBe(0)

            const schema = JSON.parse(await readFile(join(directory, "codex_app_server_protocol.schemas.json"), "utf8")) as unknown
            const methods = collectMethodEnums(schema)
            const requiredMethods = [
                ...CODEX_APP_SERVER_REQUEST_METHODS,
                ...CODEX_APP_SERVER_NOTIFICATION_METHODS,
                ...CODEX_APP_SERVER_CLIENT_NOTIFICATION_METHODS,
                ...CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS,
            ]

            for (const method of requiredMethods) {
                expect(methods.has(method), `missing Codex app-server schema method ${method}`).toBe(true)
            }
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            })
        }
    })
})

function collectMethodEnums(value: unknown): Set<string> {
    const methods = new Set<string>()
    walkSchema(value, methods)
    return methods
}

function walkSchema(value: unknown, methods: Set<string>): void {
    if (!value || typeof value !== "object") {
        return
    }

    const record = value as Record<string, unknown>
    const properties = readRecord(record.properties)
    const method = readRecord(properties?.method)
    const enums = Array.isArray(method?.enum) ? method.enum : []
    for (const enumValue of enums) {
        if (typeof enumValue === "string") {
            methods.add(enumValue)
        }
    }

    for (const child of Object.values(record)) {
        walkSchema(child, methods)
    }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}
