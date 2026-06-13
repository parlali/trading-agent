import {
    createClient,
    loadStrategyDocumentFromDisk,
    runScript,
} from "./lib/strategy-cli"
import type { StoredAccount, StoredStrategy } from "@valiq-trading/convex"
import type { AccountConfig, StrategyConfig } from "@valiq-trading/core"

function policyEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort())
}

function describeDrifts(local: StrategyConfig, remote: StoredStrategy): string[] {
    const drifts: string[] = []

    if (local.app !== remote.app) {
        drifts.push(`app: ${remote.app} -> ${local.app}`)
    }
    if (local.accountId !== remote.accountId) {
        drifts.push(`accountId: ${remote.accountId} -> ${local.accountId}`)
    }
    if (local.enabled !== remote.enabled) {
        drifts.push(`enabled: ${remote.enabled} -> ${local.enabled}`)
    }
    if (local.schedule !== remote.schedule) {
        drifts.push(`schedule: ${remote.schedule} -> ${local.schedule}`)
    }
    if (!policyEqual(local.policy as Record<string, unknown>, remote.policy)) {
        drifts.push("policy: differs")
    }
    if (local.context.trim() !== remote.context.trim()) {
        drifts.push("context: differs")
    }

    return drifts
}

function describeAccountDrifts(local: AccountConfig, remote: StoredAccount): string[] {
    const drifts: string[] = []

    if (local.app !== remote.app) {
        drifts.push(`app: ${remote.app} -> ${local.app}`)
    }
    if (local.label !== remote.label) {
        drifts.push(`label: ${remote.label} -> ${local.label}`)
    }
    if (local.credentialEnvPrefix !== remote.credentialEnvPrefix) {
        drifts.push(`credentialEnvPrefix: ${remote.credentialEnvPrefix} -> ${local.credentialEnvPrefix}`)
    }
    if (local.status !== remote.status) {
        drifts.push(`status: ${remote.status} -> ${local.status}`)
    }
    if ((local.notes ?? "") !== (remote.notes ?? "")) {
        drifts.push("notes: differs")
    }

    return drifts
}

function accountKey(account: Pick<AccountConfig, "app" | "accountId">): string {
    return `${account.app}:${account.accountId}`
}

runScript(async () => {
    const { accounts: localAccounts, strategies: localStrategies } = await loadStrategyDocumentFromDisk()
    const client = createClient()
    const [remoteAccounts, remoteStrategies] = await Promise.all([
        client.getAccounts(),
        client.getAllStrategies(),
    ])

    const remoteAccountsByKey = new Map(remoteAccounts.map((account) => [accountKey(account), account]))
    const localAccountsByKey = new Map(localAccounts.map((account) => [accountKey(account), account]))
    const remoteByName = new Map(remoteStrategies.map((s) => [s.name, s]))
    const localByName = new Map(localStrategies.map((s) => [s.name, s]))

    const onlyLocalAccounts: string[] = []
    const onlyRemoteAccounts: StoredAccount[] = []
    const driftedAccounts: Array<{ key: string; drifts: string[] }> = []
    const onlyLocal: string[] = []
    const onlyRemote: StoredStrategy[] = []
    const drifted: Array<{ name: string; drifts: string[] }> = []
    const synced: string[] = []

    for (const local of localAccounts) {
        const key = accountKey(local)
        const remote = remoteAccountsByKey.get(key)
        if (!remote) {
            onlyLocalAccounts.push(key)
            continue
        }

        const drifts = describeAccountDrifts(local, remote)
        if (drifts.length > 0) {
            driftedAccounts.push({ key, drifts })
        }
    }

    for (const remote of remoteAccounts) {
        if (!localAccountsByKey.has(accountKey(remote))) {
            onlyRemoteAccounts.push(remote)
        }
    }

    for (const local of localStrategies) {
        const remote = remoteByName.get(local.name)

        if (!remote) {
            onlyLocal.push(local.name)
            continue
        }

        const drifts = describeDrifts(local, remote)

        if (drifts.length > 0) {
            drifted.push({ name: local.name, drifts })
        } else {
            synced.push(local.name)
        }
    }

    for (const remote of remoteStrategies) {
        if (!localByName.has(remote.name)) {
            onlyRemote.push(remote)
        }
    }

    const clean = onlyLocal.length === 0
        && onlyRemote.length === 0
        && drifted.length === 0
        && onlyLocalAccounts.length === 0
        && onlyRemoteAccounts.length === 0
        && driftedAccounts.length === 0

    if (clean) {
        console.log(`All ${localAccounts.length} accounts and ${synced.length} strategies in sync`)
        return
    }

    if (onlyLocalAccounts.length > 0) {
        console.log("Accounts in strategies.md but NOT in backend:")
        for (const key of onlyLocalAccounts) {
            console.log(`  + ${key}`)
        }
        console.log("")
    }

    if (onlyRemoteAccounts.length > 0) {
        console.log("Accounts in backend but NOT in strategies.md:")
        for (const account of onlyRemoteAccounts) {
            console.log(`  - ${account.app}:${account.accountId} (${account.label})`)
        }
        console.log("")
    }

    if (driftedAccounts.length > 0) {
        console.log("Account drift (md -> backend):")
        for (const { key, drifts } of driftedAccounts) {
            console.log(`  ~ ${key}`)
            for (const d of drifts) {
                console.log(`      ${d}`)
            }
        }
        console.log("")
    }

    if (onlyLocal.length > 0) {
        console.log("In strategies.md but NOT in backend:")
        for (const name of onlyLocal) {
            console.log(`  + ${name}`)
        }
        console.log("")
    }

    if (onlyRemote.length > 0) {
        console.log("In backend but NOT in strategies.md:")
        for (const s of onlyRemote) {
            console.log(`  - ${s.name} (${s._id})`)
        }
        console.log("")
    }

    if (drifted.length > 0) {
        console.log("Config drift (md -> backend):")
        for (const { name, drifts } of drifted) {
            console.log(`  ~ ${name}`)
            for (const d of drifts) {
                console.log(`      ${d}`)
            }
        }
        console.log("")
    }

    if (synced.length > 0) {
        console.log(`${synced.length} strategies in sync`)
    }
})
