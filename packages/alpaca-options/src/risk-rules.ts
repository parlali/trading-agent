import {
    allowWithGateEvaluation,
    allowWithGateEvaluations,
    alpacaOptionsPolicySchema,
    createGateEvaluation,
    getIntentAction,
    openIntentRiskValidator,
    readFiniteNumber,
    readTrimmedString,
    rejectRiskWithGateEvaluation,
    rejectRiskWithGateEvaluations,
    type AccountState,
    type GateEvaluation,
    type OrderIntent,
    type OrderLeg,
    type OrderLegSide,
    type Position,
    type RiskValidator,
} from "@valiq-trading/core"

export interface ParsedOptionContract {
    underlying: string
    expiration: string
    optionType: "call" | "put"
    strike: number
}

export type AlpacaStructureType = "iron_condor" | "credit_vertical"
export type AlpacaVerticalSpreadType = "bull_put_credit" | "bear_call_credit"

interface NormalizedOptionLeg extends ParsedOptionContract {
    instrument: string
    quantity: number
    side: OrderLegSide
    positionEffect: "open" | "close"
    exposure: "long" | "short"
}

export interface ResolvedStructure {
    structureType: AlpacaStructureType
    verticalSpreadType?: AlpacaVerticalSpreadType
    underlying: string
    expiration: string
    spreadWidth: number
    sideSpreadWidths: number[]
    legs: NormalizedOptionLeg[]
}

export interface AlpacaOptionLegPositionLike {
    instrument: string
    side: "long" | "short"
}

export interface AlpacaOptionLegStructureGroups<TPosition extends AlpacaOptionLegPositionLike> {
    groups: Array<{ structure: ResolvedStructure; positions: TPosition[] }>
    ungrouped: TPosition[]
}

interface OwnedOptionStructureRisk {
    structure: ResolvedStructure
    quantity: number
    maxLoss: number
}

interface OwnedStructureRiskOnly {
    instrument: string
    maxLoss: number
}

interface OwnedOptionStructureResolution {
    structures: OwnedOptionStructureRisk[]
    riskOnlyStructures: OwnedStructureRiskOnly[]
    unevaluablePositions: string[]
}

interface StructureThesisSignature {
    underlying: string
    expiration: string
    structureType: string
    shortStrike: number
}

export const SHORT_STRIKE_DELTA_FIELDS = {
    credit_vertical: ["shortStrikeDelta"],
    iron_condor: ["shortCallDelta", "shortPutDelta"],
} as const satisfies Record<AlpacaStructureType, readonly string[]>

export const SHORT_STRIKE_DELTA_FIELD_NAMES = [
    ...SHORT_STRIKE_DELTA_FIELDS.credit_vertical,
    ...SHORT_STRIKE_DELTA_FIELDS.iron_condor,
] as const

export type ShortStrikeDeltaField = typeof SHORT_STRIKE_DELTA_FIELD_NAMES[number]

export interface ShortStrikeDeltaRequirement {
    field: ShortStrikeDeltaField
    symbol: string
}

export interface ShortStrikeDeltaClaim extends ShortStrikeDeltaRequirement {
    claimedDelta: number
}

export type ShortStrikeDeltaResolution =
    | { status: "not_applicable" }
    | { status: "unresolvable"; reason: string }
    | { status: "missing"; missingFields: ShortStrikeDeltaField[]; symbols: string[] }
    | { status: "claimed"; claims: ShortStrikeDeltaClaim[] }

const SUPPORTED_ALPACA_ORDER_TYPE = "limit"
const SUPPORTED_ALPACA_TIME_IN_FORCE = "day"
const SUPPORTED_LEG_COUNTS = new Set([2, 4])
const OPTION_CONTRACT_MULTIPLIER = 100
const CREDIT_GATE_EPSILON = 1e-9
const RISK_GATE_EPSILON = 1e-9

export const alpacaRiskValidators: readonly RiskValidator[] = [
    alpacaStructureValidator,
    openIntentRiskValidator(minCreditEntryValidator),
    openIntentRiskValidator(shortStrikeDeltaCeilingValidator),
    openIntentRiskValidator(maxLossPerPlayValidator),
    openIntentRiskValidator(maxSameThesisEntriesValidator),
    openIntentRiskValidator(maxAggregateRiskPercentValidator),
    expiryValidationValidator,
]

export function buildIronCondorInstrument(
    underlying: string,
    expiration: string,
    _quantity?: number
): string {
    return `IC:${underlying.toUpperCase()}:${expiration}`
}

export function buildCreditVerticalInstrument(
    underlying: string,
    expiration: string,
    verticalSpreadType: AlpacaVerticalSpreadType
): string {
    const type = verticalSpreadType === "bull_put_credit"
        ? "BULL_PUT_CREDIT"
        : "BEAR_CALL_CREDIT"
    return `VS:${type}:${underlying.toUpperCase()}:${expiration}`
}

export function buildIronCondorInstrumentFromLegs(
    underlying: string,
    expiration: string,
    legs: Array<{ instrument: string }>
): string {
    const normalizedLegs = legs
        .map((leg) => leg.instrument.trim().toUpperCase())
        .sort()
        .join("|")

    return `${buildIronCondorInstrument(underlying, expiration)}:${normalizedLegs}`
}

export function buildCreditVerticalInstrumentFromLegs(
    underlying: string,
    expiration: string,
    verticalSpreadType: AlpacaVerticalSpreadType,
    legs: Array<{ instrument: string }>
): string {
    const normalizedLegs = legs
        .map((leg) => leg.instrument.trim().toUpperCase())
        .sort()
        .join("|")

    return `${buildCreditVerticalInstrument(underlying, expiration, verticalSpreadType)}:${normalizedLegs}`
}

export function buildAlpacaStructureInstrumentFromLegs(structure: {
    structureType: AlpacaStructureType
    verticalSpreadType?: AlpacaVerticalSpreadType
    underlying: string
    expiration: string
    legs: Array<{ instrument: string }>
}): string {
    if (structure.structureType === "iron_condor") {
        return buildIronCondorInstrumentFromLegs(structure.underlying, structure.expiration, structure.legs)
    }

    if (!structure.verticalSpreadType) {
        throw new Error("Vertical Alpaca structure requires verticalSpreadType")
    }

    return buildCreditVerticalInstrumentFromLegs(
        structure.underlying,
        structure.expiration,
        structure.verticalSpreadType,
        structure.legs
    )
}

export function parseClaimedStructureInstrument(instrument: string): {
    structureType: AlpacaStructureType
    verticalSpreadType?: AlpacaVerticalSpreadType
    underlying: string
    expiration: string
    legs: string[]
} | null {
    const [kind, first, second, third, legList] = instrument.trim().toUpperCase().split(":")

    if (kind === "IC" && first && second && third) {
        const legs = splitStructureLegList(third)
        return legs.length === 4
            ? {
                structureType: "iron_condor",
                underlying: first,
                expiration: second,
                legs,
            }
            : null
    }

    if (kind !== "VS" || !first || !second || !third || !legList) {
        return null
    }

    const verticalSpreadType = first === "BULL_PUT_CREDIT"
        ? "bull_put_credit"
        : first === "BEAR_CALL_CREDIT"
            ? "bear_call_credit"
            : undefined
    if (!verticalSpreadType) {
        return null
    }

    const legs = splitStructureLegList(legList)
    return legs.length === 2
        ? {
            structureType: "credit_vertical",
            verticalSpreadType,
            underlying: second,
            expiration: third,
            legs,
        }
        : null
}

