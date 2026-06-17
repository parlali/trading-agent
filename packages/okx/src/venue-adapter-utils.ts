import {
    createExecutionError,
    getIntentAction,
    isRiskReducingAction,
    type ExecutionResult,
    type OrderIntent,
    type Position,
} from "@valiq-trading/core"
import type {
    OKXApiPosSide,
    OKXFill,
    OKXInstrument,
    OKXOrderBookLevel,
    OKXOrderType,
    OKXPosition,
    OKXPositionMode,
} from "./okx-client"

export interface OKXInstrumentRules {
    instId: string
    baseCcy?: string
    quoteCcy?: string
    settleCcy?: string
    tickSize: number
    lotSize: number
    minContracts: number
    contractValue: number
    contractValueCurrency?: string
    instType: string
    state: string
}

export interface CompositeOrderId {
    kind: "order" | "algo"
    instId: string
    rawId: string
}

const OKX_CLOSE_LONG_SUBTYPES = new Set(["5", "100", "125", "208", "274", "328"])
const OKX_CLOSE_SHORT_SUBTYPES = new Set(["6", "101", "126", "209", "275", "329"])

export function resolvePositionSide(
    position: OKXPosition,
    positionMode: OKXPositionMode
): Position["side"] {
    if (positionMode === "long_short_mode") {
        if (position.posSide === "long") {
            return "long"
        }

        return "short"
    }

    return Number(position.pos) >= 0 ? "long" : "short"
}

export function parseInstrumentRules(
    instrument: OKXInstrument
): OKXInstrumentRules {
    const tickSize = Number(instrument.tickSz)
    const lotSize = Number(instrument.lotSz)
    const minContracts = Number(instrument.minSz)
    const contractValue = Number(instrument.ctVal)

    if (
        !Number.isFinite(tickSize) ||
        !Number.isFinite(lotSize) ||
        !Number.isFinite(minContracts) ||
        !Number.isFinite(contractValue) ||
        tickSize <= 0 ||
        lotSize <= 0 ||
        minContracts <= 0 ||
        contractValue <= 0
    ) {
        throw createExecutionError("venue", `Incomplete OKX instrument rules for ${instrument.instId}`, {
            code: "INSTRUMENT_RULES_INCOMPLETE",
            retryable: false,
            details: {
                instId: instrument.instId,
                tickSz: instrument.tickSz,
                lotSz: instrument.lotSz,
                minSz: instrument.minSz,
                ctVal: instrument.ctVal,
            },
        })
    }

    return {
        instId: instrument.instId,
        baseCcy: instrument.baseCcy,
        quoteCcy: instrument.quoteCcy,
        settleCcy: instrument.settleCcy,
        tickSize,
        lotSize,
        minContracts,
        contractValue,
        contractValueCurrency: instrument.ctValCcy,
        instType: instrument.instType,
        state: instrument.state,
    }
}

export function mapOKXOrderStatus(state: string): ExecutionResult["status"] {
    switch (state) {
        case "live":
            return "pending"
        case "partially_filled":
            return "partially_filled"
        case "filled":
            return "filled"
        case "canceled":
        case "mmp_canceled":
            return "cancelled"
        case "order_failed":
            return "rejected"
        default:
            return "pending"
    }
}

export function mapOKXAlgoOrderStatus(state?: string): ExecutionResult["status"] {
    switch (state) {
        case "effective":
        case "filled":
            return "filled"
        case "order_failed":
            return "rejected"
        case "canceled":
            return "cancelled"
        default:
            return "pending"
    }
}

export function mapToOKXOrderType(
    orderType: OrderIntent["orderType"],
    timeInForce: OrderIntent["timeInForce"]
): Exclude<OKXOrderType, "conditional"> {
    if (orderType === "market") {
        return "market"
    }

    if (timeInForce === "ioc") {
        return "ioc"
    }

    if (timeInForce === "fok") {
        return "fok"
    }

    if (timeInForce === "day") {
        throw createExecutionError(
            "pre_validation",
            "OKX swap does not support implicit day-end expiry semantics. Use gtc, ioc, or fok with explicit cancellation policy.",
            {
                code: "UNSUPPORTED_TIME_IN_FORCE",
                retryable: false,
                details: {
                    timeInForce,
                },
            }
        )
    }

    return "limit"
}

