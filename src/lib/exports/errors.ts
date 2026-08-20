/**
 * A render failure with a user-facing message and a stable machine code.
 *
 * `terminal` marks a failure that a retry cannot fix — the same job, run again, would fail the
 * same way. The worker fails those outright instead of burning the remaining attempts
 * (guide §15 step 6 retries transient failures only).
 */
export class ExportFailureError extends Error {
  code: string;
  userMessage: string;
  terminal: boolean;

  constructor(
    code: string,
    userMessage: string,
    options?: { cause?: unknown; terminal?: boolean },
  ) {
    super(userMessage);
    this.name = "ExportFailureError";
    this.code = code;
    this.userMessage = userMessage;
    this.terminal = options?.terminal ?? false;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}
