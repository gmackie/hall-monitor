import { z } from "zod";
import { FindingCategory } from "./finding.ts";
import { MachineCode, OpaqueId } from "./primitives.ts";
import { SchemaVersion } from "./version.ts";

/** Display text for one reason code. Products show `title`; machine logic keys on `code` only. */
export const ReasonCodeInfo = z.object({
  code: MachineCode,
  /** The finding category the code belongs to; absent for system codes about the evaluation itself. */
  category: FindingCategory.optional(),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
});
/** Display text for one reason code. */
export type ReasonCodeInfo = z.infer<typeof ReasonCodeInfo>;

/** The body of `GET /v1/reason-codes` (0.5.0). */
export const ReasonCodeCatalog = z.object({
  schemaVersion: SchemaVersion,
  revision: OpaqueId,
  codes: z.array(ReasonCodeInfo).max(1000),
});
/** The body of `GET /v1/reason-codes`. */
export type ReasonCodeCatalog = z.infer<typeof ReasonCodeCatalog>;

/** Revision of {@link REASON_CODES}; bump on any change. */
export const REASON_CODES_REVISION = "reason-codes-2026-11-22.2";

type Entry = readonly [code: string, category: FindingCategory | undefined, title: string, description: string];

const ENTRIES: readonly Entry[] = [
  // System codes the resolver and core add about the evaluation itself.
  ["hall_monitor.unavailable", undefined, "Classifier unavailable", "A required model classifier gave no answer, so the profile's failure mode decided."],
  ["hall_monitor.deterministic_only", undefined, "Rules-only decision", "The classifier was unavailable and the profile allows deciding on deterministic rules alone."],
  ["hall_monitor.uncertain", undefined, "Uncertain", "A classifier answered, but not confidently enough for an automatic decision."],
  ["hall_monitor.budget_exhausted", undefined, "Budget exhausted", "The safety budget could not fund classification, so the profile's failure mode decided."],
  ["hall_monitor.shadow", undefined, "Shadow mode", "The tenant runs in shadow mode: the result enforces allow and records what enforcement would have returned."],
  ["hall_monitor.image_moderation_disabled", "format", "Images not moderated", "The policy profile does not moderate images, so the images were not classified."],
  // Deterministic evaluators.
  ["academic_integrity.answer_leakage", "academic-integrity", "Answer revealed", "The output reveals an answer from the supplied answer key."],
  ["academic_integrity.answer_key_marker", "academic-integrity", "Answer-key marker", "The text contains markers that indicate answer-key material."],
  ["academic_integrity.direct_answer_request", "academic-integrity", "Direct answer request", "The learner asks for the answer instead of help reaching it."],
  ["age_fit.readability_above_band", "age-fit", "Reading level above grade band", "The text reads well above the reading level of its grade band."],
  ["format.content_not_inspected", "format", "Content not inspected", "The content could not be inspected by the deterministic rules."],
  ["format.invalid_encoding", "format", "Invalid encoding", "The text contains invalid character encoding."],
  ["format.control_characters", "format", "Control characters", "The text contains control characters."],
  ["format.hidden_characters", "format", "Hidden characters", "The text contains invisible or hidden characters."],
  ["harassment.exclusion", "harassment", "Exclusion", "The text excludes or isolates someone."],
  ["harassment.insult", "harassment", "Insult", "The text insults someone."],
  ["harassment.self_harm_incitement", "harassment", "Incitement to self-harm", "The text encourages someone to harm themselves."],
  ["hate.dehumanization", "hate", "Dehumanizing language", "The text dehumanizes people for who they are."],
  ["privacy.email", "privacy", "Email address", "The text contains an email address."],
  ["privacy.government_id", "privacy", "Government ID", "The text contains what looks like a government identifier."],
  ["privacy.payment_card", "privacy", "Payment card", "The text contains what looks like a payment card number."],
  ["privacy.phone", "privacy", "Phone number", "The text contains a phone number."],
  ["privacy.street_address", "privacy", "Street address", "The text contains a street address."],
  ["prompt_injection.direct", "prompt-injection", "Prompt injection", "The input tries to override the assistant's instructions."],
  ["prompt_injection.indirect", "prompt-injection", "Indirect prompt injection", "Supplied content tries to override the assistant's instructions."],
  ["prompt_injection.instruction_override", "prompt-injection", "Instruction override", "Technique: asks the assistant to ignore its instructions."],
  ["prompt_injection.instruction_smuggling", "prompt-injection", "Instruction smuggling", "Technique: hides instructions inside other content."],
  ["prompt_injection.role_override", "prompt-injection", "Role override", "Technique: tries to give the assistant a different role."],
  ["prompt_injection.system_prompt_exfiltration", "prompt-injection", "System prompt extraction", "Technique: tries to reveal the assistant's hidden instructions."],
  ["safety.credential_theft", "safety", "Credential theft", "The text asks for or gives instructions to steal credentials."],
  ["safety.drug_synthesis", "safety", "Drug synthesis", "The text asks for or gives instructions to make drugs."],
  ["safety.filter_bypass", "safety", "Filter bypass", "The text tries to get around safety filters."],
  ["safety.poison_instructions", "safety", "Poison instructions", "The text asks for or gives instructions to poison someone."],
  ["safety.weapon_instructions", "safety", "Weapon instructions", "The text asks for or gives instructions to make weapons."],
  ["self_harm.disclosure", "self-harm", "Self-harm disclosure", "The writer indicates they may harm themselves; route to support."],
  ["sensitive_topic.academic_context", "safety", "Sensitive topic, academic context", "A sensitive topic appears in an academic framing."],
  ["sexual.solicitation", "sexual", "Sexual solicitation", "The text solicits sexual content or contact."],
  ["violence.threat", "violence", "Threat of violence", "The text threatens violence against people."],
  // Clef decision questions (clef-baseline pack).
  ["clef.self_harm", "self-harm", "Self-harm risk (model)", "The Clef classifier found that the writer may harm themselves or be in crisis."],
  ["clef.harassment", "harassment", "Harassment (model)", "The Clef classifier found bullying, harassment or demeaning content."],
  ["clef.sexual", "sexual", "Sexual content (model)", "The Clef classifier found sexual content or a request for it."],
  ["clef.violence", "violence", "Violence (model)", "The Clef classifier found threats or encouragement of violence."],
  ["clef.hate", "hate", "Hate (model)", "The Clef classifier found an attack on people for a protected characteristic."],
  ["clef.dangerous_instructions", "safety", "Dangerous instructions (model)", "The Clef classifier found instructions that could cause serious harm."],
  ["clef.prompt_injection", "prompt-injection", "Prompt injection (model)", "The Clef classifier found an attempt to override the assistant's instructions."],
  // Clairic extraction (preview; shadow unless waived). Evidence spans locate what was found.
  ["clairic.personal_identifier", "privacy", "Personal details (extracted)", "Clairic located details that identify a real private person; see the evidence spans."],
  ["clairic.answer_leakage", "academic-integrity", "Answer revealed (extracted)", "Clairic found the output states an expected answer outright; see the stated-answer spans."],
  ["clairic.evaluator_inconsistent", "quality", "Inconsistent evaluator result", "Clairic found the evaluator's stated score, verdict and reasons disagree."],
  ["clairic.claims", "quality", "Factual claims (extracted)", "Clairic located checkable factual claims for a reviewer to verify; informational."],
];

/** Display text for every reason code this release can emit. */
export const REASON_CODES: readonly ReasonCodeInfo[] = Object.freeze(
  ENTRIES.map(([code, category, title, description]) =>
    Object.freeze(category === undefined ? { code, title, description } : { code, category, title, description }),
  ),
);
