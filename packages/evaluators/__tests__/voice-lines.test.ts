import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { VOICE_LINES_PROFILE } from "@gmacko/hall-monitor-policy";
import { describe, expect, it } from "vitest";
import {
  canonicalSpokenForm,
  defaultBundle,
  type EvaluatorPlugin,
  kidToneEvaluator,
  runPlugins,
  speakabilityEvaluator,
  spokenAnswerLeakageEvaluator,
  spokenLinesOf,
} from "../src/index.ts";
import { request, type RequestOptions } from "./helpers.ts";

type Band = NonNullable<RequestOptions["gradeBand"]>;

function voiceLine(text: string, options: RequestOptions & { surface?: string } = {}): EvaluationRequest {
  const base = request(text, { kind: "content.candidate", gradeBand: "K-2", ...options });
  return { ...base, source: { ...base.source, product: "playtrek", surface: options.surface ?? "voice_line.composed" } };
}

async function codes(plugin: EvaluatorPlugin, text: string, options: RequestOptions & { surface?: string } = {}): Promise<string[]> {
  const output = await plugin.evaluate(voiceLine(text, options), { profile: VOICE_LINES_PROFILE, signal: new AbortController().signal });
  return output.findings.map((finding) => `${finding.reasonCode}:${finding.severity}`);
}

describe("spokenLinesOf", () => {
  it("takes the first line of each blank-line-separated segment, with offsets", () => {
    const text = "Three fourths of the pie.\n3/4 of the pie.\n\n  Well done!";
    const lines = spokenLinesOf(voiceLine(text))!;
    expect(lines.map((line) => [line.text, text.slice(line.offset, line.offset + line.text.length)])).toEqual([
      ["Three fourths of the pie.", "Three fourths of the pie."],
      ["Well done!", "Well done!"],
    ]);
  });

  it("is null off the voice-line surfaces", () => {
    expect(spokenLinesOf(request("3/4", { kind: "content.candidate" }))).toBeNull();
  });
});

describe("canonicalSpokenForm", () => {
  it.each([
    ["three fourths", "3/4"],
    ["three quarters", "3/4"],
    ["3 / 4", "3/4"],
    ["three over four", "3/4"],
    ["a half", "1/2"],
    ["one half", "1/2"],
    ["twenty-one apples", "21 apples"],
    ["one hundred and five", "105"],
    ["two thousand twenty six", "2026"],
    ["1,250", "1250"],
    ["two point five", "2.5"],
    ["fifty percent", "50%"],
    ["50%", "50%"],
    ["negative three", "-3"],
    ["one two three", "1 2 3"],
    ["tres cuartos", "3/4"],
    ["treinta y dos", "32"],
    ["doscientas cuarenta", "240"],
    ["veinticinco por ciento", "25%"],
    ["dos punto cinco", "2.5"],
    ["Once upon a time", "once upon a time"],
  ])("%s → %s", (input, expected) => {
    expect(canonicalSpokenForm(input)).toBe(expected);
  });
});

