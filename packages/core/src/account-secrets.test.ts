import { describe, expect, it } from "vitest"
import {
    buildAccountSecretKeyMap,
    resolveAccountScopedSecretKeys,
} from "./account-secrets"

describe("account scoped secrets", () => {
    it("does not double-prefix MT5 primary credential keys", () => {
        const canonicalKeys = resolveAccountScopedSecretKeys("mt5", [
            "MT5_WORKER_URL",
            "MT5_WORKER_ACCESS_KEY",
            "MT5_PRIMARY_LOGIN",
            "MT5_PRIMARY_PASSWORD",
            "MT5_PRIMARY_SERVER",
        ])

        expect(Object.fromEntries(buildAccountSecretKeyMap({
            credentialEnvPrefix: "MT5_PRIMARY",
        }, canonicalKeys))).toEqual({
            MT5_PRIMARY_LOGIN: "MT5_PRIMARY_LOGIN",
            MT5_PRIMARY_PASSWORD: "MT5_PRIMARY_PASSWORD",
            MT5_PRIMARY_SERVER: "MT5_PRIMARY_SERVER",
        })
        expect(Object.fromEntries(buildAccountSecretKeyMap({
            credentialEnvPrefix: "MT5_SECONDARY",
        }, canonicalKeys))).toEqual({
            MT5_PRIMARY_LOGIN: "MT5_SECONDARY_LOGIN",
            MT5_PRIMARY_PASSWORD: "MT5_SECONDARY_PASSWORD",
            MT5_PRIMARY_SERVER: "MT5_SECONDARY_SERVER",
        })
    })

    it("maps canonical provider credentials into account-prefixed secret keys", () => {
        const canonicalKeys = resolveAccountScopedSecretKeys("okx-swap", [
            "OKX_API_KEY",
            "OKX_API_SECRET",
            "OKX_API_PASSPHRASE",
            "OKX_DEMO_TRADING",
            "OKX_MARGIN_MODE",
            "OKX_POSITION_MODE",
        ])

        expect(Object.fromEntries(buildAccountSecretKeyMap({
            credentialEnvPrefix: "OKX_PRIMARY",
        }, canonicalKeys))).toEqual({
            OKX_API_KEY: "OKX_PRIMARY_API_KEY",
            OKX_API_SECRET: "OKX_PRIMARY_API_SECRET",
            OKX_API_PASSPHRASE: "OKX_PRIMARY_API_PASSPHRASE",
            OKX_DEMO_TRADING: "OKX_PRIMARY_DEMO_TRADING",
            OKX_MARGIN_MODE: "OKX_PRIMARY_MARGIN_MODE",
            OKX_POSITION_MODE: "OKX_PRIMARY_POSITION_MODE",
        })
    })
})
