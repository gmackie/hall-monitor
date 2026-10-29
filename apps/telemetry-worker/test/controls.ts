// Test-only controls shared by the test and the aggregate object it drives (same isolate).
export const controls = {
  /** Offsets the object's clock, to age state without waiting. */
  clockOffsetMs: 0,
  /** Every alarm time the object asked for (already translated to the runtime clock), oldest first. */
  armed: [] as number[],
  /** Throws inside the ingest transaction, after every write, to prove atomic rollback. */
  failIngest: false,
  reset(): void {
    this.clockOffsetMs = 0;
    this.failIngest = false;
    this.armed = [];
  },
};