describe("speakability", () => {
  it("passes a short, plain K-2 line", async () => {
    expect(await codes(speakabilityEvaluator, "You found three fourths of the pie. Nice counting!")).toEqual([]);
  });

  it("holds written math left in the spoken form, and coaches digits and symbols", async () => {
    expect(await codes(speakabilityEvaluator, "You ate 3/4 of the pie.")).toEqual(["speakability.unverbalized_math:hold"]);
    expect(await codes(speakabilityEvaluator, "So x = 7 here.")).toEqual(["speakability.unverbalized_math:hold"]);
    expect(await codes(speakabilityEvaluator, "That is 50% of it.")).toEqual(["speakability.unverbalized_math:hold"]);
    expect(await codes(speakabilityEvaluator, "Pick door 3 next.")).toEqual(["speakability.unverbalized_symbols:warn"]);
    expect(await codes(speakabilityEvaluator, "Sam & Max went home.")).toEqual(["speakability.unverbalized_symbols:warn"]);
  });

  it("ignores digits in a caption line that is not spoken", async () => {
    expect(await codes(speakabilityEvaluator, "You ate three fourths of the pie.\nYou ate 3/4 of the pie.")).toEqual([]);
  });

  it("scales sentence length to the grade band, strictest for K-2", async () => {
    const fifteen = "The little fox ran down the long hill and over the bridge to find her friend.";
    expect(await codes(speakabilityEvaluator, fifteen, { gradeBand: "K-2" })).toEqual(["speakability.sentence_too_long:warn"]);
    expect(await codes(speakabilityEvaluator, fifteen, { gradeBand: "3-5" })).toEqual([]);
    const thirty = `${fifteen} ${fifteen}`.replace(". The", " and then the");
    expect(await codes(speakabilityEvaluator, thirty, { gradeBand: "K-2" })).toEqual(["speakability.sentence_too_long:hold"]);
    const bands: Band[] = ["6-8", "9-12", "adult"];
    for (const band of bands) expect(await codes(speakabilityEvaluator, fifteen, { gradeBand: band })).toEqual([]);
  });

  it("flags stacked clauses", async () => {
    expect(await codes(speakabilityEvaluator, "If it rains, which it may, we stay, because mud is slick.")).toEqual(["speakability.stacked_clauses:warn"]);
    expect(await codes(speakabilityEvaluator, "If it rains, we stay inside.")).toEqual([]);
  });

  it("flags tongue twisters but not ordinary alliteration", async () => {
    expect(await codes(speakabilityEvaluator, "Peter picked plenty pickled peppers.")).toEqual(["speakability.tongue_twister:warn"]);
    expect(await codes(speakabilityEvaluator, "Big bears like to play.")).toEqual([]);
  });

  it("flags shouting but not a short acronym", async () => {
    expect(await codes(speakabilityEvaluator, "That is AMAZING work.")).toEqual(["speakability.all_caps:warn"]);
    expect(await codes(speakabilityEvaluator, "GOOD JOB today.")).toEqual(["speakability.all_caps:warn"]);
    expect(await codes(speakabilityEvaluator, "We went to the USA.")).toEqual([]);
  });

  it("flags ellipsis abuse but allows one pause", async () => {
    expect(await codes(speakabilityEvaluator, "And then... it moved.")).toEqual([]);
    expect(await codes(speakabilityEvaluator, "And then...... it moved.")).toEqual(["speakability.ellipsis_overuse:warn"]);
    expect(await codes(speakabilityEvaluator, "So... um... well... yes.")).toEqual(["speakability.ellipsis_overuse:warn"]);
  });

  it("handles Spanish lines", async () => {
    expect(await codes(speakabilityEvaluator, "¡Muy bien! Encontraste tres cuartos del pastel.")).toEqual([]);
    expect(await codes(speakabilityEvaluator, "Comiste 3/4 del pastel.")).toEqual(["speakability.unverbalized_math:hold"]);
  });

  it("locates the finding in the original text", async () => {
    const text = "Hello there.\n\nYou ate 3/4 of it.";
    const output = await speakabilityEvaluator.evaluate(voiceLine(text), { profile: VOICE_LINES_PROFILE, signal: new AbortController().signal });
    const span = output.findings[0]!.span!;
    expect(text.slice(span.start, span.end)).toBe("3/4");
  });

  it("does nothing off the voice-line surfaces", async () => {
    expect(await codes(speakabilityEvaluator, "You ate 3/4 of the pie.", { surface: "student.chat" })).toEqual([]);
  });
});

describe("spoken answer leakage", () => {
  it("holds an answer said in words", async () => {
    expect(await codes(spokenAnswerLeakageEvaluator, "The answer is three fourths!", { answerKey: ["3/4"] })).toEqual([
      "academic_integrity.spoken_answer_leakage:hold",
    ]);
    expect(await codes(spokenAnswerLeakageEvaluator, "That makes twenty-one apples.", { answerKey: ["21 apples"] })).toEqual([
      "academic_integrity.spoken_answer_leakage:hold",
    ]);
    expect(await codes(spokenAnswerLeakageEvaluator, "La respuesta es tres cuartos.", { answerKey: ["3/4"] })).toEqual([
      "academic_integrity.spoken_answer_leakage:hold",
    ]);
    expect(await codes(spokenAnswerLeakageEvaluator, "It is 42 now.", { answerKey: ["forty-two"] })).toEqual([
      "academic_integrity.spoken_answer_leakage:hold",
    ]);
  });

  it("does not match other numbers, ambiguous keys or the caption", async () => {
    expect(await codes(spokenAnswerLeakageEvaluator, "You have three fifths so far.", { answerKey: ["3/4"] })).toEqual([]);
    expect(await codes(spokenAnswerLeakageEvaluator, "Thirty-four is close.", { answerKey: ["3/4"] })).toEqual([]);
    expect(await codes(spokenAnswerLeakageEvaluator, "Pick four.", { answerKey: ["4"] })).toEqual([]);
    expect(await codes(spokenAnswerLeakageEvaluator, "How much pie is left?\nAnswer: 3/4", { answerKey: ["3/4"] })).toEqual([]);
    expect(await codes(spokenAnswerLeakageEvaluator, "The answer is three fourths!")).toEqual([]);
  });
});

