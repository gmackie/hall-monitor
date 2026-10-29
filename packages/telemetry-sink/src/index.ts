import {
  MAX_CLOCK_SKEW_SECONDS,
  MAX_TELEMETRY_ACK_BYTES,
  MAX_TELEMETRY_BODY_BYTES,
  MAX_TELEMETRY_V2_BODY_BYTES,
  SIGNATURE_HEADER,
  TELEMETRY_PATH,
  TELEMETRY_V2_ACK_DOMAIN,
  TELEMETRY_V2_PATH,
  TELEMETRY_V2_REQUEST_DOMAIN,
  TENANT_HEADER,
  TIME_HEADER,
  parseTelemetryAckV2,
  parseTelemetryBatch,
  parseTelemetryDeliveryV2,
  sha256Hex,
  type TelemetryAckStatus,
  type TelemetryAckV2,
  type TelemetryBatch,
  type TelemetryDeliveryV2,
} from "@gmacko/hall-monitor-telemetry-contracts";

export interface TelemetryBinding {
  fetch(request: Request): Promise<Response>;
}

const encoder = new TextEncoder();
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;

async function hmacKey(secret: string) {
  if (secret.length < 32 || secret.length > 512 || /[^\x21-\x7E]/.test(secret)) {
    throw new TypeError("invalid telemetry signing key");
  }
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function signedInputFor(domain: string, tenant: string, timestamp: number, json: string): Uint8Array {
  return encoder.encode(domain + "\n" + tenant + "\n" + timestamp + "\n" + json);
}

function signedInput(tenant: string, timestamp: number, json: string): Uint8Array {
  return signedInputFor("hall-monitor-telemetry-v1", tenant, timestamp, json);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesOfHex(input: string): Uint8Array {
  return Uint8Array.from(input.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/**
 * Creates a request signed for this tenant and its approved secret.
 * It contains only the fixed event envelope, never the student or message identifiers.
 */
export async function signedTelemetryRequest(
  tenant: string,
  secret: string,
  rawBatch: unknown,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<Request> {
  if (!TENANT_ID.test(tenant) || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError("invalid telemetry sender");
  }
  const batch = parseTelemetryBatch(rawBatch);
  const json = JSON.stringify(batch);
  if (encoder.encode(json).byteLength > MAX_TELEMETRY_BODY_BYTES) {
    throw new TypeError("telemetry body exceeds limit");
  }
  const key = await hmacKey(secret);
  const signature = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, signedInput(tenant, timestamp, json))));
  return new Request("https://telemetry.internal" + TELEMETRY_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      [TENANT_HEADER]: tenant,
      [TIME_HEADER]: String(timestamp),
      [SIGNATURE_HEADER]: signature,
    },
    body: json,
  });
}

/**
 * Stream with a hard byte ceiling rather than allocating the entire body first.
 * An internal, compromised or accidentally public producer cannot force
 * unbounded request buffering even when Content-Length is absent.
 */
