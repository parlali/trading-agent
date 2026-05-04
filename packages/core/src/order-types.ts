export const ORDER_STATUSES = [
    "pending",
    "partially_filled",
    "filled",
    "rejected",
    "cancelled",
    "expired",
    "timed_out",
] as const

export type OrderStatus = typeof ORDER_STATUSES[number]

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
    "filled",
    "rejected",
    "cancelled",
    "expired",
    "timed_out",
]

export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
    "pending",
    "partially_filled",
]

export const ORDER_ACTIONS = [
    "entry",
    "adjustment",
    "close",
    "modify",
    "cancel",
] as const

export type OrderAction = typeof ORDER_ACTIONS[number]