export function readFiniteMetadataNumber(
    metadata: OrderIntent["metadata"],
    key: string
): number | undefined {
    const value = metadata?.[key]
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function mapDepthSide(
    levels: OKXOrderBookLevel[],
    rules: OKXInstrumentRules
): Array<{ price: number; quantity: number }> {
    return levels.map(([price, size]) => ({
        price: Number(price),
        quantity: Number(size) * rules.contractValue,
    }))
}

export function resolveVerificationPrice(intent: OrderIntent): number | undefined {
    if (intent.orderType === "limit" || intent.orderType === "stop_limit") {
        return intent.limitPrice
    }

    return undefined
}

export function parseCompositeOrderId(orderId: string): CompositeOrderId | null {
    const [kind, instId, rawId] = orderId.split(":")

    if (
        (kind !== "order" && kind !== "algo") ||
        !instId ||
        !rawId
    ) {
        return null
    }

    return {
        kind,
        instId,
        rawId,
    }
}

export function toCompositeOrderId(
    kind: CompositeOrderId["kind"],
    instId: string,
    rawId: string
): string {
    return `${kind}:${instId}:${rawId}`
}

export function floorToStep(value: number, step: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
        return 0
    }

    const precision = countDecimals(step)
    const normalized = Math.floor(value / step) * step
    return Number(normalized.toFixed(precision))
}

export function roundToStep(value: number, step: number): number {
    const precision = countDecimals(step)
    return Number((Math.round(value / step) * step).toFixed(precision))
}

export function firstDefinedNumber(...values: Array<string | undefined>): number | undefined {
    for (const value of values) {
        if (isFiniteNumberString(value)) {
            return Number(value)
        }
    }

    return undefined
}

export function readFiniteNumberString(value?: string): number | undefined {
    return isFiniteNumberString(value) ? Number(value) : undefined
}

export function isCanonicalOKXCloseClientOrderId(value?: string): boolean {
    return typeof value === "string" && /^vokc[0-9a-z]{2}[a-z2-7]{10}$/.test(value)
}

export function isOKXCloseSubType(value?: string): boolean {
    const subType = value?.trim()
    return subType !== undefined &&
        (OKX_CLOSE_LONG_SUBTYPES.has(subType) || OKX_CLOSE_SHORT_SUBTYPES.has(subType))
}

export function isOKXClosingFill(fill: OKXFill): boolean {
    if (!isFiniteNumberString(fill.fillSz) ||
        Number(fill.fillSz) <= 0 ||
        !isFiniteNumberString(fill.fillPx) ||
        !isFiniteNumberString(fill.ts)
    ) {
        return false
    }

    if (fill.posSide === "long") {
        return fill.side === "sell"
    }

    if (fill.posSide === "short") {
        return fill.side === "buy"
    }

    return isOKXCloseSubType(fill.subType) ||
        isCanonicalOKXCloseClientOrderId(fill.clOrdId) ||
        fill.reduceOnly === "true" ||
        isFiniteNumberString(fill.fillPnl) && Number(fill.fillPnl) !== 0
}

export function resolveOKXClosurePositionSide(fill: OKXFill): Position["side"] {
    if (fill.posSide === "long") {
        return "long"
    }

    if (fill.posSide === "short") {
        return "short"
    }

    const subTypeSide = resolveOKXCloseSubTypePositionSide(fill.subType)
    if (subTypeSide) {
        return subTypeSide
    }

    return fill.side === "sell" ? "long" : "short"
}

function resolveOKXCloseSubTypePositionSide(value?: string): Position["side"] | undefined {
    const subType = value?.trim()
    if (!subType) {
        return undefined
    }

    if (OKX_CLOSE_LONG_SUBTYPES.has(subType)) {
        return "long"
    }

    if (OKX_CLOSE_SHORT_SUBTYPES.has(subType)) {
        return "short"
    }

    return undefined
}

export function sumOptionalNumberStrings(values: Array<string | undefined>): number | undefined {
    let total = 0
    let found = false

    for (const value of values) {
        if (!isFiniteNumberString(value)) {
            continue
        }

        total += Number(value)
        found = true
    }

    return found ? total : undefined
}

export function parseUnixMs(value?: string): number | undefined {
    if (!isFiniteNumberString(value)) {
        return undefined
    }

    return Number(value)
}

export function formatContracts(value: number): string {
    return formatNumber(value)
}

export function formatNumber(value: number): string {
    return value.toString()
}

export function isFiniteNumberString(value?: string): value is string {
    if (value === undefined || value === "") {
        return false
    }

    const parsed = Number(value)
    return Number.isFinite(parsed)
}

export function isCloseAction(intent: OrderIntent): boolean {
    return isRiskReducingAction(getIntentAction(intent))
}

export function resolveLeverage(intent: OrderIntent): number | undefined {
    const leverage = intent.metadata?.leverage
    if (typeof leverage !== "number") {
        return undefined
    }

    return Math.floor(leverage)
}

export function normalizeInstrument(value: string): string {
    return value.trim().toUpperCase()
}

function countDecimals(value: number): number {
    const asString = value.toString()
    const dotIndex = asString.indexOf(".")

    if (dotIndex === -1) {
        return 0
    }

    return asString.length - dotIndex - 1
}