function splitStructureLegList(value: string): string[] {
    return value
        .split("|")
        .map((leg) => leg.trim().toUpperCase())
        .filter((leg) => leg.length > 0)
}

export function parseOptionContractSymbol(symbol: string): ParsedOptionContract | null {
    const normalized = symbol.trim().toUpperCase()
    if (normalized.length < 15) {
        return null
    }

    const suffix = normalized.slice(-15)
    const underlying = normalized.slice(0, -15).trim()
    const datePart = suffix.slice(0, 6)
    const typePart = suffix.slice(6, 7)
    const strikePart = suffix.slice(7)

    if (!/^\d{6}$/.test(datePart) || !/^\d{8}$/.test(strikePart) || (typePart !== "C" && typePart !== "P")) {
        return null
    }

    const year = `20${datePart.slice(0, 2)}`
    const month = datePart.slice(2, 4)
    const day = datePart.slice(4, 6)

    return {
        underlying,
        expiration: `${year}-${month}-${day}`,
        optionType: typePart === "C" ? "call" : "put",
        strike: Number(strikePart) / 1000,
    }
}

function alpacaStructureValidator(intent: OrderIntent) {
    const action = getIntentAction(intent)

    if (action === "adjustment") {
        return {
            allowed: false,
            reason: "Alpaca options adjustments are not supported for this strategy path. Use modify_order for working entries or propose_close for filled structures.",
        }
    }

    if (!intent.legs || intent.legs.length === 0) {
        return {
            allowed: false,
            reason: "Alpaca options orders must be submitted as either a 2-leg credit vertical or a 4-leg iron condor",
        }
    }

    if (!SUPPORTED_LEG_COUNTS.has(intent.legs.length)) {
        return {
            allowed: false,
            reason: "Alpaca options structures must contain exactly 2 or 4 legs",
        }
    }

    if (!Number.isInteger(intent.quantity) || intent.quantity <= 0) {
        return {
            allowed: false,
            reason: "Alpaca options structures require a positive integer structure quantity",
        }
    }

    if (intent.orderType !== SUPPORTED_ALPACA_ORDER_TYPE) {
        return {
            allowed: false,
            reason: "Alpaca options structures only support limit pricing",
        }
    }

    if (intent.timeInForce !== SUPPORTED_ALPACA_TIME_IN_FORCE) {
        return {
            allowed: false,
            reason: "Alpaca options structures only support day time in force",
        }
    }

    if (intent.stopPrice !== undefined) {
        return {
            allowed: false,
            reason: "Alpaca options structures do not support stop prices",
        }
    }

    if (intent.limitPrice === undefined || intent.limitPrice <= 0) {
        return {
            allowed: false,
            reason: "Alpaca options structures require a positive net credit/debit limit price",
        }
    }

    if (intent.legs.some((leg) => leg.limitPrice !== undefined)) {
        return {
            allowed: false,
            reason: "Per-leg limit prices are not supported for Alpaca options structures",
        }
    }

    const normalizedLegs = normalizeOptionLegs(intent)
    if (!Array.isArray(normalizedLegs)) {
        return normalizedLegs
    }

    const expirations = new Set(normalizedLegs.map((leg) => leg.expiration))
    if (expirations.size !== 1) {
        return {
            allowed: false,
            reason: "All legs in an Alpaca options structure must share the same expiration",
        }
    }

    const underlyings = new Set(normalizedLegs.map((leg) => leg.underlying))
    if (underlyings.size !== 1) {
        return {
            allowed: false,
            reason: "All legs in an Alpaca options structure must share the same underlying",
        }
    }

    const expectedEffect = action === "close" ? "close" : "open"
    if (normalizedLegs.some((leg) => leg.positionEffect !== expectedEffect)) {
        return {
            allowed: false,
            reason: action === "close"
                ? "Closing a structure requires buy_to_close/sell_to_close legs"
                : "Opening a structure requires buy_to_open/sell_to_open legs",
        }
    }

    if (!hasSupportedLegRatios(intent, normalizedLegs)) {
        return {
            allowed: false,
            reason: "Each Alpaca options structure leg must use a 1-lot ratio matching the top-level structure quantity",
        }
    }

    const resolvedStructure = resolveStructureFromNormalizedLegs(normalizedLegs)
    if (!resolvedStructure) {
        return {
            allowed: false,
            reason: normalizedLegs.length === 4
                ? "Leg strikes do not form a valid iron condor geometry"
                : "Leg strikes do not form a valid one-sided credit vertical",
        }
    }

    const structureLegs = resolvedStructure.legs
        .map((leg) => leg.instrument.trim().toUpperCase())
        .sort()

    return {
        allowed: true,
        adjustedIntent: {
            ...intent,
            instrument: buildAlpacaStructureInstrumentFromLegs({
                structureType: resolvedStructure.structureType,
                verticalSpreadType: resolvedStructure.verticalSpreadType,
                underlying: resolvedStructure.underlying,
                expiration: resolvedStructure.expiration,
                legs: resolvedStructure.legs,
            }),
            side: action === "close" ? "buy" : "sell",
            orderType: SUPPORTED_ALPACA_ORDER_TYPE,
            timeInForce: SUPPORTED_ALPACA_TIME_IN_FORCE,
            stopPrice: undefined,
            legs: resolvedStructure.legs.map<OrderLeg>((leg) => ({
                instrument: leg.instrument,
                side: leg.side,
                quantity: 1,
            })),
            metadata: {
                ...intent.metadata,
                action,
                structureType: resolvedStructure.structureType,
                verticalSpreadType: resolvedStructure.verticalSpreadType,
                underlying: resolvedStructure.underlying,
                expiration: resolvedStructure.expiration,
                expectedExpiration: resolvedStructure.expiration,
                spreadWidth: resolvedStructure.spreadWidth,
                structureLegs,
            },
        },
    }
}

function maxLossPerPlayValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    _positions: Position[]
) {
    const policy = alpacaOptionsPolicySchema.parse(rawPolicy)
    const estimatedMaxLoss = estimateStructureMaxLoss(intent)

    if (estimatedMaxLoss === null) {
        return {
            allowed: false,
            reason: "Unable to determine max loss for Alpaca options structure",
        }
    }

    const gateEvaluation = createGateEvaluation({
        gateKey: "alpacaOptions.maxLossPerPlay",
        observed: estimatedMaxLoss,
        threshold: policy.maxLossPerPlay,
        comparison: "max",
    })

    if (estimatedMaxLoss > policy.maxLossPerPlay) {
        return rejectRiskWithGateEvaluation(
            `Estimated max loss ${estimatedMaxLoss} exceeds limit ${policy.maxLossPerPlay}`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
}

function maxSameThesisEntriesValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    positions: Position[]
) {
    const policy = alpacaOptionsPolicySchema.parse(rawPolicy)
    if (policy.maxSameThesisEntries === undefined) {
        return { allowed: true }
    }
    const maxSameThesisEntries = policy.maxSameThesisEntries

    if (getIntentAction(intent) !== "entry") {
        return { allowed: true }
    }

    const entryStructure = resolveEntryStructure(intent)
    if (!entryStructure) {
        return {
            allowed: false,
            reason: "Unable to determine Alpaca entry structure thesis",
        }
    }

    const entryQuantity = readPositiveIntegerQuantity(intent.quantity)
    if (entryQuantity === null) {
        return {
            allowed: false,
            reason: "Unable to determine Alpaca entry structure quantity",
        }
    }

    const entrySignatures = resolveStructureThesisSignatures(entryStructure)
    if (entrySignatures.length === 0) {
        return {
            allowed: false,
            reason: "Unable to determine Alpaca entry short strike thesis",
        }
    }

    const owned = resolveOwnedOptionStructuresForRisk(positions)
    const ownedCounts = countOwnedThesisStructures(owned.structures)
    const gateEvaluations = entrySignatures.map((signature) => {
        const postEntryCount = (ownedCounts.get(formatThesisSignatureKey(signature)) ?? 0) + entryQuantity
        return {
            signature,
            postEntryCount,
            gateEvaluation: createGateEvaluation({
                gateKey: "alpacaOptions.maxSameThesisEntries",
                observed: postEntryCount,
                threshold: maxSameThesisEntries,
                comparison: "max",
            }),
        }
    })
    const breached = gateEvaluations.find((evaluation) =>
        evaluation.postEntryCount > maxSameThesisEntries
    )

    if (breached) {
        const ownedCount = breached.postEntryCount - entryQuantity
        return rejectRiskWithGateEvaluation(
            `Same Alpaca options thesis ${formatThesisSignature(breached.signature)} would have ${breached.postEntryCount} structure(s), exceeding limit ${maxSameThesisEntries} (owned ${ownedCount}, entry ${entryQuantity})`,
            breached.gateEvaluation
        )
    }

    return allowWithGateEvaluations(gateEvaluations.map((evaluation) => evaluation.gateEvaluation))
}

function maxAggregateRiskPercentValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    state: AccountState,
    positions: Position[]
) {
    const policy = alpacaOptionsPolicySchema.parse(rawPolicy)
    if (policy.maxAggregateRiskPercent === undefined) {
        return { allowed: true }
    }

    if (getIntentAction(intent) !== "entry") {
        return { allowed: true }
    }

    const sliceEquity = readFiniteNumber(state.equity)
    if (sliceEquity === undefined || sliceEquity <= 0) {
        return {
            allowed: false,
            reason: "Unable to evaluate Alpaca aggregate option risk without positive strategy slice equity",
        }
    }

    const entryMaxLoss = estimateStructureMaxLoss(intent)
    if (entryMaxLoss === null) {
        return {
            allowed: false,
            reason: "Unable to determine max loss for Alpaca options entry",
        }
    }

    const owned = resolveOwnedOptionStructuresForRisk(positions)
    if (owned.unevaluablePositions.length > 0) {
        return {
            allowed: false,
            reason: `Unable to evaluate owned Alpaca option max loss for ${owned.unevaluablePositions.join(", ")}`,
        }
    }

    const ownedMaxLoss = [...owned.structures, ...owned.riskOnlyStructures]
        .reduce((sum, structure) => sum + structure.maxLoss, 0)
    const aggregateMaxLoss = ownedMaxLoss + entryMaxLoss
    const aggregateRiskPercent = (aggregateMaxLoss / sliceEquity) * 100
    const gateEvaluation = createGateEvaluation({
        gateKey: "alpacaOptions.maxAggregateRiskPercent",
        observed: aggregateRiskPercent,
        threshold: policy.maxAggregateRiskPercent,
        comparison: "max",
    })

    if (aggregateRiskPercent > policy.maxAggregateRiskPercent + RISK_GATE_EPSILON) {
        return rejectRiskWithGateEvaluation(
            `Aggregate Alpaca options max loss ${formatCurrency(aggregateMaxLoss)} (${formatPercent(aggregateRiskPercent)} of strategy slice equity ${formatCurrency(sliceEquity)}) exceeds limit ${formatPercent(policy.maxAggregateRiskPercent)}; owned ${formatCurrency(ownedMaxLoss)}, entry ${formatCurrency(entryMaxLoss)}`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
}

function minCreditEntryValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    _positions: Position[]
) {
    const policy = alpacaOptionsPolicySchema.parse(rawPolicy)
    if (
        policy.minCreditToWidthPercent === undefined &&
        policy.minCreditToSpreadRatio === undefined &&
        policy.minCreditPerContract === undefined
    ) {
        return { allowed: true }
    }

    const structure = resolveEntryCreditStructure(intent)
    if (!structure) {
        return { allowed: true }
    }

    const netCredit = readFiniteNumber(intent.limitPrice)
    if (netCredit === undefined || netCredit <= 0) {
        return {
            allowed: false,
            reason: "Alpaca minimum credit gate requires a positive net credit limit price",
        }
    }

    const gateEvaluations: GateEvaluation[] = []

    if (policy.minCreditPerContract !== undefined) {
        const gateEvaluation = createGateEvaluation({
            gateKey: "alpacaOptions.minCreditPerContract",
            observed: netCredit,
            threshold: policy.minCreditPerContract,
            comparison: "min",
            tolerance: CREDIT_GATE_EPSILON,
        })
        gateEvaluations.push(gateEvaluation)

        if (netCredit + CREDIT_GATE_EPSILON < policy.minCreditPerContract) {
            return rejectRiskWithGateEvaluations(
                `Alpaca entry credit per contract ${formatCurrency(netCredit)} is below policy floor ${formatCurrency(policy.minCreditPerContract)}`,
                gateEvaluations
            )
        }
    }

    if (policy.minCreditToWidthPercent !== undefined) {
        const narrowestWidth = Math.min(...structure.sideSpreadWidths)
        const creditToWidthPercent = (netCredit / narrowestWidth) * 100
        const gateEvaluation = createGateEvaluation({
            gateKey: "alpacaOptions.minCreditToWidthPercent",
            observed: creditToWidthPercent,
            threshold: policy.minCreditToWidthPercent,
            comparison: "min",
            tolerance: CREDIT_GATE_EPSILON,
        })
        gateEvaluations.push(gateEvaluation)

        if (creditToWidthPercent + CREDIT_GATE_EPSILON < policy.minCreditToWidthPercent) {
            return rejectRiskWithGateEvaluations(
                `Alpaca entry credit-to-width ${formatPercent(creditToWidthPercent)} is below policy floor ${formatPercent(policy.minCreditToWidthPercent)} (credit ${formatNumber(netCredit)}, width ${formatNumber(narrowestWidth)})`,
                gateEvaluations
            )
        }
    }

    if (policy.minCreditToSpreadRatio !== undefined) {
        const structureSpread = resolveMetadataStructureSpread(intent, structure)
        if (structureSpread.status === "incomplete") {
            return {
                allowed: false,
                reason: `Alpaca entry credit-to-spread gate requires complete bid/ask metadata for every structure leg; missing ${structureSpread.missingSymbols.join(", ")}`,
            }
        }

        if (structureSpread.status === "complete" && structureSpread.value > 0) {
            const creditToSpreadRatio = netCredit / structureSpread.value
            const gateEvaluation = createGateEvaluation({
                gateKey: "alpacaOptions.minCreditToSpreadRatio",
                observed: creditToSpreadRatio,
                threshold: policy.minCreditToSpreadRatio,
                comparison: "min",
                tolerance: CREDIT_GATE_EPSILON,
            })
            gateEvaluations.push(gateEvaluation)

            if (creditToSpreadRatio + CREDIT_GATE_EPSILON < policy.minCreditToSpreadRatio) {
                return rejectRiskWithGateEvaluations(
                    `Alpaca entry credit-to-spread ${formatRatio(creditToSpreadRatio)} is below policy floor ${formatRatio(policy.minCreditToSpreadRatio)} (credit ${formatNumber(netCredit)}, live structure spread ${formatNumber(structureSpread.value)})`,
                    gateEvaluations
                )
            }
        }
    }

    return allowWithGateEvaluations(gateEvaluations)
}

function shortStrikeDeltaCeilingValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    _positions: Position[]
) {
    const policy = alpacaOptionsPolicySchema.parse(rawPolicy)
    if (policy.shortStrikeDeltaCeiling === undefined) {
        return { allowed: true }
    }

    const resolution = resolveClaimedShortStrikeDeltas(intent)
    if (resolution.status === "not_applicable") {
        return { allowed: true }
    }

    if (resolution.status === "unresolvable") {
        return {
            allowed: false,
            reason: `Alpaca short-strike delta ceiling cannot identify the short legs of this entry: ${resolution.reason}`,
        }
    }

    if (resolution.status === "missing") {
        return {
            allowed: false,
            reason: `Alpaca short-strike delta ceiling ${formatNumber(policy.shortStrikeDeltaCeiling)} requires the verified short-strike delta on the proposal; supply ${resolution.missingFields.join(", ")} for ${resolution.symbols.join(", ")}`,
        }
    }

    const worstClaim = resolution.claims.reduce((worst, claim) =>
        Math.abs(claim.claimedDelta) > Math.abs(worst.claimedDelta) ? claim : worst
    )
    const observedDelta = Math.abs(worstClaim.claimedDelta)
    const gateEvaluation = createGateEvaluation({
        gateKey: "alpacaOptions.shortStrikeDeltaCeiling",
        observed: observedDelta,
        threshold: policy.shortStrikeDeltaCeiling,
        comparison: "max",
        tolerance: RISK_GATE_EPSILON,
    })

    if (observedDelta > policy.shortStrikeDeltaCeiling + RISK_GATE_EPSILON) {
        return rejectRiskWithGateEvaluation(
            `Alpaca entry short-strike delta ${formatNumber(observedDelta)} on ${worstClaim.symbol} (${worstClaim.field}) exceeds policy ceiling ${formatNumber(policy.shortStrikeDeltaCeiling)}`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
}

export function resolveClaimedShortStrikeDeltas(intent: OrderIntent): ShortStrikeDeltaResolution {
    const structure = resolveEntryCreditStructure(intent)
    if (!structure) {
        return { status: "not_applicable" }
    }

    const requirements = resolveShortStrikeDeltaRequirements(structure)
    if (!requirements) {
        return {
            status: "unresolvable",
            reason: `${structure.structureType} legs do not expose the expected short strikes`,
        }
    }

    const claims: ShortStrikeDeltaClaim[] = []
    const missingFields: ShortStrikeDeltaField[] = []

    for (const requirement of requirements) {
        const claimedDelta = readFiniteNumber(intent.metadata?.[requirement.field])
        if (claimedDelta === undefined) {
            missingFields.push(requirement.field)
            continue
        }

        claims.push({ ...requirement, claimedDelta })
    }

    if (missingFields.length > 0) {
        return {
            status: "missing",
            missingFields,
            symbols: requirements.map((requirement) => requirement.symbol),
        }
    }

    return { status: "claimed", claims }
}

function resolveShortStrikeDeltaRequirements(
    structure: ResolvedStructure
): ShortStrikeDeltaRequirement[] | null {
    const shortLegs = structure.legs.filter((leg) => leg.exposure === "short")

    if (structure.structureType === "iron_condor") {
        const shortCall = shortLegs.find((leg) => leg.optionType === "call")
        const shortPut = shortLegs.find((leg) => leg.optionType === "put")
        if (shortLegs.length !== 2 || !shortCall || !shortPut) {
            return null
        }

        const [callField, putField] = SHORT_STRIKE_DELTA_FIELDS.iron_condor
        return [
            { field: callField, symbol: normalizeOptionSymbol(shortCall.instrument) },
            { field: putField, symbol: normalizeOptionSymbol(shortPut.instrument) },
        ]
    }

    if (shortLegs.length !== 1) {
        return null
    }

    const [singleField] = SHORT_STRIKE_DELTA_FIELDS.credit_vertical
    return [{ field: singleField, symbol: normalizeOptionSymbol(shortLegs[0]!.instrument) }]
}

function normalizeOptionSymbol(instrument: string): string {
    return instrument.trim().toUpperCase()
}

function expiryValidationValidator(intent: OrderIntent) {
    const expirations = getIntentExpirations(intent)

    if (expirations.length === 0) {
        return {
            allowed: false,
            reason: "Unable to determine option expiration for Alpaca multi-leg order",
        }
    }

    const uniqueExpirations = new Set(expirations)
    if (uniqueExpirations.size !== 1) {
        return {
            allowed: false,
            reason: "All legs in an Alpaca options structure must share the same expiration",
        }
    }

    const expectedExpiration = intent.metadata?.expectedExpiration
    if (typeof expectedExpiration === "string" && !uniqueExpirations.has(expectedExpiration)) {
        return {
            allowed: false,
            reason: `Order expiration ${expirations[0]} does not match expected expiration ${expectedExpiration}`,
        }
    }

    const targetDaysToExpiry = intent.metadata?.targetDaysToExpiry
    if (typeof targetDaysToExpiry === "number") {
        const actualDays = diffDays(expirations[0] ?? "")
        if (actualDays === null || actualDays !== targetDaysToExpiry) {
            return {
                allowed: false,
                reason: `Order expiration is ${actualDays ?? "unknown"} DTE but strategy expects ${targetDaysToExpiry} DTE`,
            }
        }
    }

    return { allowed: true }
}

function getIntentExpirations(intent: OrderIntent): string[] {
    if (!intent.legs || intent.legs.length === 0) {
        return []
    }

    return intent.legs
        .map((leg) => parseOptionContractSymbol(leg.instrument)?.expiration)
        .filter((value): value is string => Boolean(value))
}

function calculateStructureWidth(intent: OrderIntent): number | null {
    const normalizedLegs = normalizeOptionLegs(intent)

    if (!Array.isArray(normalizedLegs) || normalizedLegs.length < 2) {
        const metadataWidth = intent.metadata?.spreadWidth
        return typeof metadataWidth === "number" ? metadataWidth : null
    }

    return calculateNormalizedStructureWidth(normalizedLegs)
}

function estimateStructureMaxLoss(intent: OrderIntent): number | null {
    const width = calculateStructureWidth(intent)
    if (width === null) {
        const explicitMaxLoss = intent.metadata?.maxLoss
        return typeof explicitMaxLoss === "number" ? explicitMaxLoss : null
    }

    const quantity = readFiniteNumber(intent.quantity)
    const netPrice = readFiniteNumber(intent.limitPrice) ?? 0
    if (quantity === undefined || quantity <= 0 || netPrice < 0) {
        return null
    }

    return estimateMaxLossFromWidthAndPrice({
        width,
        netPrice,
        quantity,
        side: intent.side,
    })
}

function estimateMaxLossFromWidthAndPrice(args: {
    width: number
    netPrice: number
    quantity: number
    side: OrderIntent["side"]
}): number | null {
    if (
        !Number.isFinite(args.width) ||
        !Number.isFinite(args.netPrice) ||
        !Number.isFinite(args.quantity) ||
        args.width <= 0 ||
        args.netPrice < 0 ||
        args.quantity <= 0
    ) {
        return null
    }

    if (args.side === "buy") {
        return args.netPrice * OPTION_CONTRACT_MULTIPLIER * args.quantity
    }

    const grossRisk = args.width * OPTION_CONTRACT_MULTIPLIER * args.quantity
    const creditOffset = args.netPrice * OPTION_CONTRACT_MULTIPLIER * args.quantity

    return Math.max(grossRisk - creditOffset, 0)
}

function resolveEntryStructure(intent: OrderIntent): ResolvedStructure | null {
    const normalizedLegs = normalizeOptionLegs(intent)
    if (!Array.isArray(normalizedLegs)) {
        return null
    }

    if (normalizedLegs.some((leg) => leg.positionEffect !== "open")) {
        return null
    }

    return resolveStructureFromNormalizedLegs(normalizedLegs)
}

function resolveOwnedOptionStructuresForRisk(positions: Position[]): OwnedOptionStructureResolution {
    const structures: OwnedOptionStructureRisk[] = []
    const riskOnlyStructures: OwnedStructureRiskOnly[] = []
    const unevaluablePositions: string[] = []
    const consumedIndexes = new Set<number>()
    const consumedCanonicalInstruments = new Set<string>()

    positions.forEach((position, index) => {
        const normalizedInstrument = position.instrument.trim().toUpperCase()
        if (!normalizedInstrument.startsWith("IC:") && !normalizedInstrument.startsWith("VS:")) {
            return
        }

        consumedIndexes.add(index)
        const claim = parseClaimedStructureInstrument(normalizedInstrument)
        const resolved = claim ? buildOwnedStructureRiskFromClaimedPosition(position, claim) : null
        if (resolved) {
            structures.push(resolved)
            consumedCanonicalInstruments.add(normalizedInstrument)
            return
        }

        const riskOnly = resolveOwnedStructureRiskFromMetadataWidth(position)
        if (riskOnly) {
            riskOnlyStructures.push(riskOnly)
            consumedCanonicalInstruments.add(normalizedInstrument)
            return
        }

        unevaluablePositions.push(position.instrument)
    })

    const claimGroups = new Map<string, Array<{ position: Position; index: number }>>()
    positions.forEach((position, index) => {
        if (consumedIndexes.has(index)) {
            return
        }

        const claimInstrument = readOwnedClaimInstrument(position)
        if (!claimInstrument) {
            return
        }

        const normalizedClaimInstrument = claimInstrument.trim().toUpperCase()
        if (consumedCanonicalInstruments.has(normalizedClaimInstrument)) {
            consumedIndexes.add(index)
            return
        }

        if (!parseClaimedStructureInstrument(normalizedClaimInstrument)) {
            return
        }

        const group = claimGroups.get(normalizedClaimInstrument) ?? []
        group.push({ position, index })
        claimGroups.set(normalizedClaimInstrument, group)
    })

    for (const [claimInstrument, entries] of claimGroups) {
        const claim = parseClaimedStructureInstrument(claimInstrument)
        const resolved = claim
            ? buildOwnedStructureRiskFromClaimGroup(claim, entries.map((entry) => entry.position))
            : null

        if (!resolved) {
            continue
        }

        structures.push(resolved)
        for (const entry of entries) {
            consumedIndexes.add(entry.index)
        }
    }

    const remainingLegPositions = positions.filter((position, index) =>
        !consumedIndexes.has(index) && Boolean(parseOptionContractSymbol(position.instrument))
    )
    const derived = deriveAlpacaOptionLegStructures(remainingLegPositions)

    for (const group of derived.groups) {
        const resolved = buildOwnedStructureRiskFromLegs(group.structure, group.positions)
        if (resolved) {
            structures.push(resolved)
        } else {
            unevaluablePositions.push(...group.positions.map((position) => position.instrument))
        }
    }

    return {
        structures,
        riskOnlyStructures,
        unevaluablePositions: [
            ...unevaluablePositions,
            ...derived.ungrouped.map((position) => position.instrument),
        ],
    }
}

export function deriveAlpacaOptionLegStructures<TPosition extends AlpacaOptionLegPositionLike>(
    positions: readonly TPosition[]
): AlpacaOptionLegStructureGroups<TPosition> {
    const buckets = new Map<string, TPosition[]>()
    const unparsedPositions: TPosition[] = []

    for (const position of positions) {
        const parsed = parseOptionContractSymbol(position.instrument)
        if (!parsed) {
            unparsedPositions.push(position)
            continue
        }

        const bucketKey = `${parsed.underlying}:${parsed.expiration}`
        const bucket = buckets.get(bucketKey) ?? []
        bucket.push(position)
        buckets.set(bucketKey, bucket)
    }

    const groups: AlpacaOptionLegStructureGroups<TPosition>["groups"] = []
    const ungrouped: TPosition[] = []

    for (const bucket of buckets.values()) {
        let unused = [...bucket]

        if (unused.length === 4) {
            const structure = resolveStructureFromLegPositions(unused)
            if (structure?.structureType === "iron_condor") {
                groups.push({ structure, positions: unused })
                unused = []
            }
        }

        while (unused.length >= 2) {
            const vertical = findVerticalLegPositionGroup(unused)
            if (!vertical) {
                break
            }

            groups.push(vertical)
            unused = unused.filter((position) => !vertical.positions.includes(position))
        }

        ungrouped.push(...unused)
    }

    return {
        groups,
        ungrouped: [...ungrouped, ...unparsedPositions],
    }
}

function findVerticalLegPositionGroup<TPosition extends AlpacaOptionLegPositionLike>(
    positions: readonly TPosition[]
): { structure: ResolvedStructure; positions: TPosition[] } | null {
    for (let leftIndex = 0; leftIndex < positions.length - 1; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < positions.length; rightIndex++) {
            const candidate = [positions[leftIndex]!, positions[rightIndex]!]
            const structure = resolveStructureFromLegPositions(candidate)
            if (structure?.structureType === "credit_vertical") {
                return { structure, positions: candidate }
            }
        }
    }

    return null
}

function resolveStructureFromLegPositions<TPosition extends AlpacaOptionLegPositionLike>(
    positions: readonly TPosition[]
): ResolvedStructure | null {
    if (!SUPPORTED_LEG_COUNTS.has(positions.length)) {
        return null
    }

    const legs: NormalizedOptionLeg[] = []
    for (const position of positions) {
        const instrument = position.instrument.trim().toUpperCase()
        const parsed = parseOptionContractSymbol(instrument)
        if (!parsed) {
            return null
        }

        legs.push(toNormalizedClaimLeg({ ...parsed, instrument }, position.side))
    }

    const first = legs[0]!
    const sharedContract = legs.every((leg) =>
        leg.underlying === first.underlying && leg.expiration === first.expiration
    )

    return sharedContract ? resolveStructureFromNormalizedLegs(legs) : null
}

function resolveOwnedStructureRiskFromMetadataWidth(position: Position): OwnedStructureRiskOnly | null {
    const width = readFiniteNumber(position.metadata?.spreadWidth)
    const quantity = readPositiveIntegerQuantity(position.quantity)
    const entryPrice = readNonNegativeFiniteNumber(position.entryPrice)
    if (width === undefined || width <= 0 || quantity === null || entryPrice === null) {
        return null
    }

    const maxLoss = estimateMaxLossFromWidthAndPrice({
        width,
        netPrice: entryPrice,
        quantity,
        side: position.side === "long" ? "buy" : "sell",
    })

    return maxLoss === null
        ? null
        : {
            instrument: position.instrument,
            maxLoss,
        }
}

function buildOwnedStructureRiskFromClaimedPosition(
    position: Position,
    claim: NonNullable<ReturnType<typeof parseClaimedStructureInstrument>>
): OwnedOptionStructureRisk | null {
    const structure = resolveStructureFromClaim(claim)
    const quantity = readPositiveIntegerQuantity(position.quantity)
    const entryPrice = readNonNegativeFiniteNumber(position.entryPrice)

    if (!structure || quantity === null || entryPrice === null) {
        return null
    }

    return buildOwnedStructureRisk({
        structure,
        quantity,
        entryPrice,
        side: position.side === "long" ? "buy" : "sell",
    })
}

function buildOwnedStructureRiskFromClaimGroup(
    claim: NonNullable<ReturnType<typeof parseClaimedStructureInstrument>>,
    positions: Position[]
): OwnedOptionStructureRisk | null {
    const structure = resolveStructureFromClaim(claim)
    if (!structure || positions.length !== claim.legs.length) {
        return null
    }

    const normalizedClaimLegs = new Set(claim.legs)
    const positionsByInstrument = new Map(
        positions.map((position) => [position.instrument.trim().toUpperCase(), position])
    )
    if (positionsByInstrument.size !== positions.length) {
        return null
    }

    for (const leg of structure.legs) {
        const position = positionsByInstrument.get(leg.instrument.trim().toUpperCase())
        if (!position || !normalizedClaimLegs.has(leg.instrument.trim().toUpperCase())) {
            return null
        }

        if (position.side !== leg.exposure) {
            return null
        }
    }

    return buildOwnedStructureRiskFromLegs(structure, positions)
}

function buildOwnedStructureRiskFromLegs(
    structure: ResolvedStructure,
    positions: Position[]
): OwnedOptionStructureRisk | null {
    const quantity = readSharedStructureQuantity(positions)
    const entryPrice = calculateNetStructureEntryPrice(positions)
    if (quantity === null || entryPrice === null) {
        return null
    }

    return buildOwnedStructureRisk({
        structure,
        quantity,
        entryPrice,
        side: "sell",
    })
}

function buildOwnedStructureRisk(args: {
    structure: ResolvedStructure
    quantity: number
    entryPrice: number
    side: OrderIntent["side"]
}): OwnedOptionStructureRisk | null {
    const maxLoss = estimateMaxLossFromWidthAndPrice({
        width: args.structure.spreadWidth,
        netPrice: args.entryPrice,
        quantity: args.quantity,
        side: args.side,
    })

    return maxLoss === null
        ? null
        : {
            structure: args.structure,
            quantity: args.quantity,
            maxLoss,
        }
}

function resolveStructureFromClaim(
    claim: NonNullable<ReturnType<typeof parseClaimedStructureInstrument>>
): ResolvedStructure | null {
    const normalizedLegs = resolveNormalizedLegsFromClaim(claim)
    return normalizedLegs ? resolveStructureFromNormalizedLegs(normalizedLegs) : null
}

function resolveNormalizedLegsFromClaim(
    claim: NonNullable<ReturnType<typeof parseClaimedStructureInstrument>>
): NormalizedOptionLeg[] | null {
    const parsedLegs = claim.legs
        .map((instrument) => {
            const parsed = parseOptionContractSymbol(instrument)
            return parsed
                ? {
                    ...parsed,
                    instrument,
                }
                : null
        })
        .filter((leg): leg is ParsedOptionContract & { instrument: string } => Boolean(leg))

    if (
        parsedLegs.length !== claim.legs.length ||
        parsedLegs.some((leg) => leg.underlying !== claim.underlying || leg.expiration !== claim.expiration)
    ) {
        return null
    }

    if (claim.structureType === "credit_vertical") {
        return resolveVerticalClaimLegs(claim, parsedLegs)
    }

    return resolveIronCondorClaimLegs(parsedLegs)
}

function resolveVerticalClaimLegs(
    claim: NonNullable<ReturnType<typeof parseClaimedStructureInstrument>>,
    legs: Array<ParsedOptionContract & { instrument: string }>
): NormalizedOptionLeg[] | null {
    if (!claim.verticalSpreadType || legs.length !== 2) {
        return null
    }

    const expectedOptionType = claim.verticalSpreadType === "bear_call_credit" ? "call" : "put"
    if (legs.some((leg) => leg.optionType !== expectedOptionType)) {
        return null
    }

    const sorted = [...legs].sort((left, right) => left.strike - right.strike)
    const shortLeg = claim.verticalSpreadType === "bear_call_credit" ? sorted[0] : sorted[1]
    const longLeg = claim.verticalSpreadType === "bear_call_credit" ? sorted[1] : sorted[0]

    if (!shortLeg || !longLeg || shortLeg.strike === longLeg.strike) {
        return null
    }

    return [
        toNormalizedClaimLeg(shortLeg, "short"),
        toNormalizedClaimLeg(longLeg, "long"),
    ]
}

function resolveIronCondorClaimLegs(
    legs: Array<ParsedOptionContract & { instrument: string }>
): NormalizedOptionLeg[] | null {
    const calls = legs.filter((leg) => leg.optionType === "call").sort((left, right) => left.strike - right.strike)
    const puts = legs.filter((leg) => leg.optionType === "put").sort((left, right) => left.strike - right.strike)

    if (calls.length !== 2 || puts.length !== 2) {
        return null
    }

    const longPut = puts[0]
    const shortPut = puts[1]
    const shortCall = calls[0]
    const longCall = calls[1]

    if (!longPut || !shortPut || !shortCall || !longCall) {
        return null
    }

    return [
        toNormalizedClaimLeg(longPut, "long"),
        toNormalizedClaimLeg(shortPut, "short"),
        toNormalizedClaimLeg(shortCall, "short"),
        toNormalizedClaimLeg(longCall, "long"),
    ]
}

function toNormalizedClaimLeg(
    leg: ParsedOptionContract & { instrument: string },
    exposure: "long" | "short"
): NormalizedOptionLeg {
    const side = exposure === "short" ? "sell_to_open" : "buy_to_open"

    return {
        ...leg,
        quantity: 1,
        side,
        positionEffect: "open",
        exposure,
    }
}

function readOwnedClaimInstrument(position: Position): string | undefined {
    return readTrimmedString(position.metadata?.alpacaClaimInstrument) ??
        readTrimmedString(position.metadata?.claimInstrument)
}

function readSharedStructureQuantity(positions: Position[]): number | null {
    const quantities = positions.map((position) => readPositiveIntegerQuantity(position.quantity))
    if (quantities.some((quantity) => quantity === null)) {
        return null
    }

    const normalized = quantities as number[]
    const first = normalized[0]
    if (first === undefined || normalized.some((quantity) => quantity !== first)) {
        return null
    }

    return first
}

function readPositiveIntegerQuantity(value: unknown): number | null {
    const quantity = readFiniteNumber(value)
    if (quantity === undefined || quantity <= 0) {
        return null
    }

    const rounded = Math.round(quantity)
    return Math.abs(quantity - rounded) <= RISK_GATE_EPSILON ? rounded : null
}

function readNonNegativeFiniteNumber(value: unknown): number | null {
    const number = readFiniteNumber(value)
    return number !== undefined && number >= 0 ? number : null
}

function calculateNetStructureEntryPrice(positions: Position[]): number | null {
    let netPrice = 0

    for (const position of positions) {
        const entryPrice = readNonNegativeFiniteNumber(position.entryPrice)
        if (entryPrice === null) {
            return null
        }

        netPrice += entryPrice * (position.side === "short" ? -1 : 1)
    }

    return Math.abs(netPrice)
}

function resolveStructureThesisSignatures(structure: ResolvedStructure): StructureThesisSignature[] {
    const thesisStructureType = structure.verticalSpreadType ?? structure.structureType

    return structure.legs
        .filter((leg) => leg.exposure === "short")
        .map((leg) => ({
            underlying: structure.underlying,
            expiration: structure.expiration,
            structureType: thesisStructureType,
            shortStrike: leg.strike,
        }))
}

function countOwnedThesisStructures(structures: OwnedOptionStructureRisk[]): Map<string, number> {
    const counts = new Map<string, number>()

    for (const ownedStructure of structures) {
        for (const signature of resolveStructureThesisSignatures(ownedStructure.structure)) {
            const key = formatThesisSignatureKey(signature)
            counts.set(key, (counts.get(key) ?? 0) + ownedStructure.quantity)
        }
    }

    return counts
}

function formatThesisSignatureKey(signature: StructureThesisSignature): string {
    return [
        signature.underlying.trim().toUpperCase(),
        signature.expiration,
        signature.structureType,
        formatNumber(signature.shortStrike),
    ].join(":")
}

function formatThesisSignature(signature: StructureThesisSignature): string {
    return `${signature.underlying.trim().toUpperCase()} ${signature.expiration} ${signature.structureType} short ${formatNumber(signature.shortStrike)}`
}

function resolveEntryCreditStructure(intent: OrderIntent): ResolvedStructure | null {
    if (getIntentAction(intent) !== "entry" || intent.side !== "sell") {
        return null
    }

    const normalizedLegs = normalizeOptionLegs(intent)
    if (!Array.isArray(normalizedLegs)) {
        return null
    }

    if (normalizedLegs.some((leg) => leg.positionEffect !== "open")) {
        return null
    }

    return resolveStructureFromNormalizedLegs(normalizedLegs)
}

function diffDays(expiration: string): number | null {
    const expirationAt = new Date(`${expiration}T00:00:00Z`)
    if (Number.isNaN(expirationAt.getTime())) {
        return null
    }

    const difference = expirationAt.getTime() - Date.now()
    return Math.round(difference / 86_400_000)
}

function normalizeOptionLegs(intent: OrderIntent): NormalizedOptionLeg[] | { allowed: false; reason: string } {
    const action = getIntentAction(intent)
    const normalizedLegs: NormalizedOptionLeg[] = []

    for (const leg of intent.legs ?? []) {
        const parsed = parseOptionContractSymbol(leg.instrument)
        if (!parsed) {
            return {
                allowed: false,
                reason: `Invalid OCC option symbol: ${leg.instrument}`,
            }
        }

        const normalizedSide = normalizeLegSide(leg.side, action)
        if (!normalizedSide) {
            return {
                allowed: false,
                reason: `Unsupported Alpaca leg side ${leg.side} for ${action} orders`,
            }
        }

        normalizedLegs.push({
            ...parsed,
            instrument: leg.instrument,
            quantity: leg.quantity,
            side: normalizedSide,
            positionEffect: normalizedSide.endsWith("_close") ? "close" : "open",
            exposure: resolveExposureFromSide(normalizedSide),
        })
    }

    return normalizedLegs
}

function normalizeLegSide(
    side: OrderLegSide,
    action: ReturnType<typeof getIntentAction>
): OrderLegSide | null {
    if (
        side === "buy_to_open" ||
        side === "sell_to_open" ||
        side === "buy_to_close" ||
        side === "sell_to_close"
    ) {
        return side
    }

    if (side === "buy") {
        return action === "close" ? "buy_to_close" : "buy_to_open"
    }

    if (side === "sell") {
        return action === "close" ? "sell_to_close" : "sell_to_open"
    }

    return null
}

function resolveExposureFromSide(side: OrderLegSide): "long" | "short" {
    if (side === "sell_to_open" || side === "buy_to_close") {
        return "short"
    }
    return "long"
}

function hasSupportedLegRatios(intent: OrderIntent, legs: NormalizedOptionLeg[]): boolean {
    return legs.every((leg) => Number.isInteger(leg.quantity) && (leg.quantity === 1 || leg.quantity === intent.quantity))
}

function resolveStructureFromNormalizedLegs(legs: NormalizedOptionLeg[]): ResolvedStructure | null {
    if (legs.length === 4) {
        return resolveIronCondorStructure(legs)
    }

    if (legs.length === 2) {
        return resolveCreditVerticalStructure(legs)
    }

    return null
}

function resolveIronCondorStructure(legs: NormalizedOptionLeg[]): ResolvedStructure | null {
    const calls = legs.filter((leg) => leg.optionType === "call")
    const puts = legs.filter((leg) => leg.optionType === "put")
    const shorts = legs.filter((leg) => leg.exposure === "short")
    const longs = legs.filter((leg) => leg.exposure === "long")

    if (calls.length !== 2 || puts.length !== 2 || shorts.length !== 2 || longs.length !== 2) {
        return null
    }

    const shortCall = calls.find((leg) => leg.exposure === "short")
    const longCall = calls.find((leg) => leg.exposure === "long")
    const shortPut = puts.find((leg) => leg.exposure === "short")
    const longPut = puts.find((leg) => leg.exposure === "long")

    if (!shortCall || !longCall || !shortPut || !longPut) {
        return null
    }

    const validGeometry = (
        longPut.strike < shortPut.strike &&
        shortPut.strike < shortCall.strike &&
        shortCall.strike < longCall.strike
    )

    if (!validGeometry) {
        return null
    }

    const putSpreadWidth = shortPut.strike - longPut.strike
    const callSpreadWidth = longCall.strike - shortCall.strike
    const sideSpreadWidths = [putSpreadWidth, callSpreadWidth]
    const spreadWidth = calculateSpreadWidthFromSides(sideSpreadWidths)
    if (spreadWidth === null) {
        return null
    }

    return {
        structureType: "iron_condor",
        underlying: legs[0]!.underlying,
        expiration: legs[0]!.expiration,
        spreadWidth,
        sideSpreadWidths,
        legs,
    }
}

function resolveCreditVerticalStructure(legs: NormalizedOptionLeg[]): ResolvedStructure | null {
    const shorts = legs.filter((leg) => leg.exposure === "short")
    const longs = legs.filter((leg) => leg.exposure === "long")

    if (shorts.length !== 1 || longs.length !== 1) {
        return null
    }

    const shortLeg = shorts[0]!
    const longLeg = longs[0]!
    if (shortLeg.optionType !== longLeg.optionType) {
        return null
    }

    let verticalSpreadType: AlpacaVerticalSpreadType | null = null
    let spreadWidth: number | null = null

    if (shortLeg.optionType === "call") {
        if (shortLeg.strike >= longLeg.strike) {
            return null
        }
        verticalSpreadType = "bear_call_credit"
        spreadWidth = longLeg.strike - shortLeg.strike
    } else {
        if (longLeg.strike >= shortLeg.strike) {
            return null
        }
        verticalSpreadType = "bull_put_credit"
        spreadWidth = shortLeg.strike - longLeg.strike
    }

    if (spreadWidth <= 0) {
        return null
    }

    return {
        structureType: "credit_vertical",
        verticalSpreadType,
        underlying: shortLeg.underlying,
        expiration: shortLeg.expiration,
        spreadWidth,
        sideSpreadWidths: [spreadWidth],
        legs: [shortLeg, longLeg],
    }
}

function calculateSpreadWidthFromSides(sideSpreadWidths: number[]): number | null {
    const positiveWidths = sideSpreadWidths.filter((width) => Number.isFinite(width) && width > 0)
    if (positiveWidths.length === 0) {
        return null
    }

    return Math.max(...positiveWidths)
}

function calculateNormalizedStructureWidth(legs: NormalizedOptionLeg[]): number | null {
    const callStrikes = legs
        .filter((leg) => leg.optionType === "call")
        .map((leg) => leg.strike)
        .sort((left, right) => left - right)
    const putStrikes = legs
        .filter((leg) => leg.optionType === "put")
        .map((leg) => leg.strike)
        .sort((left, right) => left - right)

    const callWidth = callStrikes.length >= 2 ? callStrikes[callStrikes.length - 1]! - callStrikes[0]! : 0
    const putWidth = putStrikes.length >= 2 ? putStrikes[putStrikes.length - 1]! - putStrikes[0]! : 0
    const width = Math.max(callWidth, putWidth)

    return width > 0 ? width : null
}

type MetadataStructureSpread =
    | { status: "absent" }
    | { status: "complete"; value: number }
    | { status: "incomplete"; missingSymbols: string[] }

function resolveMetadataStructureSpread(
    intent: OrderIntent,
    structure: ResolvedStructure
): MetadataStructureSpread {
    const quoteEntries = readMetadataLegQuoteEntries(intent.metadata)
    if (quoteEntries.length === 0) {
        return { status: "absent" }
    }

    const quotesBySymbol = new Map<string, { bid: number; ask: number }>()
    for (const entry of quoteEntries) {
        const symbol = readMetadataQuoteSymbol(entry)
        const bid = readFiniteNumber(entry.bid) ?? readFiniteNumber(entry.bidPrice)
        const ask = readFiniteNumber(entry.ask) ?? readFiniteNumber(entry.askPrice)
        if (!symbol || bid === undefined || ask === undefined || ask < bid) {
            continue
        }

        quotesBySymbol.set(symbol, { bid, ask })
    }

    const missingSymbols: string[] = []
    let structureSpread = 0
    for (const leg of structure.legs) {
        const symbol = leg.instrument.trim().toUpperCase()
        const quote = quotesBySymbol.get(symbol)
        if (!quote) {
            missingSymbols.push(symbol)
            continue
        }

        structureSpread += quote.ask - quote.bid
    }

    if (missingSymbols.length > 0) {
        return { status: "incomplete", missingSymbols }
    }

    return { status: "complete", value: structureSpread }
}

function readMetadataLegQuoteEntries(
    metadata: Record<string, unknown> | undefined
): Record<string, unknown>[] {
    if (!metadata) {
        return []
    }

    const candidates = [
        metadata.legQuotes,
        metadata.legs,
        metadata.optionLegQuotes,
    ]

    for (const candidate of candidates) {
        const entries = readLegQuoteEntries(candidate)
        const quoteEntries = entries.filter(hasMetadataQuoteFields)
        if (quoteEntries.length > 0) {
            return quoteEntries
        }
    }

    return []
}

function readLegQuoteEntries(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
        return value
            .map(readRecord)
            .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    }

    const record = readRecord(value)
    if (!record) {
        return []
    }

    return Object.entries(record)
        .map(([symbol, quote]): Record<string, unknown> | undefined => {
            const quoteRecord = readRecord(quote)
            return quoteRecord
                ? {
                    ...quoteRecord,
                    symbol: readTrimmedString(quoteRecord.symbol) ?? symbol,
                }
                : undefined
        })
        .filter((entry): entry is Record<string, unknown> => entry !== undefined)
}

function readMetadataQuoteSymbol(entry: Record<string, unknown>): string | undefined {
    return (
        readTrimmedString(entry.symbol) ??
        readTrimmedString(entry.instrument)
    )?.toUpperCase()
}

function hasMetadataQuoteFields(entry: Record<string, unknown>): boolean {
    return (
        readFiniteNumber(entry.bid) !== undefined ||
        readFiniteNumber(entry.bidPrice) !== undefined ||
        readFiniteNumber(entry.ask) !== undefined ||
        readFiniteNumber(entry.askPrice) !== undefined
    )
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

function formatPercent(value: number): string {
    return `${formatNumber(value)}%`
}

function formatRatio(value: number): string {
    return `${formatNumber(value)}x`
}

function formatCurrency(value: number): string {
    return `$${formatNumber(value)}`
}

function formatNumber(value: number): string {
    return value.toFixed(4).replace(/\.?0+$/, "")
}
