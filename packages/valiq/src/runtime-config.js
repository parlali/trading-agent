export const VALIQ_DATA_SECRET_KEYS = [
    "VALIQ_DATA_API_URL",
    "VALIQ_DATA_API",
];
export function resolveValiqDataApiConfig(secrets) {
    const apiUrl = secrets.VALIQ_DATA_API_URL;
    const apiKey = secrets.VALIQ_DATA_API;
    if (!apiUrl || !apiKey) {
        return null;
    }
    return {
        apiUrl,
        apiKey,
    };
}
export function getMissingValiqDataApiSecrets(secrets) {
    return VALIQ_DATA_SECRET_KEYS.filter((key) => !secrets[key]);
}
