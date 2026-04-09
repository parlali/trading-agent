import { requireResolvedSecret } from "@valiq-trading/core";
export const MT5_RUNTIME_SECRET_KEYS = [
    "MT5_WORKER_URL",
    "MT5_WORKER_ACCESS_KEY",
    "MT5_PRIMARY_LOGIN",
    "MT5_PRIMARY_PASSWORD",
    "MT5_PRIMARY_SERVER",
];
export function resolveMT5RuntimeConfig(secrets) {
    return {
        workerUrl: requireResolvedSecret(secrets, "MT5_WORKER_URL"),
        accessKey: requireResolvedSecret(secrets, "MT5_WORKER_ACCESS_KEY"),
        credentials: {
            login: Number(requireResolvedSecret(secrets, "MT5_PRIMARY_LOGIN")),
            password: requireResolvedSecret(secrets, "MT5_PRIMARY_PASSWORD"),
            server: requireResolvedSecret(secrets, "MT5_PRIMARY_SERVER"),
        },
    };
}
