import { describe, expect, it } from "vitest"
import {
    formatEnvFileContents,
    getDefaultOutputPath,
    parseCliArgs,
} from "./derive-api-key.ts"

describe("parseCliArgs", () => {
    it("writes to the private overlay by default instead of stdout", () => {
        const options = parseCliArgs(["0x123"], "/repo")

        expect(options).toEqual({
            outputPath: "/repo/private/polymarket-credentials.env",
            privateKey: "0x123",
            stdout: false,
        })
    })

    it("supports an explicit output path", () => {
        const options = parseCliArgs(["0x123", "--out", "tmp/polymarket.env"], "/repo")

        expect(options).toEqual({
            outputPath: "/repo/tmp/polymarket.env",
            privateKey: "0x123",
            stdout: false,
        })
    })

    it("supports explicit stdout output", () => {
        const options = parseCliArgs(["0x123", "--stdout"], "/repo")

        expect(options).toEqual({
            outputPath: getDefaultOutputPath("/repo"),
            privateKey: "0x123",
            stdout: true,
        })
    })

    it("rejects mixed stdout and file output", () => {
        expect(() => parseCliArgs(["0x123", "--stdout", "--out", "tmp/polymarket.env"], "/repo")).toThrow(
            "Use either --stdout or --out, not both"
        )
    })
})

describe("formatEnvFileContents", () => {
    it("formats the credential file with the required env vars", () => {
        const contents = formatEnvFileContents({
            apiKey: "api-key",
            secret: "secret",
            passphrase: "passphrase",
        }, "0x123")

        expect(contents).toBe(
            [
                "POLYMARKET_API_KEY=api-key",
                "POLYMARKET_API_SECRET=secret",
                "POLYMARKET_API_PASSPHRASE=passphrase",
                "POLYMARKET_PRIVATE_KEY=0x123",
                "POLYMARKET_FUNDER_ADDRESS=<your Polymarket profile wallet address>",
                "",
            ].join("\n")
        )
    })
})
