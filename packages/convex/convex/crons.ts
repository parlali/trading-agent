import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

crons.interval(
    "prune expired strategy operational memories",
    { hours: 1 },
    internal.mutations.pruneExpiredStrategyOperationalMemories,
    {}
)

export default crons
