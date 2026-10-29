# Evaluated volume membership

Owner decision: 29 October 2026. Owning issue: HM-21; program: HM-16. The first pilot
integration is EducateOS (SCHO-264). Institutional scope and enrollment remain separate gates.

The evaluated-volume denominator **E counts every unique committed evaluation**, across
`interaction.input`, `interaction.output`, `content.candidate` and
`assessment.evaluator-result`, including degraded results. The named membership revision is
`all-committed-evaluations-v1`. The private coverage experiment exports this name for scoped
model facts; it is not a new v2 field or a runtime coverage approval.

| Event | New E units |
| --- | --- |
| Newly committed evaluation of any supported kind | 1 |
| Committed degraded result, including a provider-outage hold | 1 |
| Each unique committed item in a batch | 1 |
| Retry/replay of the same committed evaluation | 0 |
| Rejected, unauthorized, conflicting or invalid request | 0 |
| Failed/rolled-back completion or attempt that never commits | 0 |

Input and output evaluations of one conversation are separate evaluations. Chunked content
creates one unit per unique committed chunk evaluation. A degraded evaluation that commits
is different from an attempt that fails before commit. This metric counts evaluations, not
model invocations, people, source submissions or student activity.

The candidate numerator F keeps its existing definition. A degraded hold adds E but does not
become candidate evidence. Any rate requires matched membership, source/cut and valid counts;
E=0 gives a null rate, and F>E is invalid.

## Existing collection and coverage limits

`apps/worker/src/metrics.ts` already projects one `content_evaluated` event without filtering
evaluation kind or degraded status. The reservation-owned completion transaction commits the
result, receipt and v2 outbox work together. Replays bypass this path; a failed transaction
commits none of them. Delivery dedupe prevents recounting a committed pair.

Projection/enrollment/retention settings and queue bounds can still prevent delivery. Those
losses do not narrow the product definition of E. Missing collection is not zero and cannot
be represented as complete coverage. Runtime receiver coverage remains `unavailable`. The
aggregate cut algorithm, expected-stream census, platform durability evidence, independent
proof review and approved evidence precision/retention remain prerequisites for W8b runtime.
No kind, degraded flag, membership identifier or identity was added to v2 payloads.

## Verification

The real-store reconciliation suite exercises all four kinds in healthy and degraded cases,
then signed delivery into the receiver and its aggregate Durable Object. It checks one unit
despite replay, no unit for a conflict/rejection, and preserves candidate semantics. A batch
case checks two unique commits, a duplicate item and a failed item against E=2/F=1. Existing
outbox atomic rollback and reservation-ownership tests cover failed/uncommitted completions.
The kind table is compared with the supported contract enum so future kinds need an explicit
membership decision. The qualified logical-cut model uses the same named membership and
continues to return `final:false`, `runtimeApproved:false`.
