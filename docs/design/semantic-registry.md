# Portable moderation decision / Noul registry

Status: **proposed taxonomy and registry contract**, not the current Clef questions. Existing hard-coded questions live in packages/clef/src/clef-protocol.ts; changing them requires version bump, tests and calibration. There is no universally recognized “standard Nouls for school bullying.” The registry below defines our vocabulary with traceable upstream mappings, not a claim of formal standardization.

## Distinguish kinds of inference

1. **Content hazard:** sexual/graphic violence, threats, hate, self-harm, privacy exposure.
2. **Speech act:** insult, coordination request, rumor forwarding, exclusion advocacy, support-seeking, report of misconduct, ordinary venting.
3. **Reference:** whether a phrase refers to a particular target (possibly unresolved or one of several candidates).
4. **Context:** quoted speech, curriculum discussion, consensual banter, student-in-distress, required participation, prior provocation.
5. **Incident hypothesis:** whether a sequence of independently grounded events indicates repeated targeting, not an individual message label.

Do not collapse these into a single “bully score,” “dangerous student score,” or mental-health diagnosis. A high probability of negative sentiment can coexist with low probability of harassment. There is no “proof a student cheated” Noul.

## Proposed versioned packs

| Pack | IDs (examples) | Primary evidence |
|---|---|---|
| safety.core.v1 | harassment, threat, hate, self_harm_disclosure, self_harm_encouragement, sexual_content, graphic_violence, privacy_exposure | Text/image classifier where supported; safety playbooks |
| safety.education.v1 | educational_context, quotation, supportive_disclosure, academic_disagreement, required_group_access | Activity, curriculum and permission context |
| behavior.relational.v1 | directed_hostility, social_exclusion_advocacy, rumor_forwarding, targeted_humiliation, coordinated_targeting, deliberate_provocation, retaliatory_harassment | Short context window, relevant events and reported evidence |
| behavior.platform.v1 | targeted_spam, report_manipulation, delegated_mute_abuse, contact_boundary_evasion, permission_exclusion | Deterministic event/permission analysis, optional supporting Noul |
| media.school.v1 | humiliating_image, impersonation, intimate_privacy_violation, synthetic_media_suspicion | Media plus relevant text/context; high-risk dedicated workflows |

Do not publish a pack as “supported for images” merely because the provider accepts image inputs. Each question and modality must be separately benchmarked. In particular [OpenAI Moderation](https://developers.openai.com/api/docs/guides/moderation) marks harassment text-only; Meta's [Llama Guard 4](https://huggingface.co/meta-llama/Llama-Guard-4-12B) has an S5 Defamation hazard, not a fact-checking or rumor-verification model.

## Definition shape (proposal, NOT a shipped TypeScript export)

~~~ts
type DecisionDefinition = {
  id: string;                   // behavior.relational.v1.rumor_forwarding
  version: string;              // semver or immutable digest
  kind: "binary" | "choice" | "score";
  definition: string;
  positiveCriteria: string[];
  negativeCriteria: string[];
  requiredContext: string[];    // e.g. message, reply_to, group_purpose
  modalities: ("text" | "image" | "video" | "audio")[];
  supports: { provider: string; model: string; validated: boolean }[];
  upstreamMappings?: { taxonomy: string; category: string; caveat?: string }[];
  fixturesRevision: string;
  calibrationRevision?: string;
  authority: "classification_only"; // Never a discipline authorization
};
~~~

Every registry release must be immutable, signed or digest-pinned, and have a changelog, human owner, golden fixtures and measured deployment/age-band applicability. Policy sets enforcement thresholds separately; a registry upgrade does not silently alter a live district's decisions.

## Representative Noul intents and negatives

| Noul | Positive intent | Critical negative cases |
|---|---|---|
| rumor_forwarding | Knowingly or uncritically urging redistribution of an unverified personal allegation | Asking privately for help, reporting abuse to trusted adult, quoting an allegation to refute it |
| social_exclusion_advocacy | Directly organizing others to deny participation in a required group or sustained harassment campaign | Choosing friends, personal boundaries, declining optional invitations |
| delegated_mute_abuse | Evidence that entrusted group moderation powers are used to unjustifiably silence a particular participant | Legitimate moderator enforcement, personal mute preferences |
| report_manipulation | Evidence of soliciting coordinated reports intended to suppress a person rather than report harm | Multiple independent good-faith reports |
| targeted_humiliation | Direct ridicule directed at identifiable person, including images or memes | Literary analysis, criticism of ideas, nonspecific joking |
| supportive_disclosure | A person asking for help or reporting harm in good faith | No inference of truth of accusations solely from asking for help |
| deliberate_provocation | Repeated contextual attempts to induce an angry reaction followed by calls for punishment | Genuine disagreement and legitimate reporting |

Example **decision intent** (not production-ready Clef wire format): “Does this message explicitly urge others to exclude a referenced student from a required activity? Mark ordinary choices about friendships as negative. If group type or referent is unknown, indicate insufficient context.” Validate any adapter against current API shape: [Clef questions](https://developers.cloudflare.com/workers-ai/models/clef/) and [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) are similar concepts, not identical request schemas.

## Calibration and disagreement

- Separate referent-resolution confidence from classification score, ground-truth confidence and incident-level corroboration. They are not interchangeable.
- A model output of 0.9 is not automatically a calibrated 90% chance of bullying. Measure empirical reliability by age band, language, modality and context.
- Construct blinded, human-adjudicated positive/negative/ambiguous fixtures; annotate protective disclosures, sarcasm, disability-related language differences, quoted speech, multilingual code-switching, explicit instructions to ignore, ordinary ignoring and report brigading.
- Measure precision/recall, PR-AUC, false positive rate, subgroup disparities where ethical and feasible, abstention, score calibration (ECE/Brier), escalation rate, and drift after provider/model updates.
- Score evidence **independence**: ten forwarded versions of one statement do not equal ten independent witnesses; cross-room repetition may represent the same originating rumor.
- Persist both supporting and contradicting evidence in a restricted case, with a reasoned adjudication history; uncertainty never becomes a permanently asserted student trait.
- Test that removing model inference still preserves deterministic safety invariants and student help-seeking paths.

## Human-feedback learning path

Start with expert-written Nouls, synthetic fixture tests and controlled threshold calibration. Later investigate supervised small classifiers and preference-based training on **explicitly authorized, minimized, properly governed** examples. Do not automatically harvest identifiable school chat logs or train shared commercial models. Measure behavior and safety outcomes, not “student edited their comment” as proof of correctness. Keep classification model, intervention policy, and access/disclosure authority separately versioned.

Relevant research: [TGBully temporal interaction modeling](https://arxiv.org/abs/2011.00449), [session-based cyberbullying survey](https://arxiv.org/abs/2207.10639), and [SLM-Mod (NAACL 2025)](https://aclanthology.org/2025.naacl-long.441/). These studies support evaluation of contextual approaches; they do not validate our exact school-specific Nouls.
