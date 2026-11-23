# HM-33/34: the Hall Monitor admin console

`apps/admin` is a separate Cloudflare Worker, `hall-monitor-admin`, on its own hostname
(`hall-monitor-admin.gmac.io`). It serves a static, dependency-free SPA (`public/`) and a JSON API
under `/admin/v1/*`, and sits behind Cloudflare Access. The evaluation Worker still has no UI and
no admin HTTP route.

| Piece | What it does |
|---|---|
| Access auth | The Worker verifies `Cf-Access-Jwt-Assertion` itself: RS256 only, a key from `https://<team>/cdn-cgi/access/certs` by `kid` (cached 5 minutes), `iss = https://<team>`, `aud` containing `HM_ADMIN_ACCESS_AUD`, `exp`/`nbf` with 60 s skew, and an `email` claim. Without `HM_ADMIN_ACCESS_TEAM_DOMAIN` and `HM_ADMIN_ACCESS_AUD`, every API call returns 503. |
| Roles (D1) | `admin` is global (stored with tenant `*`, or listed in the `HM_ADMIN_BOOTSTRAP_EMAILS` secret). `viewer`, `policy-editor`, `labeler`, `adjudicator` and `publisher` are granted per tenant, and any of them lets the holder view that tenant. |
| Tenants | An admin sees `HM_ADMIN_TENANTS` (a JSON array, default `["playtrek","playtrek-beta"]`) plus every tenant named in a grant. Anyone else sees the tenants they hold a role on. |
| Explorer | Reads tenant records through the evaluation Worker's `AdminRpc` entrypoint (service binding `EVALUATOR`, `entrypoint: "AdminRpc"`). These are the same content-free `EvaluationRecord`s products get. |
| Audit | Every mutation writes an `audit_log` row: actor, action, tenant and target id, never content. |

## The deep link

PlayTrek links each evaluation to `<console>/evaluations/<evaluationId>`. Assets use
`not_found_handling: "single-page-application"`, so that path serves the SPA, which calls:

- `GET /admin/v1/evaluations/{evaluationId}` calls `EVALUATOR.getEvaluation(tenant, id)` for
  every tenant the person can view, in parallel, and returns `{tenant, record}` for the first match
  in tenant order.
- `GET /admin/v1/evaluations/{evaluationId}?tenant=t` reads only tenant `t`.

A miss returns `404 {"code":"not_found","message":"evaluation not found"}`. So does a tenant the
person cannot view, so the response never reveals which tenants exist.

For a shadow record (`record.mode === "shadow"`), the detail view shows "Shadow: would have been
`<result.shadow.decision>`" next to the enforced `allow`. The list has a "Would be (shadow)" column.
Costs are integer nanodollar strings, formatted in the SPA with `BigInt` (whole dollars are
`n / 10^9`, followed by the zero-padded remainder).

## API

All routes are under `/admin/v1` and need an Access session. "T" marks a tenant-scoped role.

| Route | Role |
|---|---|
| `GET /me`, `GET /reason-codes`, `GET /models` | any signed-in person |
| `POST /models:gate` | any signed-in person. Runs `evaluateModelGate` over uploaded evidence against `config/model-gates.json`. Nothing is stored and the verdict is always `not-approved`. |
| `GET /tenants/{t}/evaluations?…`, `GET /tenants/{t}/evaluations/{id}`, `GET /evaluations/{id}[?tenant=]` | viewer (T) |
| `GET /tenants/{t}/profiles`, `GET …/profiles/{p}/revisions`, `GET …/revisions/{r}/diff` | viewer (T) |
| `POST /tenants/{t}/profiles/{p}/revisions` (draft), `PUT …/revisions/{r}/routing`, `POST …/revisions/{r}:diff`, `POST …/revisions/{r}:propose` | policy-editor (T) |
| `POST …/revisions/{r}:approve` | publisher (T), not the author |
| `GET /releases`, `POST /releases`, `POST /releases/{id}:activate` | publisher on every tenant the release changes |
| `PUT /tenants/{t}/mode` | admin |
| `GET /tenants/{t}/label-sets` | viewer (T) |
| `POST /tenants/{t}/label-sets` (import a study) | admin |
| `GET …/label-sets/{s}/queue`, `POST …/items/{blind}/labels` | labeler (T) |
| `GET …/adjudication-queue`, `POST …/items/{blind}/adjudication`, `POST …/predictions`, `POST …/label-sets/{s}:score` | adjudicator (T) or admin |
| `GET …/label-sets/{s}/calibration-reports` | labeler or adjudicator (T) |
| `GET /roles`, `POST /roles`, `POST /roles:revoke`, `GET /audit` | admin |

Every D1 query on tenant data filters on `tenant`. Another tenant's revision, set or record id
reads as 404, and a tenant the person holds no role on is 403.

## Revisions and the two-person rule

A revision is one tenant's `PolicyOverlay` on one built-in floor. It moves from `draft` to
`proposed`, then `approved`, then `published`. Drafts are checked with `applyOverlay`: weakening
fields are stored and returned as violations, and a draft with violations cannot be proposed. The
evaluation Worker would clamp those fields anyway. `:diff` runs `diffDecisions` over the profile's
synthetic cases, comparing the tenant's published revision (or the floor) with the candidate, using
the local fake classifier. The report holds case ids, codes and counts.

