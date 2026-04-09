import { createClient, loadStrategiesFromDocument, runScript, } from "./lib/strategy-cli";
function policyEqual(a, b) {
    return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());
}
function describeDrifts(local, remote) {
    const drifts = [];
    if (local.app !== remote.app) {
        drifts.push(`app: ${remote.app} -> ${local.app}`);
    }
    if (local.enabled !== remote.enabled) {
        drifts.push(`enabled: ${remote.enabled} -> ${local.enabled}`);
    }
    if (local.schedule !== remote.schedule) {
        drifts.push(`schedule: ${remote.schedule} -> ${local.schedule}`);
    }
    if (!policyEqual(local.policy, remote.policy)) {
        drifts.push("policy: differs");
    }
    if (local.context.trim() !== remote.context.trim()) {
        drifts.push("context: differs");
    }
    return drifts;
}
runScript(async () => {
    const localStrategies = await loadStrategiesFromDocument();
    const client = createClient();
    const remoteStrategies = await client.getAllStrategies();
    const remoteByName = new Map(remoteStrategies.map((s) => [s.name, s]));
    const localByName = new Map(localStrategies.map((s) => [s.name, s]));
    const onlyLocal = [];
    const onlyRemote = [];
    const drifted = [];
    const synced = [];
    for (const local of localStrategies) {
        const remote = remoteByName.get(local.name);
        if (!remote) {
            onlyLocal.push(local.name);
            continue;
        }
        const drifts = describeDrifts(local, remote);
        if (drifts.length > 0) {
            drifted.push({ name: local.name, drifts });
        }
        else {
            synced.push(local.name);
        }
    }
    for (const remote of remoteStrategies) {
        if (!localByName.has(remote.name)) {
            onlyRemote.push(remote);
        }
    }
    const clean = onlyLocal.length === 0
        && onlyRemote.length === 0
        && drifted.length === 0;
    if (clean) {
        console.log(`All ${synced.length} strategies in sync`);
        return;
    }
    if (onlyLocal.length > 0) {
        console.log("In strategies.md but NOT in backend:");
        for (const name of onlyLocal) {
            console.log(`  + ${name}`);
        }
        console.log("");
    }
    if (onlyRemote.length > 0) {
        console.log("In backend but NOT in strategies.md:");
        for (const s of onlyRemote) {
            console.log(`  - ${s.name} (${s._id})`);
        }
        console.log("");
    }
    if (drifted.length > 0) {
        console.log("Config drift (md -> backend):");
        for (const { name, drifts } of drifted) {
            console.log(`  ~ ${name}`);
            for (const d of drifts) {
                console.log(`      ${d}`);
            }
        }
        console.log("");
    }
    if (synced.length > 0) {
        console.log(`${synced.length} strategies in sync`);
    }
});