async function boundedRequestBytes(request: Pick<Request, "body">, maxBytes: number): Promise<Uint8Array> {
  if (request.body === null) throw new TypeError("missing telemetry body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TypeError("telemetry body size exceeded");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new TypeError("missing telemetry body");
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** A verified batch. Note that replay deduplication belongs to T2's exact ingress ledger. */
export interface VerifiedTelemetry {
  readonly tenant: string;
  readonly batch: TelemetryBatch;
}

/**
 * Verify identity before parsing JSON. A fixed path, timestamp, tenant and raw JSON
 * bytes are authenticated by an HMAC. Verification failure never returns a message body.
 */
export async function verifyTelemetryRequest(
  request: Request,
  secret: string,
  now = Date.now(),
): Promise<VerifiedTelemetry> {
  const { tenant, text } = await verifySignedBody(request, secret, now, TELEMETRY_PATH, "hall-monitor-telemetry-v1", MAX_TELEMETRY_BODY_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("invalid telemetry JSON"); }
  return { tenant, batch: parseTelemetryBatch(parsed) };
}

/**
 * Shared authentication for both protocol versions: route, headers, skew, size, then the HMAC
 * over `domain`, tenant, timestamp and the literal body bytes. Only a verified body is returned.
 */
async function verifySignedBody(
  request: Request,
  secret: string,
  now: number,
  path: string,
  domain: string,
  maxBytes: number,
): Promise<{ readonly tenant: string; readonly text: string }> {
  if (new URL(request.url).pathname !== path || request.method !== "POST") {
    throw new TypeError("invalid telemetry route");
  }
  if (!Number.isFinite(now)) throw new TypeError("invalid receiver clock");
  const tenant = request.headers.get(TENANT_HEADER) ?? "";
  const timeText = request.headers.get(TIME_HEADER) ?? "";
  const signature = request.headers.get(SIGNATURE_HEADER) ?? "";
  if (!TENANT_ID.test(tenant) || !/^\d{10}$/.test(timeText) || !SIGNATURE.test(signature)) {
    throw new TypeError("invalid telemetry authorization");
  }
  const timestamp = Number(timeText);
  if (Math.abs(now / 1000 - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    throw new TypeError("telemetry authorization expired");
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new TypeError("unsupported telemetry content type");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new TypeError("telemetry body size exceeded");
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
    .decode(await boundedRequestBytes(request, maxBytes));
  const key = await hmacKey(secret);
  const verified = await crypto.subtle.verify("HMAC", key, bytesOfHex(signature), signedInputFor(domain, tenant, timestamp, text));
  if (!verified) throw new TypeError("telemetry authentication failed");
  return { tenant, text };
}

/**
 * Best-effort service-binding emitter. It does not retry: T2 must add an exact,
 * deduplicated outbox before any durable count claims can be made.
 *
 * Returns false on an unavailable receiver; callers must preserve moderation responses
 * and log only fixed reason codes, never request payloads or exception messages.
 */
export async function sendTelemetry(
  binding: TelemetryBinding,
  tenant: string,
  secret: string,
  batch: TelemetryBatch,
): Promise<boolean> {
  const request = await signedTelemetryRequest(tenant, secret, batch);
  const response = await binding.fetch(request);
  return response.status === 202;
}

// ---------------------------------------------------------------------------------------------
// v2 durable delivery (HM-20). Distinct path and HMAC domains from v1.
// ---------------------------------------------------------------------------------------------

async function hmacHex(secret: string, input: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(input))));
}

async function verifyHmacHex(secret: string, input: string, signature: string): Promise<boolean> {
  if (!SIGNATURE.test(signature)) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), bytesOfHex(signature), encoder.encode(input));
}

/** A v2 request that passed authentication and strict parsing, with the digest of its exact bytes. */
export interface VerifiedDeliveryV2 {
  readonly tenant: string;
  readonly delivery: TelemetryDeliveryV2;
  /** SHA-256 of the exact received body. The same ID with a different digest is a conflict. */
  readonly digest: string;
}

/**
 * Builds the v2 request for already-built payload bytes. `payload` must be the exact text whose
 * digest is `digest` (a retry re-sends the stored bytes unchanged); only `timestamp` is fresh.
 */
export async function signedDeliveryRequestV2(
  tenant: string,
  secret: string,
  payload: string,
  digest: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<Request> {
  if (!TENANT_ID.test(tenant) || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError("invalid telemetry sender");
  }
  if (encoder.encode(payload).byteLength > MAX_TELEMETRY_V2_BODY_BYTES) throw new TypeError("telemetry body exceeds limit");
  if (await sha256Hex(payload) !== digest) throw new TypeError("telemetry payload digest mismatch");
  parseTelemetryDeliveryV2(JSON.parse(payload));
  const signature = await hmacHex(secret, TELEMETRY_V2_REQUEST_DOMAIN + "\n" + tenant + "\n" + timestamp + "\n" + payload);
  return new Request("https://telemetry.internal" + TELEMETRY_V2_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      [TENANT_HEADER]: tenant,
      [TIME_HEADER]: String(timestamp),
      [SIGNATURE_HEADER]: signature,
    },
    body: payload,
  });
}

/** Authenticates a v2 request (domain-separated from v1) and strictly parses its envelope. */
export async function verifyDeliveryRequestV2(request: Request, secret: string, now = Date.now()): Promise<VerifiedDeliveryV2> {
  const { tenant, text } = await verifySignedBody(request, secret, now, TELEMETRY_V2_PATH, TELEMETRY_V2_REQUEST_DOMAIN, MAX_TELEMETRY_V2_BODY_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("invalid telemetry JSON"); }
  return { tenant, delivery: parseTelemetryDeliveryV2(parsed), digest: await sha256Hex(text) };
}

