import type { EvaluationRequest, SpeakerProfile } from "@gmacko/hall-monitor-contracts";
import { VOICE_LINES_LIVE_PROFILE, VOICE_LINES_PROFILE } from "@gmacko/hall-monitor-policy";
import { describe, expect, it } from "vitest";
import { characterVoiceEvaluator, defaultBundle, EVALUATOR_BUNDLE_REVISION } from "../src/index.ts";
import { request } from "./helpers.ts";

function voiceLine(text: string, speakerProfile?: SpeakerProfile, surface = "voice_line.composed"): EvaluationRequest {
  const base = request(text, { kind: "content.candidate", gradeBand: "3-5" });
  return {
    ...base,
    source: { ...base.source, product: "playtrek", surface },
    context: { ...base.context, ...(speakerProfile === undefined ? {} : { speakerProfile }) },
  };
}

async function codes(text: string, speakerProfile?: SpeakerProfile, surface?: string): Promise<string[]> {
  const output = await characterVoiceEvaluator.evaluate(voiceLine(text, speakerProfile, surface), {
    profile: surface === "voice_line.live" ? VOICE_LINES_LIVE_PROFILE : VOICE_LINES_PROFILE,
    signal: new AbortController().signal,
  });
  expect(output.attempts).toEqual([]);
  return output.findings.map((finding) => `${finding.reasonCode}:${finding.severity}`);
}

const narrator: SpeakerProfile = { id: "narrator", role: "narrator", register: "neutral" };
const teacher: SpeakerProfile = { id: "teacher.ms_lee", role: "teacher", register: "formal" };
const coach: SpeakerProfile = { id: "coach.sam", role: "coach", register: "casual" };
const pirate: SpeakerProfile = { id: "character.captain_finn", role: "character", register: "playful", traits: ["silly", "pirate_speak"] };

describe("character-voice-consistency: scope", () => {
  it("does nothing without a speaker profile, so existing requests are unchanged", async () => {
    expect(await codes("Yeah dude, gonna be SO EPIC!!! Oh great, another genius.")).toEqual([]);
  });

  it("does nothing off the voice-line surfaces, even with a profile", async () => {
    const base = request("Oh great, another genius. Gonna be lit!!", { kind: "content.candidate" });
    const off = { ...base, context: { ...base.context, speakerProfile: teacher } };
    const output = await characterVoiceEvaluator.evaluate(off, { profile: VOICE_LINES_PROFILE, signal: new AbortController().signal });
    expect(output.findings).toEqual([]);
  });

  it("runs on every voice-line surface, live included", async () => {
    for (const surface of ["voice_line.composed", "voice_line.feedback", "voice_line.live"]) {
      expect(await codes("Yeah, right. Nice try, genius.", coach, surface), surface).toContain("character_voice.role_sarcasm:hold");
    }
  });

  it("reads only the spoken line, not the caption", async () => {
    expect(await codes("Look at the map.\nLOOK AT THE MAP!!!", { ...teacher, forbids: ["all_caps", "exclamation_spam"] })).toEqual([]);
  });

  it("never echoes the text or the profile in findings", async () => {
    const output = await characterVoiceEvaluator.evaluate(voiceLine("Gonna be totally rad, dude!!", { ...teacher, catchphrases: ["Steady now"] }), {
      profile: VOICE_LINES_PROFILE,
      signal: new AbortController().signal,
    });
    expect(output.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(output.findings)).not.toMatch(/gonna|dude|steady|ms_lee/i);
  });
});