The two-person rule (`src/two-person.ts`) works at two points:

- **Approval.** No one can approve their own revision. This applies to every revision.
- **Publishing.** The publisher must not be the author of any newly included revision that is
  sensitive: its effective profile is student-facing, or its routing puts a family in `enforce`.
  Each release names its publisher (`author`) and a second person (`approver`).

Preview families such as Clairic still run in shadow unless the Worker's `HM_MODEL_ENFORCE_WAIVERS`
secret lists them. The console cannot read that secret. A revision can only record that a waiver
was noted (`waiverNoted`).

## Config releases

`packages/config-release` defines the release:

```ts
ConfigRelease = { schemaVersion: "1.0", releaseId, createdAt, author, approver,
                  overlays: { [tenant]: { [profileId]: PolicyOverlay } },
                  tenantModes?: { [tenant]: "shadow" | "enforce" | { mode, allowStudentShadow? } } }
```

It is a strict schema. It refuses unknown keys, any `HM_GOVERNANCE`, `governance`, `waivers` or
`HM_MODEL_ENFORCE_WAIVERS` key at any depth, and `author === approver`. Its digest is
`sha256:` + SHA-256 over `hall-monitor/config-release/v1\n` + canonical JSON (sorted keys).

Publishing does the following, in order:

1. Takes the latest approved or published revision of every tenant and profile, plus the tenant
   modes (if any are set).
2. Writes the canonical body to R2 at `releases/<digest>.json` (`CONFIG_RELEASES`).
3. Records the release in D1 and marks the new revisions published.
4. Sets KV `active` to `{releaseId, digest}` (`CONFIG_POINTER`).

`:activate` points KV at an earlier release, for rollback, after checking that its stored body
still verifies.

The evaluation Worker (`apps/worker/src/config-release.ts`) reads the pointer at most once a minute
per isolate, and reads R2 only when the pointer moves. It verifies the digest and the release id.
A verified release replaces `HM_POLICY_OVERLAYS`. If the release carries `tenantModes`, they replace
`HM_TENANT_MODES`; otherwise the secret stays in force. Every overlay is still applied tighten-only
through `applyOverlay`, so a release cannot weaken a floor. Without the bindings, or without a
pointer, the Worker reads only its secrets. A bad pointer, a missing or tampered object, or a
mismatched id logs `config.release_invalid` with a fixed `reason`, and the Worker falls back to its
secrets. Issuers, governance and waivers are only ever secrets.

**The first release replaces `HM_POLICY_OVERLAYS` entirely.** Before publishing it, recreate any
overlays that secret holds as revisions. An empty first release is refused.

## Labels and calibration

An admin imports a calibration study (`pnpm calibration init`). Its cases must be `synthetic` or
`licensed`, which the study schema enforces. The import checks the study again, then freezes,
digests and blinds it with `prepareCalibrationPacket`. The case text lives only in D1 `label_sets`.

The labeler's queue holds the blind id, cohort, content and decision instructions. It never holds
the key, split, source or family ids, other reviewers' labels or model scores.

Adjudication covers items with at least two independent labels that disagree. An adjudicator
cannot adjudicate an item they labelled, and cannot label an item they adjudicated.

`:score` runs `scoreCalibration` on the following inputs:

- the stored study and key
- every label, with reviewers pseudonymized per set
- every adjudication
- the imported predictions

The report is a candidate (`activation: "not-approved"`). Promotion is shown disabled, because
calibration activation requires a Worker change (HM-8). This plan does not cover capturing
production learner content for labelling. That would need the approvals in
[record-custody-decision.md](../privacy/record-custody-decision.md).

## Deploying

The console is the `admin-worker` target of ForgeGraph's `production` stage (`.forgegraph.yaml`).
ForgeGraph allows only the development, staging, beta and production stages, so the console isn't
a stage of its own. It deploys with the evaluation Worker on every production release. The target
runs `pnpm exec wrangler deploy --domain hall-monitor-admin.gmac.io` from `apps/admin`. The
production stage's secrets sync to both Workers. `HM_ADMIN_BOOTSTRAP_EMAILS` belongs to the
console; the console ignores the others.

These resources already exist in the account, and their IDs are in the wrangler configs:

| Resource | Name | Bound by |
|---|---|---|
| D1 | `hm-control` | admin (`DB`) |
| KV | `hm-config-pointer` | admin and evaluation Worker (`CONFIG_POINTER`) |
| R2 | `hm-config-releases` | admin and evaluation Worker (`CONFIG_RELEASES`) |
| Access application | "Hall Monitor admin console", `hall-monitor-admin.gmac.io`, owner-only policy | team domain `gmacko.cloudflareaccess.com`; its AUD tag is `HM_ADMIN_ACCESS_AUD` |

Apply new migrations (`apps/admin/migrations/`) before deploying code that uses them:

```sh
cd apps/admin
pnpm exec wrangler d1 migrations apply hm-control --remote
```

`0001` and `0002` are already applied and recorded in `d1_migrations`.

With no active release, or an invalid one, the evaluation Worker reads its secrets exactly as
before. The first release replaces `HM_POLICY_OVERLAYS`, so recreate any overlays from that
secret as revisions before publishing.
