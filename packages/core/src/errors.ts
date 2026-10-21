import type { ErrorBody, ErrorCode } from "@gmacko/hall-monitor-contracts";

/** An evaluation failure with its wire error body. The message never quotes request content. */
export class HallMonitorError extends Error {
  override readonly name = "HallMonitorError";
  /** The wire form of this error. */
  readonly body: ErrorBody;

  /** Creates an error with a wire code, a content-free message and whether a retry may succeed. */
  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.body = { code, message, retryable };
  }
}
