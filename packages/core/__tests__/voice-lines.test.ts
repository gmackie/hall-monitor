import { CLEF_QUESTIONS, type ClefTransport, type ClefTransportResult, createClefClassifier } from "@gmacko/hall-monitor-clef";
import { EvaluationRequest, type SpeakerProfile } from "@gmacko/hall-monitor-contracts";
import { CLEF_FLASH_MODEL, PRICE_BOOK_CLOUDFLARE_2026_10_20 } from "@gmacko/hall-monitor-costing";
import { defaultBundle } from "@gmacko/hall-monitor-evaluators";
import { BUILTIN_PROFILES } from "@gmacko/hall-monitor-policy";
import { describe, expect, it } from "vitest";
import { type EvaluateDeps, evaluate } from "../src/index.ts";

class CountingTransport implements ClefTransport {
  readonly models: string[] = [];
  async run(model: string): Promise<ClefTransportResult> {
    this.models.push(model);
    return {
      output: { model: "clef-flash", answers: Object.fromEntries(CLEF_QUESTIONS.map((question) => [question.id, { type: "noul", noul: 0.01 }])) },
      usage: { inputTokens: 602 },
    };
  }
}

function deps(transport: ClefTransport): EvaluateDeps {
  const clock = () => new Date("2026-11-23T12:00:00.000Z");
  let n = 0;
  return {
    policies: (id, revision) => (revision === "builtin-1" ? BUILTIN_PROFILES[id] : undefined),
    bundle: defaultBundle,
    classifier: createClefClassifier({ transport, priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20, newAttemptId: () => `att_${n++}`, clock, timeoutMs: 50 }),
    priceBook: PRICE_BOOK_CLOUDFLARE_2026_10_20,
    clock,
    ids: { evaluationId: () => "eval_vl", receiptId: () => "rcpt_vl" },
  };
}

/** A request shaped like PlayTrek's voice-line sender: spoken form, then the caption when it differs. */
function voiceLine(surface: string, profileId: string, text: string, answerKey?: string[]): EvaluationRequest {
  return {
    schemaVersion: "1.0",
    requestId: "pt.vl.ep1.v1.s0.abc",
    idempotencyKey: "pt.vl.ep1.v1.s0.abc",
    source: { product: "playtrek", tenantId: "tenant_playtrek", surface },
    policy: { profileId, revision: "builtin-1" },
    context: { gradeBand: "K-2", subject: "math", activityKind: "episode", audience: "student", costCenterId: "playtrek.episodes" },
    evaluationKind: "content.candidate",
    content: { type: "text", text, ...(answerKey === undefined ? {} : { answerKey }) },
  };
}

