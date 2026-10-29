# Synthetic restricted actions and case hypotheses (HM-25 / W12–W13)

Two private packages implement an offline fixture protocol and a bounded pure case model.
Every event requires `mode: "synthetic"`; there is no production ingress, source adapter, case
database, identity resolution, user interface or live rubric. Nothing imports these packages
into either Worker or a publishable package. No real case data belongs in this repository.

## Source contract

`@gmacko/hall-monitor-safety-events` separates three categories:

| Category | Meaning | Authority |
| --- | --- | --- |
| observed | A source-attested committed permission transition | Enrolled producer with observed capability |
| reported | A human allegation, supportive report, forwarded rumor or quotation | Enrolled report producer; never a verified offense |
| model | A versioned model assertion with explicit candidate referents | Enrolled model producer; never a platform fact |

The strict schema permits no message body, names, image bytes, free-form explanation or personal
mute/ignore preference. A required-group access transition records source-verified role,
enrollment, permission, group purpose and before/after membership. A personal preference cannot
be relabelled as a committed permission change. `unknown` group purpose remains unknown;
optional social participation does not become required classroom access.

Use `deriveSafetyReference` with a separately held key to derive tenant/case/type-scoped HMAC
pseudonyms for people, groups, source evidence and origin groups. The same raw source ID has
different tokens in another tenant or case. These are still protected linkable references,
not anonymous analytics. Evidence is a source pointer, never a copy of its content. Key custody,
resolution permissions and rights lifecycle remain the owning source/custodian's responsibility.

The signed fixture delivery binds key ID, millisecond send time and exact body under a separate
domain. It is limited to 16 KiB, a five-minute transport window, an explicit grant scope/category,
producer, validity window, maximum event age and maximum event lifetime. There are no retention
defaults. A revoked or malformed grant, future/stale occurrence, expired record, wrong scope,
bad signature or unauthorized category is refused. Re-signing an expired occurrence cannot
restore it. A report-only key cannot submit a source-observed fact.

Authentication verifies what the authorized producer asserted. It cannot independently establish
that a compromised or defective source told the truth about role, enrollment, access or evidence.
The source product must verify these from its transaction and current permissions; a browser or
model must not supply them. A forged screenshot remains `unverified-capture`; a signature is not
forensic proof of the screenshot's content.

The in-memory source fixture demonstrates atomic membership plus outbox update, failed-commit
rollback, stable retries, causal restoration and no preference events. It proves fixture behavior
only. Durable source outbox, permission/API integration, concurrency, real keys and delivery/ack
semantics belong in the owning product issue (SCHO-264 or a selected PlayTrek issue). No live
destination is approved before the custody and rights decisions in HM-26.

## Causal ledger and corrections

`@gmacko/hall-monitor-incident-engine` accepts only admissions made by the verifier in the same
process. Copying a plain JSON object does not make it verified. A ledger is one tenant/case and
at most 256 distinct fact variants. Identical retries consume no slot. A new variant over the
bound enters terminal capacity with no successful summary; conflicts are never evicted to keep
an apparently clean view. This is a fixture bound, not a production storage algorithm.

Each record has a stable ID, source producer, monotonic version and predecessor digest. Missing
versions stay pending. Same-version/different-body variants stay conflicted. Wrong predecessors,
category promotion, producer changes and resurrection after a retraction are invalid. Permission
transitions preserve group/target and link the previous membership state. Two independent
permission histories for the same group/target withhold the access hypothesis, including when
one is expired or retracted; source adapters must provide one stable history.

An explicit correction can fix wrong attribution without retaining the old claim as current.
Retraction or expiry removes the hypothesis and never exposes an older revision as current.
Derived assertions pin their source record digests. Correction, retraction, expiry, conflict or
missing source makes the dependent assertion unavailable. Cyclic/unavailable dependencies cannot
support a case. The finite model retains history until the ledger is discarded; it supplies no
approved deletion/hold lifecycle or backup erasure guarantee.

Reports preserve their speech act and competing scoped subjects. A same name or pronoun is not
resolved into one person. Source-attested evidence groups sharing an origin or source artifact
are counted once; copies, forwarded rumors, quotations and unverified captures do not become
additional independent witnesses. This count is explicitly a source claim, not independent
proof. Volume never changes the rubric, silences a reporter or authorizes an adverse action.

## Review output and limits

The fixed `synthetic-review-1` rubric emits only interpretable candidates for qualified human
review: required participation access loss, reported concern, model context or unresolved
attribution. Restored access is visible as the latest source transition and removes the access
loss candidate. It does not prove no earlier harm occurred. Supportive reporting never labels
the reporter as a perpetrator. Model confidence cannot select an identity, authorize disclosure
or discipline, or create a lasting student reputation. Both capabilities are always unavailable.

The summary is case-scoped, synthetic and `activation: "not-approved"`; incomplete causal or
conflicting evidence stays explicit. There is no prioritization, automatic substantiation or
proof of malicious intent. A trained domain owner must approve a live rubric and its error
limits separately. The help/referral route must remain independent of this delayed model.

Live work still needs an approved source/surface and enrollment, record custody and retention,
independent disclosure controls, inspection/correction/appeal and hold/deletion workflows,
staffed safeguarding ownership and separate source/deployment evidence. These packages neither
add those authorities nor require a global student relationship graph.
