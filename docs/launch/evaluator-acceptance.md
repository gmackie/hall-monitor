# Deployed evaluator acceptance (HM-18 / HM-20)

`pnpm evaluator-smoke` verifies a default-off evaluator release using synthetic content and
four **already trusted, unused** service JWTs. It never mints a signer, installs trust, changes
enrollment or deploys anything. It makes one classifier evaluation; its replay must make none.

First read ForgeGraph's production deployment record and confirm the intended target/commit is
active. Supply that **full commit** and **deployment UUID** explicitly. The command checks the
serving revision on every response; the deployment UUID is operator-supplied metadata and must
be matched to ForgeGraph evidence separately.

```sh
pnpm evaluator-smoke \
  --url https://hall-monitor.gmac.io \
  --commit <full-active-commit> \
  --deployment <active-deployment-uuid> \
  --credentials-file <private-file> \
  --out dist/evaluator-smoke.json
```

The private JSON file has exactly this shape (placeholders are not usable tokens):

```json
{
  "mode": "synthetic",
  "tenant": "authorized_synthetic_tenant",
  "source": "educateos",
  "tokens": {
    "ready": "<unused-JWT>",
    "evaluate": "<unused-JWT-with-evaluate-scope>",
    "replay": "<different-unused-JWT-with-evaluate-scope>",
    "receipt": "<unused-JWT-with-receipts:read-scope>"
  }
}
```

Use the existing authorized synthetic tenant/source, never a real learner tenant. Each token
must have a distinct issuer/jti replay identity, matching tenant and at most five minutes of
remaining validity. The parser's checks are syntactic; the target Worker verifies signatures,
issuer, audience, claims, scopes and single-use jti. Supply the file through T3's private secret
card or another existing private local credential path. Do not paste tokens into chat, shell
arguments, source, issue comments or PR descriptions. The script's errors contain fixed text.

## Five checks and the evidence boundary

1. **Health:** HTTP 200/`status:ok`, exact `x-hm-revision`, and
   `x-hm-telemetry-posture:unbound-disabled`. This unauthenticated step sends no token.
2. **Readiness:** all eight current readiness gates are present and true, including the decision
   pack and governance parser. Missing, false or changed gate sets fail conservatively.
3. **Evaluation:** a generated benign synthetic question receives a schema-valid enforced allow,
   with no degradation/uncertainty/shadow override and a nonempty provider-attempt receipt matching
   the synthetic tenant, source, request and cost center. The response must not reflect the text
   sentinel. A held/blocked result fails this smoke's expected fixture; it is not automatically
   overridden or treated as evidence of an unsafe service.
4. **Replay:** the exact same request and idempotency key, under a fresh token, returns the identical
   result and `idempotent-replayed:true`.
5. **Receipt:** a fresh read token retrieves the same tenant/request/evaluation's matching stored
   receipt, with a valid future expiry.

All five responses must serve the expected revision and default-off posture. The Worker emits
these two metadata headers from server bindings only. `unbound-disabled` requires both collection
switches off and **no** collector binding; otherwise it emits `configured` without revealing
settings. The revision header is absent unless the server binding is a full lowercase SHA.

Requests require HTTPS, reject redirects, have a 15-second deadline and never reuse a token on
retry. Responses are capped at 256 KiB and parsed with the current public contracts. Evidence
contains only target/revision, operator-supplied deployment ID, time and fixed phase outcomes;
no token, tenant/request/evaluation identifier, raw response, model result or input content.
Output is private by default. Tests use simulated transports and the actual Worker/DO harness;
neither is recorded as a real production acceptance run.

A passing file is evaluator API acceptance for that release, not approved calibration, custody,
privacy, real enrollment, receiver delivery, coverage, cloud export inspection or staffed response.
Link the actual deployment, commit, check artifact and health evidence to each owning Kanbanger
issue before evaluating its remaining acceptance criteria. ForgeGraph's aggregate health must
also be inspected; a public 200 alone does not settle a `healthy:false` platform result.
