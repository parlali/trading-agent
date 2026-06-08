export type FakeRow = {
    _id: string
    [key: string]: unknown
}

type RegisteredFunctionForTest = {
    _handler: (ctx: never, args: never) => Promise<unknown>
}

class FakeDb {
    constructor(private readonly rows: Record<string, FakeRow[]>) {}

    query(table: string) {
        return new FakeQuery(this.rows[table] ?? [])
    }
}

class FakeQuery {
    private filters: Array<{ field: string; value: unknown }> = []
    private orderDirection: "asc" | "desc" = "asc"

    constructor(private readonly rows: FakeRow[]) {}

    withIndex(_name: string, filter?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) {
        const queryFilter: { eq: (field: string, value: unknown) => unknown } = {
            eq: (field, value) => {
                this.filters.push({ field, value })
                return queryFilter
            },
        }
        filter?.(queryFilter)
        return this
    }

    order(direction: "asc" | "desc") {
        this.orderDirection = direction
        return this
    }

    async collect() {
        return this.applyFilters()
    }

    async take(limit: number) {
        return this.applyFilters().slice(0, limit)
    }

    private applyFilters() {
        const filtered = this.rows.filter((row) =>
            this.filters.every((filter) => row[filter.field] === filter.value)
        )

        return this.orderDirection === "desc"
            ? [...filtered].reverse()
            : filtered
    }
}

export async function callRegisteredQuery(
    registered: unknown,
    rows: Record<string, FakeRow[]>,
    args: Record<string, unknown>
): Promise<unknown> {
    const originalToken = process.env.BACKEND_SERVICE_TOKEN
    process.env.BACKEND_SERVICE_TOKEN = "test-token"
    const ctx = {
        auth: {
            getUserIdentity: async () => null,
        },
        db: new FakeDb(rows),
    }

    try {
        return await (registered as RegisteredFunctionForTest)._handler(ctx as never, {
            serviceToken: "test-token",
            ...args,
        } as never)
    } finally {
        if (originalToken === undefined) {
            delete process.env.BACKEND_SERVICE_TOKEN
        } else {
            process.env.BACKEND_SERVICE_TOKEN = originalToken
        }
    }
}
