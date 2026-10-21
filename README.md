# Hall Monitor

Product-neutral moderation and evaluation service shared by SchoolOS and PlayTrek.

Hall Monitor answers one question: *is this content or requested activity appropriate for this
product, role, curriculum context and institutional policy, and what should happen next?* It
returns findings and a decision (`allow`, `coach`, `hold`, `block`, `support`) plus a content-free
cost receipt. It never authorizes access to student data, impersonates a teacher, or awards grades.

## Layout

| Package | Purpose |
|---|---|
| `packages/contracts` | Versioned wire schemas: evaluation requests and results, findings, receipts, errors |
| `packages/costing` | Integer `UsdNano` arithmetic, immutable price books, receipts and scenario calculator |
| `packages/policy` | Policy profiles, district floors and the deterministic decision resolver |
| `packages/evaluators` | Deterministic evaluator plugins |
| `packages/clef` | Cloudflare Workers AI Clef classifier adapter with escalation |
| `packages/core` | Evaluation orchestration |
| `packages/client` | TypeScript client used by products |
| `packages/test-fixtures` | Synthetic fixtures only; never real student data |
| `apps/worker` | Cloudflare Worker HTTP API |

## Rules

- No product code: shared packages never import `@playtrek/*`, `@schoolos/*` or `@gadgets/*`
  (`pnpm check:boundaries`).
- No raw content in receipts, logs or metrics. Money is integer nanodollars (10⁻⁹ USD), never floats.
- Fixtures are synthetic.

## Development

```sh
pnpm install
pnpm lint
pnpm test
```