function ackInput(tenant: string, status: TelemetryAckStatus, deliveryId: string, digest: string): string {
  return TELEMETRY_V2_ACK_DOMAIN + "\n" + tenant + "\n" + status + "\n" + deliveryId + "\n" + digest;
}

/** The receiver's durable acknowledgment, MAC'd under the ack domain with the tenant's key. */
export async function signTelemetryAckV2(
  tenant: string,
  secret: string,
  status: TelemetryAckStatus,
  deliveryId: string,
  digest: string,
): Promise<TelemetryAckV2> {
  return {
    schemaVersion: 2, status, deliveryId, digest, persisted: true,
    mac: await hmacHex(secret, ackInput(tenant, status, deliveryId, digest)),
  };
}

/** What a producer concluded from one delivery attempt. */
export type DeliveryOutcomeV2 =
  /** A verified durable ack for exactly this ID and digest. The only outcome that clears a row. */
  | { readonly kind: "acked"; readonly status: TelemetryAckStatus }
  /** Anything else: outage, timeout, rejection, T1-style 202, malformed or mismatched ack. */
  | { readonly kind: "retry"; readonly reason: DeliveryFailure }
  /** The receiver holds this delivery ID with a different digest. Retrying cannot succeed. */
  | { readonly kind: "conflict" };

/** Fixed, content-free failure codes: the only detail a failed attempt is allowed to record. */
export type DeliveryFailure = "timeout" | "unavailable" | "rejected" | "not_durable" | "invalid_ack" | "mismatched_ack";

export const DEFAULT_DELIVERY_TIMEOUT_MS = 5000;

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw new TypeError("telemetry ack too large");
  if (response.body === null) throw new TypeError("missing telemetry ack");
  const bytes = await boundedRequestBytes(response, maxBytes);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

/**
 * Sends one delivery attempt. Never throws for transport or receiver behaviour: the caller keeps
 * its outbox row unless — and only unless — it gets back `acked`. A `202` (including T1's
 * `persisted:false`) is never an ack, and an ack for another ID/digest or with a bad MAC is not
 * one either. Signing failures (a malformed stored payload) do throw: they are local bugs.
 */
export async function sendDeliveryV2(
  binding: TelemetryBinding,
  tenant: string,
  secret: string,
  payload: string,
  digest: string,
  options: { readonly timestamp?: number; readonly timeoutMs?: number } = {},
): Promise<DeliveryOutcomeV2> {
  const request = await signedDeliveryRequestV2(tenant, secret, payload, digest, options.timestamp);
  const deliveryId = parseTelemetryDeliveryV2(JSON.parse(payload)).deliveryId;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve("timeout"); }, options.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS);
  });
  try {
    const attempt = (async (): Promise<DeliveryOutcomeV2> => {
      const response = await binding.fetch(new Request(request, { signal: controller.signal }));
      if (response.status === 409) return { kind: "conflict" };
      if (response.status === 202) return { kind: "retry", reason: "not_durable" };
      if (response.status !== 200) return { kind: "retry", reason: response.status >= 500 || response.status === 429 || response.status === 408 ? "unavailable" : "rejected" };
      let ack: TelemetryAckV2;
      try { ack = parseTelemetryAckV2(await readBoundedText(response, MAX_TELEMETRY_ACK_BYTES)); }
      catch { return { kind: "retry", reason: "invalid_ack" }; }
      if (ack.deliveryId !== deliveryId || ack.digest !== digest ||
          !(await verifyHmacHex(secret, ackInput(tenant, ack.status, ack.deliveryId, ack.digest), ack.mac))) {
        return { kind: "retry", reason: "mismatched_ack" };
      }
      return { kind: "acked", status: ack.status };
    })().catch((): DeliveryOutcomeV2 => ({ kind: "retry", reason: "unavailable" }));
    const outcome = await Promise.race([attempt, timeout]);
    return outcome === "timeout" ? { kind: "retry", reason: "timeout" } : outcome;
  } finally {
    clearTimeout(timer);
  }
}