describe("character-voice-consistency: register", () => {
  it("coaches slang, dense contractions or exclamations from a formal speaker", async () => {
    expect(await codes("Gonna look at the map now.", teacher)).toEqual(["character_voice.register_mismatch:warn"]);
    expect(await codes("Don't worry, we're close, it's fine.", teacher)).toEqual(["character_voice.register_mismatch:warn"]);
    expect(await codes("Look! The map! Here!", teacher)).toEqual(["character_voice.register_mismatch:warn"]);
    expect(await codes("Vamos, porfa, mira el mapa.", teacher)).toEqual(["character_voice.register_mismatch:warn"]);
  });

  it("allows a formal speaker's plain line, with the odd contraction", async () => {
    expect(await codes("Let us look at the map together. The river runs north, and it's very long.", teacher)).toEqual([]);
    expect(await codes("Miremos el mapa juntos. El río corre hacia el norte.", teacher)).toEqual([]);
  });

  it("coaches a neutral speaker only for repeated slang or heavy exclamation", async () => {
    expect(await codes("Yeah, the fox went home.", narrator)).toEqual([]);
    expect(await codes("Yeah, the fox was gonna go home.", narrator)).toEqual(["character_voice.register_mismatch:warn"]);
    expect(await codes("The fox ran home!!", narrator)).toEqual(["character_voice.register_mismatch:warn"]);
  });

  it("coaches very formal phrasing from a playful speaker", async () => {
    expect(await codes("Furthermore, the treasure is buried; therefore, we shall dig.", pirate)).toEqual(["character_voice.register_mismatch:warn"]);
    expect(await codes("No obstante, el tesoro está enterrado; por lo tanto, cavamos.", pirate)).toEqual(["character_voice.register_mismatch:warn"]);
    expect(await codes("Arr, let's dig for treasure, matey! Therefore we dig!", pirate)).toEqual([]);
  });

  it("leaves casual and unspecified registers alone", async () => {
    expect(await codes("Yeah, gonna dig, dude!", { id: "character.pip", role: "character", register: "casual" })).toEqual([]);
    expect(await codes("Yeah, gonna dig, dude!", { id: "character.pip", role: "character" })).toEqual([]);
  });
});

describe("character-voice-consistency: forbids", () => {
  const forbids = (...codes: string[]): SpeakerProfile => ({ id: "character.owl", role: "character", register: "casual", forbids: codes });

  it("coaches forbidden slang, in English and Spanish", async () => {
    expect(await codes("Dude, that owl is wise.", forbids("slang"))).toEqual(["character_voice.forbidden_slang:warn"]);
    expect(await codes("¡Qué onda! El búho es sabio.", forbids("slang"))).toEqual(["character_voice.forbidden_slang:warn"]);
    expect(await codes("The owl is wise.", forbids("slang"))).toEqual([]);
  });

  it("coaches forbidden sarcasm for a character, which may otherwise be sarcastic", async () => {
    expect(await codes("Oh great, another puddle.", forbids("sarcasm"))).toEqual(["character_voice.forbidden_sarcasm:warn"]);
    expect(await codes("Sí, claro, como si fuera fácil.", forbids("sarcasm"))).toEqual(["character_voice.forbidden_sarcasm:warn"]);
    expect(await codes("Oh great, another puddle.", forbids())).toEqual([]);
    expect(await codes("Great, let's jump the puddle.", forbids("sarcasm"))).toEqual([]);
  });

  it("coaches forbidden exclamation spam with a span", async () => {
    const output = await characterVoiceEvaluator.evaluate(voiceLine("We found it!!", forbids("exclamation_spam")), {
      profile: VOICE_LINES_PROFILE,
      signal: new AbortController().signal,
    });
    expect(output.findings).toEqual([expect.objectContaining({ reasonCode: "character_voice.forbidden_exclamation_spam", severity: "warn", span: { start: 11, end: 13 } })]);
    expect(await codes("Yes! We! Found! It!", forbids("exclamation_spam"))).toEqual(["character_voice.forbidden_exclamation_spam:warn"]);
    expect(await codes("We found it! Let's go.", forbids("exclamation_spam"))).toEqual([]);
  });

  it("coaches forbidden capitals but not a short acronym", async () => {
    expect(await codes("That is HUGE.", forbids("all_caps"))).toEqual(["character_voice.forbidden_all_caps:warn"]);
    expect(await codes("We flew over the USA.", forbids("all_caps"))).toEqual([]);
  });

  it("ignores forbid codes it does not know", async () => {
    expect(await codes("Dude, oh great, HUGE!!", forbids("puns", "rhymes"))).toEqual([]);
  });
});

