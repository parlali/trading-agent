export type FakeRow = {
    _id: string
    [key: string]: unknown
}

type RegisteredFunctionForTest = {
    _handler: (ctx: never, args: never) => Promise<unknown>
}

type FakeIndexQuery = {
    eq: (field: string, value: unknown) => FakeIndexQuery
    lt: (field: string, value: unknown) => FakeIndexQuery
    gte: (field: string, value: unknown) => FakeIndexQuery
}

type FakeFilterBuilder = {
    field: (field: string) => { field: string }
    lt: (field: { field: string }, value: unknown) => boolean
    eq: (field: { field: string }, value: unknown) => boolean
}

class FakeDb {
    constructor(private readonly rows: Record<string, FakeRow[]>) {}

    query(table: string) {
        return new FakeQuery(this.rows[table] ?? [])
    }
}

class FakeQuery {
    private filters: Array<{ field: string; operator: "eq" | "lt" | "gte"; value: unknown }> = []
    private orderDirection: "asc" | "desc" = "asc"

    constructor(private readonly rows: FakeRow[]) {}

    withIndex(_name: string, filter?: (q: FakeIndexQuery) => unknown) {
        const queryFilter: FakeIndexQuery = {
            eq: (field, value) => {
                this.filters.push({ field, operator: "eq", value })
                return queryFilter
            },
            lt: (field, value) => {
                this.filters.push({ field, operator: "lt", value })
                return queryFilter
            },
            gte: (field, value) => {
                this.filters.push({ field, operator: "gte", value })
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

    filter(predicate: (q: FakeFilterBuilder) => unknown) {
        const builder: FakeFilterBuilder = {
            field: (field) => ({ field }),
            lt: (field, value) => {
                this.filters.push({ field: field.field, operator: "lt", value })
                return true
            },
            eq: (field, value) => {
                this.filters.push({ field: field.field, operator: "eq", value })
                return true
            },
        }
        predicate(builder)
        return this
    }

    async collect() {
        return this.applyFilters()
    }

    async take(limit: number) {
        return this.applyFilters().slice(0, limit)
    }

    async first() {
        return this.applyFilters()[0] ?? null
    }

    private applyFilters() {
        const filtered = this.rows.filter((row) =>
            this.filters.every((filter) => {
                if (filter.operator === "eq") {
                    return row[filter.field] === filter.value
                }
                if (filter.operator === "gte") {
                    return typeof row[filter.field] === "number" &&
                        typeof filter.value === "number" &&
                        row[filter.field] >= filter.value
                }
                return typeof row[filter.field] === "number" &&
                    typeof filter.value === "number" &&
                    row[filter.field] < filter.value
            })
        )

        return this.orderDirection === "desc"
            ? [...filtered].reverse()
            : filtered
    }
}

export function createFakeQueryDb(rows: Record<string, FakeRow[]>) {
    return new FakeDb(rows)
}

export async function callRegisteredQuery(
    registered: unknown,
    rows: Record<string, FakeRow[]>,
    args: Record<string, unknown>
): Promise<unknown> {
    const ctx = {
        auth: {
            getUserIdentity: async () => ({ subject: "test-user" }),
        },
        backendServiceToken: "test-token",
        db: new FakeDb(rows),
    }

    return await (registered as RegisteredFunctionForTest)._handler(ctx as never, {
        serviceToken: "test-token",
        ...args,
    } as never)
}
