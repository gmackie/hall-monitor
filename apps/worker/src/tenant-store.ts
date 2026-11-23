import type { Env } from "./env.ts";

/** The tenant's own Durable Object: idempotency records, receipts and evaluation records. */
export function storeFor(env: Pick<Env, "IDEMPOTENCY_STORE">, tenant: string) {
  return env.IDEMPOTENCY_STORE.get(env.IDEMPOTENCY_STORE.idFromName(`tenant:${tenant}`));
}
