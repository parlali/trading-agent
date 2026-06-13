import {
    createClient,
    getStrategyLlmSummary,
    loadStrategyDocumentFromDisk,
    findStrategyByName,
    requireArg,
    runScript,
} from "./lib/strategy-cli"

runScript(async () => {
    const name = requireArg("name")
    const { accounts, strategies } = await loadStrategyDocumentFromDisk()
    const config = findStrategyByName(strategies, name)
    const account = accounts.find((entry) =>
        entry.app === config.app && entry.accountId === config.accountId
    )
    if (!account) {
        throw new Error(`Account ${config.app}:${config.accountId} is not declared`)
    }

    const client = createClient()
    await client.upsertAccount(account)
    const id = await client.addStrategy(config)

    console.log(`Added "${config.name}" (${config.app}:${config.accountId}, enabled=${config.enabled}, llm=${getStrategyLlmSummary(config)})`)
    console.log(`ID: ${id}`)
})
