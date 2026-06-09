import {
    proxyCodexOAuthRequest,
    redirectToIntegrations,
} from "@/lib/codex-oauth-server"

export const runtime = "nodejs"

export async function GET(request: Request): Promise<Response> {
    try {
        const response = await proxyCodexOAuthRequest("submit", {
            redirectUrl: request.url,
        })

        return redirectToIntegrations(request, response.ok ? "complete" : "failed")
    } catch {
        return redirectToIntegrations(request, "failed")
    }
}
