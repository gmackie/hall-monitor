/**
 * Read-API and compatibility smoke for a deployed evaluation Worker (HM-35).
 *
 *   <signing key on stdin> node scripts/read-api-smoke.ts --url https://… --issuer playtrek \
 *     --kid playtrek-beta-1 --tenant playtrek-beta --product playtrek [--expect-mode enforce|shadow]
 *
 * The private signing key (a JWK or PKCS#8 PEM, ES256 or EdDSA) is read from stdin and never
 * printed. One synthetic evaluation is made; everything else reads it back. Every response is
 * parsed with the current contracts and with the vendored 0.2.0 schemas (what PlayTrek pins), so
 * a pass also shows existing clients still parse it. Output names checks and ids only.
 */
import { parseArgs } from "node:util";
import {
  Capabilities, EvaluationPage, EvaluationRecord, EvaluationResult, ReasonCodeCatalog, ReceiptRecord,
} from "../packages/contracts/src/index.ts";
import * as v020 from "../packages/contracts/__tests__/legacy/v0.2.0/index.ts";

const { values } = parseArgs({ options: {
  url: { type: "string" }, issuer: { type: "string" }, kid: { type: "string" }, tenant: { type: "string" },
  product: { type: "string", default: "playtrek" }, audience: { type: "string", default: "hall-monitor" },
  "expect-mode": { type: "string" }, profile: { type: "string", default: "student-9-12" }, revision: { type: "string", default: "builtin-1" },
} });
if (!values.url || !values.issuer || !values.kid || !values.tenant) throw new Error("missing --url, --issuer, --kid or --tenant");
const base = values.url.replace(/\/$/, "");

const raw = (await new Promise<string>((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data.trim()));
}));
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
let key: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
let alg: "ES256" | "EdDSA";
if (raw.startsWith("{")) {
  const jwk = JSON.parse(raw) as { kty?: string; kid?: string } & Parameters<typeof crypto.subtle.importKey>[1];
  alg = jwk.kty === "OKP" ? "EdDSA" : "ES256";
  key = await crypto.subtle.importKey("jwk", jwk as never, alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" }, false, ["sign"]);
} else {
  const der = Buffer.from(raw.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  try {
    key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    alg = "ES256";
  } catch {
    key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    alg = "EdDSA";
  }
}

async function token(scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${enc({ alg, typ: "JWT", kid: values.kid })}.${enc({
    iss: values.issuer, aud: values.audience, tenant: values.tenant, scope, jti: crypto.randomUUID(), iat: now, exp: now + 120,
  })}`;
  const signature = await crypto.subtle.sign(alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" }, key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

const results: { check: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => {
  results.push({ check: name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
async function call(method: string, path: string, scope: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (scope !== null) headers.authorization = `Bearer ${await token(scope)}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, headers: response.headers, json };
}

const health = await call("GET", "/v1/health", null);
check("health", health.status === 200, `revision ${health.headers.get("x-hm-revision") ?? "none"}`);

const caps = await call("GET", "/v1/capabilities", "evaluate");
const capsParsed = Capabilities.safeParse(caps.json);
check("capabilities parse (0.5.0)", caps.status === 200 && capsParsed.success);
check("capabilities parse (0.2.0)", v020.Capabilities.safeParse(caps.json).success);
check("capabilities list models", (capsParsed.data?.models?.length ?? 0) > 0, (capsParsed.data?.models ?? []).map((m) => `${m.modelId}:${m.status}`).join(", "));

const id = crypto.randomUUID().slice(0, 12);
const request = {
  schemaVersion: "1.0", requestId: `req_smoke_${id}`, idempotencyKey: `idem_smoke_${id}`,
  source: { product: values.product, tenantId: values.tenant, surface: "smoke.synthetic" },
  policy: { profileId: values.profile, revision: values.revision },
  context: { audience: "student", gradeBand: "9-12", costCenterId: "cc_smoke" },
  evaluationKind: "interaction.input",
  content: { type: "text", text: "SYNTHETIC SMOKE: Why do leaves change colour in autumn?" },
};
const evaluated = await call("POST", "/v1/evaluations", "evaluate", request);
const result = EvaluationResult.safeParse(evaluated.json);
check("evaluate 200 and parse (0.5.0)", evaluated.status === 200 && result.success, `status ${evaluated.status}${result.success ? ` decision ${result.data.decision}` : ""}`);
check("evaluate parse (0.2.0 client schema)", v020.EvaluationResult.safeParse(evaluated.json).success);
check("evaluate does not echo content", !JSON.stringify(evaluated.json).includes("SYNTHETIC SMOKE"));
if (!result.success) { report(); process.exit(1); }
const r = result.data;
check("result carries route", r.route !== undefined, (r.route?.classifiers ?? []).map((c) => `${c.family}:${c.status}${c.skipReason ? `(${c.skipReason})` : ""}:${c.calls.map((call) => `${call.modelId.split("/").pop()}=${call.outcome}`).join(">")}`).join(" | "));
if (values["expect-mode"] === "shadow") check("shadow tenant enforces allow", r.decision === "allow");
if (values["expect-mode"] === "enforce") check("enforce tenant has no shadow outcome", r.shadow === undefined);

const replay = await call("POST", "/v1/evaluations", "evaluate", request);
check("idempotent replay", replay.status === 200 && replay.headers.get("idempotent-replayed") === "true" && JSON.stringify(replay.json) === JSON.stringify(evaluated.json));

const read = await call("GET", `/v1/evaluations/${encodeURIComponent(r.evaluationId)}`, "evaluations:read");
const record = EvaluationRecord.safeParse(read.json);
check("GET /v1/evaluations/{id}", read.status === 200 && record.success && JSON.stringify(record.data.result) === JSON.stringify(r), `status ${read.status}`);
check("record is content-free", !JSON.stringify(read.json).includes("SYNTHETIC SMOKE"));

const listed = await call("GET", `/v1/evaluations?requestId=${encodeURIComponent(request.requestId)}`, "evaluations:read");
const page = EvaluationPage.safeParse(listed.json);
check("GET /v1/evaluations?requestId=", listed.status === 200 && page.success && page.data.items.length === 1 && page.data.items[0]!.evaluationId === r.evaluationId, `status ${listed.status}`);

const newest = await call("GET", "/v1/evaluations?limit=5", "evaluations:read");
check("GET /v1/evaluations (newest page)", newest.status === 200 && EvaluationPage.safeParse(newest.json).success);

const denied = await call("GET", `/v1/evaluations/${encodeURIComponent(r.evaluationId)}`, "evaluate");
check("read requires evaluations:read", denied.status === 403, `status ${denied.status}`);

const codes = await call("GET", "/v1/reason-codes", "evaluate");
check("GET /v1/reason-codes", codes.status === 200 && ReasonCodeCatalog.safeParse(codes.json).success);

const receipt = await call("GET", `/v1/receipts/${encodeURIComponent(r.evaluationId)}`, "receipts:read");
check("GET /v1/receipts/{id} (unchanged route)", receipt.status === 200 && ReceiptRecord.safeParse(receipt.json).success, `status ${receipt.status}`);

report();
function report() {
  const failed = results.filter((entry) => !entry.pass).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}