describe("kid tone", () => {
  it.each([
    ["Wrong again. Try harder.", "tone.shaming:hold"],
    ["You should know this by now.", "tone.shaming:hold"],
    ["Even a baby could count that.", "tone.shaming:hold"],
    ["Otra vez mal. Deberías saber esto.", "tone.shaming:hold"],
    ["Hurry up or you'll lose everything.", "tone.menacing:hold"],
    ["Answer now, or else.", "tone.menacing:hold"],
    ["Apúrate o te vas a quedar solo.", "tone.menacing:hold"],
    ["Wow, genius. Nice try... not.", "tone.sarcasm:warn"],
    ["Time is running out! Last chance!", "tone.anxiety_pressure:warn"],
    ["Se acaba el tiempo.", "tone.anxiety_pressure:warn"],
    ["You're so smart!", "tone.hollow_praise:warn"],
    ["Great job, but that's wrong.", "tone.hollow_praise:warn"],
  ])("%s → %s", async (text, expected) => {
    expect(await codes(kidToneEvaluator, text)).toContain(expected);
  });

  it.each([
    "Not quite. Let's count the slices together.",
    "You kept trying, and you counted every slice. That's how we learn!",
    "The dragon roared, \"Hurry, the bridge is falling!\"",
    "Casi. Vamos a contarlo juntos.",
    "Once upon a time, a fox found a pie.",
  ])("allows %s", async (text) => {
    expect(await codes(kidToneEvaluator, text)).toEqual([]);
  });

  it("coaches a stock compliment only on feedback lines", async () => {
    expect(await codes(kidToneEvaluator, "Great job!", { surface: "voice_line.feedback" })).toEqual(["tone.hollow_praise:warn"]);
    expect(await codes(kidToneEvaluator, "¡Perfecto!", { surface: "voice_line.feedback" })).toEqual(["tone.hollow_praise:warn"]);
    expect(await codes(kidToneEvaluator, "Great job! You split the pie into four equal parts.", { surface: "voice_line.feedback" })).toEqual([]);
    expect(await codes(kidToneEvaluator, "Great job!", { surface: "voice_line.composed" })).toEqual([]);
  });

  it("does nothing off the voice-line surfaces", async () => {
    expect(await codes(kidToneEvaluator, "Wrong again.", { surface: "student.chat" })).toEqual([]);
  });
});

describe("the default bundle on voice lines", () => {
  it("runs the voice-line evaluators and leaves other surfaces untouched", async () => {
    const context = { profile: VOICE_LINES_PROFILE, signal: new AbortController().signal };
    const spoken = await runPlugins(defaultBundle.plugins, voiceLine("Wrong again! You ate 3/4.", { answerKey: ["3/4"] }), context);
    expect(spoken.findings.map((finding) => finding.evaluatorId).sort()).toEqual(["answer-leakage", "kid-tone", "speakability", "spoken-answer-leakage"]);
    const chat = await runPlugins(defaultBundle.plugins, request("Wrong again! You ate 3/4.", { kind: "content.candidate", answerKey: ["3/4"] }), context);
    expect(chat.findings.map((finding) => finding.evaluatorId)).toEqual(["answer-leakage"]);
  });

  it("never echoes the text in findings", async () => {
    const context = { profile: VOICE_LINES_PROFILE, signal: new AbortController().signal };
    const output = await runPlugins(defaultBundle.plugins, voiceLine("Wrong again, Zorblax! The answer is three fourths.", { answerKey: ["3/4"] }), context);
    expect(output.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(output.findings)).not.toMatch(/zorblax|fourths|wrong/i);
  });
});
