import type { OrderIntent } from "./types"
import type { Logger } from "./logger"
import type { VenueAdapter } from "./execution-contracts"
import { isRiskReducingIntent } from "./risk-intents"
import {
    finalizePriceVerification,
    resolveIntentProposedPrice,
    type PriceVerification,
    type PriceVerifier,
    type ResolvedPriceVerificationConfig,
} from "./price-verification"
import { getErrorMessage } from "./utils"

interface RunExecutionPriceVerificationArgs {
    venue: VenueAdapter
    venueName: string
    config: ResolvedPriceVerificationConfig
    logger: Logger
    intent: OrderIntent
}

export async function runExecutionPriceVerification(
    args: RunExecutionPriceVerificationArgs
): Promise<PriceVerification | undefined> {
    if (!hasPriceVerifier(args.venue)) {
        return undefined
    }

    try {
        const verification = finalizePriceVerification(
            await args.venue.verify(args.intent),
            args.config,
            { riskReducing: isRiskReducingIntent(args.intent) }
        )

        logPriceVerification(args.intent, verification, args.venueName, args.logger)
        return verification
    } catch (error) {
        const message = getErrorMessage(error)
        if (args.config.failClosedOnVerificationError) {
            const verification = finalizePriceVerification({
                ok: false,
                status: "block",
                livePrices: {},
                proposedPrice: resolveIntentProposedPrice(args.intent),
                message: `Price verification failed closed: ${message}`,
                details: {
                    venue: args.venueName,
                    verificationError: message,
                },
            }, args.config, { riskReducing: isRiskReducingIntent(args.intent) })

            args.logger.warn("Price verification failed closed", {
                venue: args.venueName,
                intent: args.intent,
                error: message,
            })

            return verification
        }

        const verification = finalizePriceVerification({
            ok: true,
            status: "warn",
            livePrices: {},
            proposedPrice: resolveIntentProposedPrice(args.intent),
            message: `Price verification unavailable: ${message}. Submitted without broker snapshot.`,
            details: {
                venue: args.venueName,
                verificationError: message,
            },
        }, args.config, { riskReducing: isRiskReducingIntent(args.intent) })

        args.logger.warn("Price verification failed", {
            venue: args.venueName,
            intent: args.intent,
            error: message,
        })

        return verification
    }
}

function logPriceVerification(
    intent: OrderIntent,
    verification: PriceVerification,
    venueName: string,
    logger: Logger
): void {
    if (verification.status === "block") {
        logger.warn("Price verification blocked submission", {
            venue: venueName,
            intent,
            priceVerification: verification,
        })
        return
    }

    if (verification.status === "warn") {
        logger.warn("Price verification warning", {
            venue: venueName,
            intent,
            priceVerification: verification,
        })
        return
    }

    if (verification.status === "skipped") {
        logger.info("Price verification skipped", {
            venue: venueName,
            intent,
            priceVerification: verification,
        })
        return
    }

    logger.info("Price verification passed", {
        venue: venueName,
        intent,
        priceVerification: verification,
    })
}

function hasPriceVerifier(venue: VenueAdapter): venue is VenueAdapter & PriceVerifier {
    return typeof (venue as Partial<PriceVerifier>).verify === "function"
}
