export type FakeMutationRow = {
    _id: string
    [key: string]: unknown
}

export type FakeMutationQueryLogEntry = {
    table: string
    index?: string
    operation: "collect" | "first" | "unique" | "take" | "paginate"
    filters: Array<{ field: string; operator: "eq" | "gt" | "gte" | "lt" | "lte"; value: unknown }>
}

type RegisteredFunctionForTest = {
    _handler: (ctx: never, args: never) => Promise<unknown>
}

export class FakeMutationDb {
    rows: Record<string, FakeMutationRow[]> = {}
    documentsRead = 0
    queryLog: FakeMutationQueryLogEntry[] = []
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
        return new FakeMutationQuery(this, table, this.rows[table] ?? [])
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
    private filters: Array<{ field: string; operator: "eq" | "gt" | "gte" | "lt" | "lte"; value: unknown }> = []
    private orderDirection: "asc" | "desc" = "asc"
    private indexName: string | undefined

    constructor(
        private readonly db: FakeMutationDb,
        private readonly table: string,
        private readonly rows: FakeMutationRow[]
    ) {}

    withIndex(name: string, filter?: (q: FakeIndexFilterBuilder) => unknown) {
        this.indexName = name
        const queryFilter: FakeIndexFilterBuilder = {
            eq: (field, value) => {
                this.filters.push({ field, operator: "eq", value })
                return queryFilter
            },
            gt: (field, value) => {
                this.filters.push({ field, operator: "gt", value })
                return queryFilter
            },
            gte: (field, value) => {
                this.filters.push({ field, operator: "gte", value })
                return queryFilter
            },
            lt: (field, value) => {
                this.filters.push({ field, operator: "lt", value })
                return queryFilter
            },
            lte: (field, value) => {
                this.filters.push({ field, operator: "lte", value })
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
        const rows = this.applyFilters()
        this.recordQuery("collect")
        this.recordDocumentsRead(rows)
        return rows
    }

    async first() {
        const row = this.applyFilters()[0] ?? null
        this.recordQuery("first")
        this.recordDocumentsRead(row ? [row] : [])
        return row
    }

    async unique() {
        const rows = this.applyFilters()
        this.recordQuery("unique")
        this.recordDocumentsRead(rows)
        if (rows.length > 1) {
            throw new Error("Fake query expected unique result")
        }

        return rows[0] ?? null
    }

    async take(limit: number) {
        const rows = this.applyFilters().slice(0, limit)
        this.recordQuery("take")
        this.recordDocumentsRead(rows)
        return rows
    }

    async paginate(args: { cursor: string | null; numItems: number }) {
        const rows = this.applyFilters()
        const start = args.cursor ? Number(args.cursor) : 0
        const page = rows.slice(start, start + args.numItems)
        const next = start + page.length
        this.recordQuery("paginate")
        this.recordDocumentsRead(page)

        return {
            page,
            isDone: next >= rows.length,
            continueCursor: String(next),
        }
    }

    private applyFilters() {
        const filtered = this.rows.filter((row) =>
            this.filters.every((filter) => {
                const rowValue = readFieldPath(row, filter.field)
                if (filter.operator !== "eq" && rowValue === undefined) {
                    return false
                }
                const comparableRowValue = rowValue as string | number
                const comparableFilterValue = filter.value as string | number
                switch (filter.operator) {
                    case "eq":
                        if (filter.field === "enabled" && filter.value === true && rowValue === undefined) {
                            return true
                        }
                        return rowValue === filter.value
                    case "gt":
                        return comparableRowValue > comparableFilterValue
                    case "gte":
                        return comparableRowValue >= comparableFilterValue
                    case "lt":
                        return comparableRowValue < comparableFilterValue
                    case "lte":
                        return comparableRowValue <= comparableFilterValue
                }
            })
        )

        if (this.orderDirection === "desc") {
            return [...filtered].reverse()
        }

        return filtered
    }

    private recordDocumentsRead(rows: FakeMutationRow[]): void {
        this.db.documentsRead += rows.length
    }

    private recordQuery(operation: FakeMutationQueryLogEntry["operation"]): void {
        this.db.queryLog.push({
            table: this.table,
            index: this.indexName,
            operation,
            filters: [...this.filters],
        })
    }
}

function readFieldPath(row: FakeMutationRow, field: string): unknown {
    let value: unknown = row
    for (const segment of field.split(".")) {
        if (value === null || typeof value !== "object") {
            return undefined
        }
        value = (value as Record<string, unknown>)[segment]
    }

    return value
}

type FakeIndexFilterBuilder = {
    eq: (field: string, value: unknown) => unknown
    gt: (field: string, value: unknown) => unknown
    gte: (field: string, value: unknown) => unknown
    lt: (field: string, value: unknown) => unknown
    lte: (field: string, value: unknown) => unknown
}

export async function callRegistered(
    registered: unknown,
    ctx: never,
    args: Record<string, unknown>
): Promise<unknown> {
    return await (registered as RegisteredFunctionForTest)._handler(ctx, args as never)
}
