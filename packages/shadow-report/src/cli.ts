import { basename } from "node:path";
import { parseArgs } from "node:util";
import { BUILTIN_CASES, type CaseSet, parseCasesJsonl, selectCases } from "./cases.ts";
import { type ClassifierChoice, gatewayClassifier } from "./classifier.ts";
import { diffDecisions } from "./diff.ts";
import { renderDiffMarkdown, renderShadowMarkdown } from "./markdown.ts";
import { DecisionDiffReport, ShadowReport } from "./report.ts";
import { runShadowReport } from "./run.ts";
import { BUILTIN_VARIANT, overlayVariant, type PolicyVariant } from "./variant.ts";

/** The file system and streams the CLI uses, injectable for tests. */
export interface CliIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Usage text. */
export const USAGE = `Usage:
  pnpm shadow-report [run] [options]            Shadow-run a synthetic corpus and report
  pnpm shadow-report diff --candidate <file>    Decision diff between two policy variants
  pnpm shadow-report render <report.json>       Render a saved report as Markdown

Options:
  --profile <id>         Only cases evaluated under this profile (repeatable)
  --cases <file.jsonl>   Synthetic cases (every line needs "synthetic": true); default: built-in corpus
  --policy <file.json>   Overlays by profile id for the run (default: built-in profiles)
  --baseline <file.json> diff: baseline overlays (default: built-in profiles)
  --candidate <file.json> diff: candidate overlays (required)
  --classifier <kind>    fake (default) | none | gateway (billed; needs HM_CF_ACCOUNT_ID,
                         HM_AI_GATEWAY_ID and HM_CF_API_TOKEN)
  --include-text         Copy synthetic text of mismatched/changed cases into the report
  --out <file.json>      Write the JSON report
  --markdown <file.md>   Write the Markdown report (default: print it)
`;

/** Runs the CLI and returns its exit code. Errors are reported without echoing file contents. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArguments(argv);
    if (values.help === true) {
      io.stdout(USAGE);
      return 0;
    }
    const [command = "run", ...rest] = positionals;

    if (command === "render") {
      if (rest.length !== 1) throw new UsageError("render takes one report file");
      let document: { kind?: unknown };
      try {
        document = JSON.parse(await io.readFile(rest[0]!)) as { kind?: unknown };
      } catch {
        throw new Error(`${basename(rest[0]!)} is not a readable JSON report`);
      }
      io.stdout(document.kind === "decision-diff" ? renderDiffMarkdown(DecisionDiffReport.parse(document)) : renderShadowMarkdown(ShadowReport.parse(document)));
      return 0;
    }
    if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);

    const set = selectCases(await loadCases(values.cases, io), values.profile ?? []);
    if (set.cases.length === 0) throw new UsageError("no cases match the selected profiles");
    const classifier = classifierFrom(values.classifier, io.env);
    const includeText = values["include-text"] === true;

    let json: unknown;
    let markdown: string;
    if (command === "run") {
      const variant = values.policy === undefined ? BUILTIN_VARIANT : await loadVariant("policy", values.policy, io);
      const report = await runShadowReport(set, { variant, classifier, includeText });
      json = report;
      markdown = renderShadowMarkdown(report);
    } else if (command === "diff") {
      if (values.candidate === undefined) throw new UsageError("diff needs --candidate");
      const baseline = values.baseline === undefined ? BUILTIN_VARIANT : await loadVariant("baseline", values.baseline, io);
      const candidate = await loadVariant("candidate", values.candidate, io);
      const report = await diffDecisions(set, baseline, candidate, { classifier, includeText });
      json = report;
      markdown = renderDiffMarkdown(report);
    } else {
      throw new UsageError(`unknown command: ${command}`);
    }

    if (values.out !== undefined) await io.writeFile(values.out, JSON.stringify(json, null, 2) + "\n");
    if (values.markdown !== undefined) await io.writeFile(values.markdown, markdown);
    else io.stdout(markdown);
    return 0;
  } catch (error) {
    io.stderr(`shadow-report: ${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof UsageError) io.stderr(USAGE);
    return error instanceof UsageError ? 2 : 1;
  }
}

class UsageError extends Error {
  override readonly name = "UsageError";
}

const OPTIONS = {
  profile: { type: "string", multiple: true },
  cases: { type: "string" },
  policy: { type: "string" },
  baseline: { type: "string" },
  candidate: { type: "string" },
  classifier: { type: "string" },
  "include-text": { type: "boolean" },
  out: { type: "string" },
  markdown: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function parseArguments(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], allowPositionals: true, options: OPTIONS });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
}

async function loadCases(path: string | undefined, io: CliIo): Promise<CaseSet> {
  if (path === undefined) return BUILTIN_CASES;
  return parseCasesJsonl(basename(path), await io.readFile(path));
}

async function loadVariant(label: string, path: string, io: CliIo): Promise<PolicyVariant> {
  let overlays: unknown;
  try {
    overlays = JSON.parse(await io.readFile(path));
  } catch (error) {
    throw new Error(`${label} file ${basename(path)} is not readable JSON${error instanceof Error && "code" in error ? ` (${String(error.code)})` : ""}`);
  }
  return overlayVariant(`${label}:${basename(path)}`, overlays);
}

function classifierFrom(kind: string | undefined, env: CliIo["env"]): ClassifierChoice {
  switch (kind ?? "fake") {
    case "none":
      return { kind: "none" };
    case "fake":
      return { kind: "fake" };
    case "gateway": {
      const accountId = env.HM_CF_ACCOUNT_ID;
      const gatewayId = env.HM_AI_GATEWAY_ID;
      const token = env.HM_CF_API_TOKEN;
      if (!accountId || !gatewayId || !token) throw new UsageError("--classifier gateway needs HM_CF_ACCOUNT_ID, HM_AI_GATEWAY_ID and HM_CF_API_TOKEN");
      return gatewayClassifier({ accountId, gatewayId, token });
    }
    default:
      throw new UsageError(`unknown classifier: ${kind}`);
  }
}
