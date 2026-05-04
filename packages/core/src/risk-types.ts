import type {
    AccountState,
    OrderIntent,
    Position,
    ValidationResult,
} from "./types"

export type RiskValidator = (
    intent: OrderIntent,
    policy: Record<string, unknown>,
    state: AccountState,
    positions: Position[]
) => ValidationResult
