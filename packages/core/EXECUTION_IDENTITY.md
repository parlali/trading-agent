# Execution Identity Contract

Submit attempts are caller-supplied and deterministic.

The execution pipeline creates the canonical order id from venue, strategy id, run id, role, instrument, normalized intent, and logical order sequence. The `submitAttemptSequence` is intentionally excluded from the canonical order hash and only changes `submitAttemptId`.

Production code must not silently re-submit the same logical order with the same `submitAttemptSequence`. A same-pipeline reuse of a submit attempt id fails closed with `SUBMIT_ATTEMPT_SEQUENCE_REUSED`.

Use a higher explicit `submitAttemptSequence` only after the execution pipeline can read a prior canonical order snapshot whose status is provider-terminal (`filled`, `rejected`, `cancelled`, or `expired`) and whose commit outcome is not `commit_unknown`. If no prior snapshot exists, if the prior order is still pending or partially filled, or if the prior attempt is unresolved `commit_unknown`, the pipeline fails closed before calling the venue. Production agent tool schemas do not expose `submitAttemptSequence`; audited callers that set it must also preserve the same logical order sequence.
