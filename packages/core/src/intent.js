export const getIntentAction = (intent, fallback = "entry") => {
    const action = intent.metadata?.action;
    if (action === "entry" || action === "adjustment" || action === "close" || action === "modify" || action === "cancel") {
        return action;
    }
    if (action === "close_position") {
        return "close";
    }
    if (action === "modify_order") {
        return "modify";
    }
    if (action === "cancel_order") {
        return "cancel";
    }
    return fallback;
};
export const hasIntentChanges = (changes) => {
    return Object.values(changes).some((value) => value !== undefined);
};
export const createSyntheticIntent = (action, instrument, side, quantity, orderId, metadata) => {
    return {
        instrument,
        side,
        quantity,
        orderType: "market",
        timeInForce: "day",
        metadata: {
            action,
            orderId,
            ...metadata,
        },
    };
};
