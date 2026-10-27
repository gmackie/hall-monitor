# Temporal, pseudonymous incident intelligence graph

**Status: proposed; not implemented by the current Hall Monitor Worker.** The currently shipped service accepts isolated moderation requests and stores content-free result/receipt/idempotency data. Nothing in this document should be interpreted as authorization to start bulk analyzing real student private conversations.

## Purpose and minimization boundary

Goal: connect evidence of repeated harassment, coordinated exclusion, report manipulation, stalking or targeted spam within **disclosed, authorized school-managed surfaces** while preventing routine teachers or model providers from freely browsing student identities and communications.

The unit of intelligence is a **case-supported event assertion**, not a permanent social affinity between two students. We must not build a background map of “who dislikes whom,” friendship networks, sexuality, mental health, inferred popularity, political beliefs, or other sensitive traits. Negative sentiment and ordinary gossip alone generally do not justify long-lived records.

Proposed logical separation:

1. **Source systems:** EducateOS / PlayTrek maintain original messages and school-managed membership changes under their own legitimate retention and access policies.
2. **Inference adapter:** transient content evaluation receives only a necessary window and authorized purpose; original identity mapping stays in the source system.
3. **Short-lived safety signal store:** bounded references/possible targets and decisions only when there is a documented reason; strict expiry.
4. **Restricted case evidence store:** retained when an incident requires review; source refs, selected supporting excerpts/media if necessary, provenance, counterevidence, human outcomes, retention and preservation metadata.
5. **Identity vault / Gatekeeper policy:** independent of model scores; tenant-scoped token resolution only for authorized product delivery, protection or case investigation.

Pseudonymization **does not** make records anonymous or exempt from FERPA. Small class membership, time series and relationships can reidentify students without access to explicit names. See [FERPA/COPPA](../privacy/ferpa-coppa.md).

## Node and edge model

| Node | Meaning | Retention |
|---|---|---|
| ObservedEvent | Direct platform fact: message sent, report submitted, group member removed | Original remains governed by source; minimized signal is ephemeral |
| EvidenceReference | Pointer to source message/file, capture method and integrity evidence; not automatically copied content | Short-lived or justified case-scoped |
| MentionCandidate | Uncertain reference in a particular utterance (“they”, nickname, etc.) | Normally transient |
| Claim | Statement *someone made*, not an established proposition (e.g. an unverified rumor) | Only when directly relevant to a genuine safety candidate |
| ModelAssertion | Decision label, probability, applicable modality, context and model version | Normally transient; case-scoped when necessary |
| Hypothesis | Suspected pattern of sustained targeting, coercion, coordinated reporting or exclusion | Expiring case candidate |
| Incident | Reviewed case with status, purpose, responsible authority and defined retention | Case-specific |
| Intervention | Nudge, friction, safeguarding outreach, appeal or protective action and outcome | Minimized case/action record |

Edges are **reified**, i.e., edges themselves have identifiers, evidence, provenance, uncertainty and lifecycle: “Message X was *possibly about* P-10” rather than a direct “Student A dislikes Student B” edge.

~~~ts
// PROPOSED types, not current @gmacko/hall-monitor-contracts exports.
type SafetyEvent = {
  id: string;
  tenantId: string;
  occurredAt: string;
  kind:
    | "message.sent" | "message.edited" | "message.deleted"
    | "mention.created" | "reaction.added"
    | "group.member_removed" | "group.permission_changed"
    | "moderation.group_mute_applied" | "moderation.report_submitted"
    | "moderation.action_reversed" | "contact.block_bypass_attempt";
  actorScopedId?: string;
  affectedScopedIds?: string[];
  conversationScopedId?: string;
  context: { surface: string; groupPurpose: "required" | "optional" | "unknown" };
  evidenceRef?: string; // No raw content on the event bus
};

type InferredAssertion = {
  id: string;
  evidenceRef: string;
  claimType: "reference" | "sentiment" | "speech_act" | "pattern";
  subjectCandidate?: string;             // Can remain unresolved
  targetCandidates: Array<{ scopedId: string; modelScore: number }>;
  decisionId: string;
  modelId: string;
  modelRevision: string;
  registryRevision: string;
  calibrationRevision?: string;
  uncertainties: string[];
  alternatives: string[];
  state: "hypothesis" | "reviewed" | "retracted" | "expired";
  expiresAt: string;
};

type IncidentCandidate = {
  id: string;
  tenantId: string;
  purpose: "student_safety";
  sourceAssertionIds: string[];
  counterEvidenceIds: string[];
  temporalWindow: { from: string; to: string };
  independentSourceGroups: string[];
  assessmentState: "unreviewed" | "needs_review" | "closed" | "substantiated";
  approvalRef?: string;
  retentionRuleId: string;
};
~~~

