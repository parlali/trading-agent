export function formatCurrency(value: number, currency = "USD"): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value)
}

export function formatSignedCurrency(value: number, currency = "USD"): string {
    const formatted = formatCurrency(Math.abs(value), currency)
    if (value > 0) return `+${formatted}`
    if (value < 0) return `-${formatted}`
    return formatted
}

export function formatCompactCurrency(value: number, currency = "USD"): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        notation: "compact",
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
    }).format(value)
}

export function formatPercent(value: number): string {
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`
}

export function formatRelativeTime(timestamp: number): string {
    const now = Date.now()
    const diff = now - timestamp
    const seconds = Math.floor(diff / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (seconds < 60) return "just now"
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    return `${days}d ago`
}

export function formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    })
}

export function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    })
}
