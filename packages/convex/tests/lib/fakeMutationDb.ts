export type FakeMutationRow = {
    _id: string
    [key: string]: unknown
}

type RegisteredFunctionForTest = {
    _handler: (ctx: never, args: never) => Promise<unknown>
}

export class FakeMutationDb {
    rows: Record<string, FakeMutationRow[]> = {}
    private nextId = 1

    constructor(seed: Record<string, Array<Record<string, unknown>>>) {
        for (const [table, rows] of Object.entries(seed)) {
            this.rows[table] = rows.map((row) => ({
                _id: String(row._id ?? `${table}-${this.nextId++}`),
                ...row,
            }))
        }
    }

    query(table: string) {
        return new FakeMutationQuery(this.rows[table] ?? [])
    }

    async insert(table: string, row: Record<string, unknown>) {
        const inserted = {
            _id: `${table}-${this.nextId++}`,
            _creationTime: Date.now(),
            ...row,
        }
        const rows = this.rows[table] ?? []
        rows.push(inserted)
        this.rows[table] = rows
        return inserted._id
    }

    async patch(id: string, patch: Record<string, unknown>) {
        for (const rows of Object.values(this.rows)) {
            const row = rows.find((entry) => entry._id === id)
            if (row) {
                Object.assign(row, patch)
                return
            }
        }
    }

    async delete(id: string) {
        for (const rows of Object.values(this.rows)) {
            const index = rows.findIndex((entry) => entry._id === id)
            if (index >= 0) {
                rows.splice(index, 1)
                return
            }
        }
    }

    async get(id: string) {
        for (const rows of Object.values(this.rows)) {
            const row = rows.find((entry) => entry._id === id)
            if (row) {
                return row
            }
        }

        return null
    }
}

class FakeMutationQuery {
    private filters: Array<{ field: string; value: unknown }> = []
    private orderDirection: "asc" | "desc" = "asc"

    constructor(
        private readonly rows: FakeMutationRow[]
    ) {}

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

    async first() {
        return this.applyFilters()[0] ?? null
    }

    async unique() {
        const rows = this.applyFilters()
        if (rows.length > 1) {
            throw new Error("Fake query expected unique result")
        }

        return rows[0] ?? null
    }

    async take(limit: number) {
        return this.applyFilters().slice(0, limit)
    }

    async paginate(args: { cursor: string | null; numItems: number }) {
        const rows = this.applyFilters()
        const start = args.cursor ? Number(args.cursor) : 0
        const page = rows.slice(start, start + args.numItems)
        const next = start + page.length

        return {
            page,
            isDone: next >= rows.length,
            continueCursor: String(next),
        }
    }

    private applyFilters() {
        const filtered = this.rows.filter((row) =>
            this.filters.every((filter) => row[filter.field] === filter.value)
        )

        if (this.orderDirection === "desc") {
            return [...filtered].reverse()
        }

        return filtered
    }
}

export async function callRegistered(
    registered: unknown,
    ctx: never,
    args: Record<string, unknown>
): Promise<unknown> {
    return await (registered as RegisteredFunctionForTest)._handler(ctx, args as never)
}