describe("evaluate on voice-line surfaces", () => {
  it("allows a kind, plain composed line after one Clef-flash check", async () => {
    const transport = new CountingTransport();
    const result = await evaluate(
      voiceLine("voice_line.composed", "voice-lines", "You ate three fourths of the pie.\nYou ate 3/4 of the pie.\n\nNice counting!"),
      deps(transport),
    );
    expect(result).toMatchObject({ decision: "allow", reasonCodes: [], policyRevision: "builtin-1", evaluatorBundleRevision: "base-1.2.0:clef-1.1.0" });
    expect(transport.models).toEqual([CLEF_FLASH_MODEL]);
    expect(result.receipt?.purpose).toBe("content.review");
  });

  it("holds a composed line that says the answer aloud or shames the learner, without echoing it", async () => {
    const transport = new CountingTransport();
    const result = await evaluate(
      voiceLine("voice_line.composed", "voice-lines", "Wrong again! The answer is three fourths.\nWrong again! The answer is 3/4.", ["3/4"]),
      deps(transport),
    );
    expect(result.decision).toBe("hold");
    expect(result.reasonCodes).toEqual(expect.arrayContaining(["academic_integrity.spoken_answer_leakage", "academic_integrity.answer_leakage", "tone.shaming"]));
    expect(JSON.stringify(result)).not.toMatch(/fourths|wrong again/i);
  });

  it("coaches a stock compliment on the feedback surface", async () => {
    const result = await evaluate(voiceLine("voice_line.feedback", "voice-lines", "Great job!"), deps(new CountingTransport()));
    expect(result).toMatchObject({ decision: "coach", reasonCodes: ["tone.hollow_praise"] });
  });

  it("gates a live sentence with deterministic checks only: no model call, no receipt, not degraded", async () => {
    const transport = new CountingTransport();
    const clean = await evaluate(voiceLine("voice_line.live", "voice-lines-live", "Let's count the slices together."), deps(transport));
    expect(clean).toMatchObject({ decision: "allow", reasonCodes: [], uncertain: false, receipt: null, evaluatorBundleRevision: "base-1.2.0" });
    expect(clean.degraded).toBeUndefined();
    expect(clean.route?.classifiers).toEqual([expect.objectContaining({ family: "clef", status: "skipped", skipReason: "profile_disabled" })]);

    const unspoken = await evaluate(voiceLine("voice_line.live", "voice-lines-live", "You ate 3/4 of the pie."), deps(transport));
    expect(unspoken).toMatchObject({ decision: "hold", reasonCodes: ["speakability.unverbalized_math"], receipt: null });
    expect(transport.models).toEqual([]);
  });

  describe("with a speaker profile", () => {
    const withSpeaker = (request: EvaluationRequest, speakerProfile: SpeakerProfile): EvaluationRequest =>
      EvaluationRequest.parse({ ...request, context: { ...request.context, speakerProfile } });
    const coach: SpeakerProfile = { id: "coach.sam", role: "coach", register: "neutral", catchphrases: ["You got this"], forbids: ["sarcasm"] };
    const finn: SpeakerProfile = { id: "character.captain_finn", role: "character", register: "playful", traits: ["pirate_speak"], catchphrases: ["Shiver me timbers"] };

    it("allows an in-character composed line, unchanged from the same request without a profile", async () => {
      const line = voiceLine("voice_line.composed", "voice-lines", "Shiver me timbers, three fourths of the map!\nShiver me timbers, 3/4 of the map!");
      const plain = await evaluate(line, deps(new CountingTransport()));
      const voiced = await evaluate(withSpeaker(line, finn), deps(new CountingTransport()));
      expect(voiced).toMatchObject({ decision: "allow", reasonCodes: [], evaluatorBundleRevision: "base-1.2.0:clef-1.1.0" });
      expect(voiced).toEqual({ ...plain });
    });

    it("coaches an off-voice composed line and never echoes the text or the profile", async () => {
      const text = "Shiver me timbers! Furthermore, we shall dig.\n\nShiver me timbers, therefore we dig.\n\nShiver me timbers, a chest.";
      const result = await evaluate(withSpeaker(voiceLine("voice_line.composed", "voice-lines", text), finn), deps(new CountingTransport()));
      expect(result.decision).toBe("coach");
      expect(result.reasonCodes).toEqual(expect.arrayContaining(["character_voice.register_mismatch", "character_voice.catchphrase_overuse"]));
      expect(result.findings.filter((finding) => finding.evaluatorId === "character-voice-consistency").every((finding) => finding.evaluatorVersion === "1.0.0")).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/timbers|furthermore|captain_finn|pirate_speak/i);
    });

    it("holds a coach's sarcastic feedback line", async () => {
      const result = await evaluate(withSpeaker(voiceLine("voice_line.feedback", "voice-lines", "Yeah, right. As if that was the answer."), coach), deps(new CountingTransport()));
      expect(result.decision).toBe("hold");
      expect(result.reasonCodes).toEqual(expect.arrayContaining(["character_voice.role_sarcasm", "character_voice.forbidden_sarcasm"]));
    });

    it("runs on the live gate without a model call", async () => {
      const transport = new CountingTransport();
      const narrator: SpeakerProfile = { id: "narrator", role: "narrator" };
      const result = await evaluate(withSpeaker(voiceLine("voice_line.live", "voice-lines-live", "I think I see my fox by the river."), narrator), deps(transport));
      expect(result).toMatchObject({ decision: "coach", reasonCodes: ["character_voice.narrator_first_person"], receipt: null, evaluatorBundleRevision: "base-1.2.0" });
      expect(transport.models).toEqual([]);
    });
  });
});
