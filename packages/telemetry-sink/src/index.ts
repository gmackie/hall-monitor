import {
  MAX_CLOCK_SKEW_SECONDS,
  MAX_TELEMETRY_BODY_BYTES,
  SIGNATURE_HEADER,
  TELEMETRY_PATH,
  TENANT_HEADER,
  TIME_HEADER,
  parseTelemetryBatch,
  type TelemetryBatch,
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

function signedInput(tenant: string, timestamp: number, json: string): Uint8Array {
  return encoder.encode("hall-monitor-telemetry-v1\n" + tenant + "\n" + timestamp + "\n" + json);
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
  if (new URL(request.url).pathname !== TELEMETRY_PATH || request.method !== "POST") {
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
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_TELEMETRY_BODY_BYTES)) {
    throw new TypeError("telemetry body size exceeded");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_TELEMETRY_BODY_BYTES) {
    throw new TypeError("telemetry body size exceeded");
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  const key = await hmacKey(secret);
  const verified = await crypto.subtle.verify("HMAC", key, bytesOfHex(signature), signedInput(tenant, timestamp, text));
  if (!verified) throw new TypeError("telemetry authentication failed");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("invalid telemetry JSON"); }
  return { tenant, batch: parseTelemetryBatch(parsed) };
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