describe("character-voice-consistency: role rules", () => {
  it("holds sarcasm or teasing from a teacher or coach", async () => {
    expect(await codes("Wow, genius. Nice try, not even close.", coach)).toContain("character_voice.role_sarcasm:hold");
    expect(await codes("Too slow, slowpoke.", coach)).toEqual(["character_voice.role_sarcasm:hold"]);
    expect(await codes("Yeah, right. As if that works.", teacher)).toContain("character_voice.role_sarcasm:hold");
    expect(await codes("Jaja, te equivocaste. Te lo dije.", { ...coach, register: undefined })).toEqual(["character_voice.role_sarcasm:hold"]);
  });

  it("coaches sarcasm from a narrator and allows it from a character", async () => {
    expect(await codes("What a surprise, the fox was late again.", narrator)).toEqual(["character_voice.role_sarcasm:warn"]);
    expect(await codes("What a surprise, the fox was late again.", { id: "character.crow", role: "character" })).toEqual([]);
  });

  it("allows warm lines from every role", async () => {
    for (const speaker of [teacher, coach, narrator]) {
      expect(await codes("Good thinking. Let us try the next one together.", speaker), speaker.id).toEqual([]);
    }
  });

  it("coaches a narrator speaking in the first person, outside quoted dialogue", async () => {
    expect(await codes("I think the fox was hungry, so I followed me to my den.", narrator)).toEqual(["character_voice.narrator_first_person:warn"]);
    expect(await codes("Yo creo que el zorro tenía hambre, y mi casa estaba lejos.", narrator)).toEqual(["character_voice.narrator_first_person:warn"]);
    expect(await codes("The fox said, \"I am hungry, give me my lunch.\" Then she ran home.", narrator)).toEqual([]);
    expect(await codes("The fox said, “I am hungry, feed me.” She ran home.", narrator)).toEqual([]);
    expect(await codes("The fox ran home to her den.", narrator)).toEqual([]);
    // Other roles may say "I".
    expect(await codes("I think my map is right here, follow me.", { id: "coach.sam", role: "coach" })).toEqual([]);
  });
});

describe("character-voice-consistency: catchphrases", () => {
  const finn: SpeakerProfile = { ...pirate, catchphrases: ["Shiver me timbers", "¡Al abordaje!"] };

  it("coaches a catchphrase used more than twice in a chunk, across lines and punctuation", async () => {
    const text = "Shiver me timbers! A map.\n\nShiver me timbers, a key.\n\nShiver me timbers... treasure!";
    expect(await codes(text, finn)).toEqual(["character_voice.catchphrase_overuse:warn"]);
    expect(await codes("¡Al abordaje! Uno.\n\n¡Al abordaje! Dos.\n\nAl abordaje, tres.", finn)).toEqual(["character_voice.catchphrase_overuse:warn"]);
  });

  it("allows a catchphrase twice", async () => {
    expect(await codes("Shiver me timbers! A map.\n\nShiver me timbers, a key.", finn)).toEqual([]);
  });

  it("counts only the spoken lines", async () => {
    expect(await codes("Shiver me timbers!\nShiver me timbers! Shiver me timbers!", finn)).toEqual([]);
  });
});

describe("character-voice-consistency: wiring", () => {
  it("ships in the default bundle under base-1.2.0", () => {
    expect(EVALUATOR_BUNDLE_REVISION).toBe("base-1.2.0");
    expect(defaultBundle.plugins.map((plugin) => plugin.id)).toContain("character-voice-consistency");
    expect(characterVoiceEvaluator.supportedKinds).toEqual(["content.candidate", "interaction.output"]);
  });
});
