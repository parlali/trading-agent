import type { OrderIntent, AccountState, Position, ValidationResult } from "./types";
export type RiskValidator = (intent: OrderIntent, policy: Record<string, unknown>, state: AccountState, positions: Position[]) => ValidationResult;
export declare const duplicateOrderValidator: RiskValidator;
export declare const BASE_RISK_VALIDATORS: readonly RiskValidator[];
export declare function validateIntent(intent: OrderIntent, policy: Record<string, unknown>, state: AccountState, positions: Position[], validators?: readonly RiskValidator[]): ValidationResult;
export declare class RiskEngine {
    private validators;
    constructor(validators?: readonly RiskValidator[]);
    validate(intent: OrderIntent, policy: Record<string, unknown>, state: AccountState, positions: Position[]): ValidationResult;
    getValidators(): readonly RiskValidator[];
}
export declare function createRiskEngine(validators?: readonly RiskValidator[]): RiskEngine;
export declare function createInstrumentConflictValidator(globallyClaimedInstruments: Map<string, string>): RiskValidator;
//# sourceMappingURL=risk.d.ts.map