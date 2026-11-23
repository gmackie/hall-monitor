// Write views (HM-34): revision drafting, diffs and approval on the profiles view, the model gate,
// releases and label review.
import { act, api, h, refresh, state } from "../lib.js";
import { releasesView } from "./releases.js";
import { labelsView } from "./labels.js";

export const extraRoutes = [
  { path: /^\/releases$/, view: releasesView, nav: ["/releases", "Releases"] },
  { path: /^\/labels$/, view: labelsView, nav: ["/labels", "Labels"] },
];

function holds(tenant, role) {
  const me = state.me;
  if (!me) return false;
  if (me.isAdmin) return true;
  return me.grants.some((g) => g.tenant === tenant && g.role === role);
}

function diffSummary(report) {
  if (!report) return "";
  const transitions = Object.entries(report.transitions).map(([t, n]) => `${t}: ${n}`).join(", ");
  return h("div", { class: "panel" },
    h("p", {}, `${report.changed} of ${report.corpus.cases} synthetic case(s) changed decision (classifier: ${report.classifier}).`),
    transitions ? h("p", { class: "mono" }, transitions) : h("p", { class: "muted" }, "No decision changes."),
    h("details", {}, h("summary", {}, "Full report"), h("pre", { class: "mono" }, JSON.stringify(report, null, 2))));
}

/**
 * Actions for one revision row (or, with `revision === null`, the "new draft" form for a profile).
 */
export function revisionActions(tenant, profile, revision) {
  const base = `/tenants/${encodeURIComponent(tenant)}/profiles/${encodeURIComponent(profile.id)}/revisions`;
  const status = h("span", { class: "muted" });
  if (revision === null) {
    if (!holds(tenant, "policy-editor")) return "";
    const overlay = h("textarea", {}, JSON.stringify({ revision: `${tenant}:${profile.id}:1`, outputModeration: "required" }, null, 2));
    const waiver = h("input", { type: "checkbox" });
    return h("details", {}, h("summary", {}, "New draft revision"),
      h("p", { class: "muted" }, "A PolicyOverlay. Fields that weaken the floor are reported and block proposal; the Worker would clamp them anyway."),
      overlay,
      h("div", { class: "row" },
        h("label", {}, h("span", {}, waiver, " Owner waiver for a preview family is recorded (the Worker still needs HM_MODEL_ENFORCE_WAIVERS)")),
        h("button", { onclick: () => act(status, async () => {
          let parsed;
          try { parsed = JSON.parse(overlay.value); } catch { throw new Error("The overlay is not valid JSON."); }
          await api("POST", base, { overlay: parsed, waiverNoted: waiver.checked });
          refresh();
        }) }, "Save draft"), status));
  }
  const path = `${base}/${encodeURIComponent(revision.id)}`;
  const out = h("div", {});
  const button = (label, fn, enabled = true) => h("button", { class: "secondary", disabled: !enabled, onclick: () => act(status, fn) }, label);
  const mine = state.me && revision.author === state.me.email;
  return h("div", {},
    h("div", { class: "row" },
      revision.status === "draft" && holds(tenant, "policy-editor") ? [
        button("Diff", async () => out.replaceChildren(diffSummary(await api("POST", `${path}:diff`)))),
        button("Edit routing", async () => {
          const routing = prompt("Routing JSON, e.g. {\"clairic\":{\"enabled\":true,\"mode\":\"shadow\"}}", JSON.stringify(revision.overlay.routing ?? {}));
          if (routing === null) return;
          await api("PUT", `${path}/routing`, { routing: JSON.parse(routing) });
          refresh();
        }),
        button("Propose", async () => { await api("POST", `${path}:propose`); refresh(); }, revision.violations.length === 0),
      ] : "",
      revision.hasDiff && revision.status !== "draft" ? button("Show diff", async () => out.replaceChildren(diffSummary(await api("GET", `${path}/diff`)))) : "",
      revision.status === "proposed" && holds(tenant, "publisher")
        ? h("button", { class: "secondary", disabled: mine, title: mine ? "Two-person rule: you wrote this revision" : "", onclick: () => act(status, async () => { await api("POST", `${path}:approve`); refresh(); }) }, "Approve")
        : "",
      status),
    out);
}

/** Uploads evidence files and runs the model gate. Nothing is stored. */
export function modelGatePanel() {
  const family = h("select", {}, ["clairic", "clef"].map((f) => h("option", { value: f }, f)));
  const files = {
    calibration: h("input", { type: "file", multiple: true, accept: "application/json" }),
    diff: h("input", { type: "file", accept: "application/json" }),
    baselineReport: h("input", { type: "file", accept: "application/json" }),
    candidateReport: h("input", { type: "file", accept: "application/json" }),
  };
  const enrolled = h("input", { size: 40, placeholder: "@cf/cloudflare/clairic-flash,@cf/cloudflare/clairic" });
  const status = h("span", { class: "muted" });
  const out = h("div", {});
  const read = async (input) => Promise.all([...input.files].map(async (f) => JSON.parse(await f.text())));
  return h("div", {},
    h("h2", {}, "Model gate"),
    h("div", { class: "panel" },
      h("p", { class: "muted" }, "Checks uploaded evidence against config/model-gates.json. The verdict is advisory: enforcing still needs the owner's approval, a routing revision and, for preview models, the Worker waiver."),
      h("div", { class: "row" },
        h("label", {}, "Family", family),
        h("label", {}, "Calibration reports", files.calibration),
        h("label", {}, "Decision diff", files.diff),
        h("label", {}, "Baseline report", files.baselineReport),
        h("label", {}, "Candidate report", files.candidateReport),
        h("label", {}, "Enrolled models", enrolled),
        h("button", { onclick: () => act(status, async () => {
          const [calibration, [diff], [baselineReport], [candidateReport]] = await Promise.all([read(files.calibration), read(files.diff), read(files.baselineReport), read(files.candidateReport)]);
          const verdict = await api("POST", "/models:gate", {
            family: family.value,
            ...(calibration.length ? { calibration } : {}), ...(diff ? { diff } : {}),
            ...(baselineReport ? { baselineReport } : {}), ...(candidateReport ? { candidateReport } : {}),
            ...(enrolled.value.trim() ? { enrolledModels: enrolled.value.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
          });
          out.replaceChildren(h("p", {}, "Verdict: ", h("strong", {}, verdict.verdict), ` (activation: ${verdict.activation})`),
            h("table", {}, h("tbody", {}, verdict.gates.map((g) => h("tr", {}, h("td", {}, g.pass ? "✓" : "✗"), h("td", { class: "mono" }, g.id), h("td", {}, g.detail))))));
        }) }, "Check"), status),
      out));
}