All records require tenant isolation; enforce authorization **before** any graph query and in storage access, not only within the UI. IDs for cross-event correlation should be keyed, scoped pseudonyms, not plain hashes of student IDs. Rotate scopes; maintain no global student ID spanning institutions. Ephemeral one-time delivery tokens are distinct from cross-event correlation IDs.

## Entity reference and rumor handling

Suppose an authorized, school-managed chat contains: “Nobody wants Alex on our science project; tell everyone not to invite them.”

Possible assertions:
- speaker ID is a direct observed event from source authentication;
- the phrase may refer to Student B (probabilistic reference, not fact);
- “urge exclusion” may be a high-scoring speech act;
- group participation could be mandatory (verified via source metadata);
- no bullying campaign is established solely by this message.

If a later message refers to “him” or a different Alex, do **not** auto-unify entities based on nickname or a probable match. Preserve competing hypotheses and avoid storing speculative real-world identities. A fabricated screenshot does not turn a rumor into verified evidence. A victim's report must not automatically be treated as participation in rumor dissemination.

Track rumor *propagation* only inside incident-scoped material where necessary, e.g. Claim R-4 -> reported in conversation X -> re-shared in Y. Never maintain an index of all interpersonal allegations in the student body or try to declare whether an allegation is true using AI.

## Candidate correlation: avoid additive “bad person points”

Event counts, distinct days, same target and temporal clustering can help select a case for review, but do not prove intent or coordination. Treat repeated forwarding from one source as correlated evidence. Consider:

- **Source independence:** copies/brigaded reports are not independent confirmation.
- **Temporal continuity:** repeated targeted interactions across distinct periods differ from multiple messages in one exchange.
- **Role and context:** required versus optional group; report versus perpetration; adult moderation versus student moderation.
- **Impact:** access denial or unwanted contact may be observable without inferring motives.
- **Counterevidence:** mutual joking, corrections, withdrawal of allegations, restored access, good-faith reporting.
- **Exceptions:** credible imminent harm goes directly to designated safeguarding response without reaching a points threshold.

Do not combine scores as if independent calibrated probabilities. A proposed case-level ranking needs domain review, validation and interpretable reasons; no automated guilt labels or punishment. Graph-derived risk should represent a *case's need for attention*, not a student's enduring disposition.

## Access and conditional disclosure

**A threshold never directly unmasks a person.** There are two decisions: (1) evidence is sufficient for restricted *review*; (2) an authorized official needs a specific identity or evidence excerpt for a recorded purpose. Suggested policy:

- Source-app enforcement may privately deliver a nudge or contact protection to an opaque participant without allowing a reviewer to see identity.
- Teacher dashboard receives only sufficiently aggregated classroom climate trends and generic pedagogical suggestions. Small-cohort suppression prevents re-identification.
- Designated safeguarding roles can request minimum-necessary case records; approval is purpose-bound, time-limited, auditable, independently reviewable.
- Ordinary discretionary case unmasking can require a second approver; urgent credible threats have an expedited documented pathway, never an AI-only reveal.
- The system must honor parent/eligible-student access to maintained education records under FERPA, with multi-student redaction/inspection procedures. Gatekeeper access decisions do not cancel statutory rights.
- Access and disclosure events are *sensitive metadata* themselves: log narrowly, protect from teachers and students who have no legitimate interest, and retain under policy.

Using two-person cryptographic threshold schemes for revealing an encrypted student key is an **optional long-term design exploration**, not a currently shipped cryptographic guarantee. Hardware-level enforcement and auditable authz must exist regardless.

## Retention, deletion and information hazards

- No fixed retention duration is prescribed here. District records officer must approve separate TTLs for transient signals, unsubstantiated candidates, substantiated cases and necessary appeals/legal holds; enforce and test those lifecycle rules.
- Retention starts with collection purpose. Ordinary low-risk sentiment and social opinions are not retained as independent graph entries.
- Access/correction/deletion requests must propagate to derived assertions, embeddings, secondary indexes, backup processes, and processor copies where legally permitted. Don't delete material while a valid inspection request or lawful hold prevents it.
- Graph topology is itself personal data; protect queries, exports, backups and staff tools from indirect identification.
- Use separately keyed tenant scopes and encryption. Use data minimization before provider calls, not just redaction of stored results.

## Evaluation plan

Synthetic simulations first: nested quotations, ambiguous pronouns, classmates with same name, gossip relayed as a protective report, optional friend groups, required projects, coordinated exclusion, duplicated screenshots, report brigading, repeated contact after a block, and wrong entity resolution. Measure attribution precision and uncertainty calibration separately from speech-act classification and incident false positive/false negative rates.

Related research: [TGBully](https://arxiv.org/abs/2011.00449) models temporal interaction and topic; [session-based cyberbullying survey](https://arxiv.org/abs/2207.10639) cautions against evaluating isolated comments alone. Neither validates automated identification of students or a generalized permanent graph.
