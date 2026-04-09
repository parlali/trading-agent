export const VALIQ_DATA_SECRET_KEYS = [
    "VALIQ_DATA_API_URL",
    "VALIQ_DATA_API",
] as const

export interface ValiqDataApiConfig {
    apiUrl: string
    apiKey: string
}

export function resolveValiqDataApiConfig(
    secrets: Record<string, string | null>
): ValiqDataApiConfig | null {
    const apiUrl = secrets.VALIQ_DATA_API_URL
    const apiKey = secrets.VALIQ_DATA_API

    if (!apiUrl || !apiKey) {
        return null
    }

    return {
        apiUrl,
        apiKey,
    }
}

export function getMissingValiqDataApiSecrets(
    secrets: Record<string, string | null>
): string[] {
    return VALIQ_DATA_SECRET_KEYS.filter((key) => !secrets[key])
}
