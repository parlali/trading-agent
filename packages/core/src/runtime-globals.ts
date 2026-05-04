export type RuntimeEnvironment = Record<string, string | undefined>

export type RuntimeServeConfig = {
    port: number
    fetch(request: Request): Response | Promise<Response>
}

export type BunServeRuntime = {
    serve(config: RuntimeServeConfig): unknown
}

export type BunEnvironmentRuntime = {
    env: RuntimeEnvironment
}

export type BunBackendRuntime = BunServeRuntime & BunEnvironmentRuntime

export type ProcessSignalRuntime = {
    on(event: string, listener: () => void | Promise<void>): void
    exit(code?: number): void
}
