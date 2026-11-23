// Label review: blinded labelling, adjudication, predictions import and calibration scoring.
// Label sets hold synthetic or licensed text only.
import { act, api, h, refresh, state, tenantPicker } from "../lib.js";

const LABELS = ["positive", "negative", "ambiguous"];

function itemCard(setPath, item, mode) {
  const status = h("span", { class: "muted" });
  const choices = item.decisions.map((d) => ({ d, select: h("select", {}, h("option", { value: "" }, "—"), LABELS.map((l) => h("option", { value: l }, l))) }));
  return h("div", { class: "panel" },
    h("p", { class: "muted mono" }, `${item.blindId} · ${item.cohort.profileId} · ${item.cohort.gradeBand} · ${item.cohort.evaluationKind}`),
    h("pre", {}, item.content.type === "text" ? item.content.text : `[image ${item.content.assetRef}] ${item.content.text ?? ""}`),
    h("table", {}, h("tbody", {}, choices.map(({ d, select }) => h("tr", {},
      h("td", { class: "mono" }, d.id), h("td", {}, d.instructions),
      mode === "adjudicate" ? h("td", { class: "mono" }, Object.entries(item.counts).map(([k, v]) => `${k} ${v}`).join(", ")) : "",
      h("td", {}, select))))),
    h("div", { class: "row" }, h("button", { onclick: () => act(status, async () => {
      const picked = choices.filter((c) => c.select.value);
      if (!picked.length) throw new Error("Pick at least one label.");
      if (mode === "adjudicate") {
        for (const c of picked) await api("POST", `${setPath}/items/${encodeURIComponent(item.blindId)}/adjudication`, { decisionId: c.d.id, label: c.select.value });
      } else {
        await api("POST", `${setPath}/items/${encodeURIComponent(item.blindId)}/labels`, { labels: picked.map((c) => ({ decisionId: c.d.id, label: c.select.value })) });
      }
      refresh();
    }) }, mode === "adjudicate" ? "Record adjudication" : "Save labels"), status));
}

export async function labelsView() {
  const root = h("div", {});
  const picker = tenantPicker(() => load());
  const body = h("div", {});

  async function load() {
    const tenant = picker.element.querySelector("select").value;
    if (!tenant) return body.replaceChildren(h("p", { class: "muted" }, "You have no tenants to view."));
    const tenantPath = `/tenants/${encodeURIComponent(tenant)}/label-sets`;
    const { labelSets } = await api("GET", tenantPath);
    const setId = new URLSearchParams(location.search).get("set") ?? labelSets[0]?.id;
    const status = h("span", { class: "muted" });
    const importer = state.me?.isAdmin ? (() => {
      const file = h("input", { type: "file", accept: "application/json" });
      return h("details", { class: "panel" }, h("summary", {}, "Import a calibration study (admin)"),
        h("p", { class: "muted" }, "Synthetic or licensed cases only. The study is frozen and blinded here; the key stays in D1. Create one with pnpm calibration init."),
        h("div", { class: "row" }, file, h("button", { onclick: () => act(status, async () => {
          const study = JSON.parse(await file.files[0].text());
          await api("POST", tenantPath, { study });
          refresh();
        }) }, "Import"), status));
    })() : "";
    const sets = h("div", { class: "panel" }, labelSets.length ? h("table", {},
      h("thead", {}, h("tr", {}, ["Set", "Family", "Items", "Labels", "Adjudications", "Created"].map((t) => h("th", {}, t)))),
      h("tbody", {}, labelSets.map((s) => h("tr", { class: "clickable", onclick: () => { const p = new URLSearchParams(location.search); p.set("set", s.id); history.replaceState(null, "", `?${p}`); load(); } },
        h("td", { class: "mono" }, s.id, s.id === setId ? " ◀" : ""), h("td", {}, s.family), h("td", {}, s.items), h("td", {}, s.labels), h("td", {}, s.adjudications), h("td", { class: "mono" }, s.createdAt.slice(0, 10)))))) : h("p", { class: "muted" }, "No label sets."));
    const parts = [importer, sets];
    if (setId) {
      const setPath = `${tenantPath}/${encodeURIComponent(setId)}`;
      const roles = (role) => state.me?.isAdmin || state.me?.grants.some((g) => g.tenant === tenant && g.role === role);
      if (roles("labeler")) {
        const queue = await api("GET", `${setPath}/queue`);
        parts.push(h("h2", {}, `Labelling queue (${queue.remaining} left)`), h("p", { class: "muted" }, "Blinded: no source ids, splits, other reviewers' labels or model scores. Label independently."),
          ...queue.items.slice(0, 5).map((item) => itemCard(setPath, item, "label")));
      }
      if (roles("adjudicator")) {
        const queue = await api("GET", `${setPath}/adjudication-queue`);
        const predictions = h("input", { type: "file", accept: "application/json" });
        const scoreStatus = h("span", { class: "muted" });
        const reports = await api("GET", `${setPath}/calibration-reports`);
        parts.push(h("h2", {}, `Adjudication queue (${queue.remaining})`), h("p", { class: "muted" }, "Items you labelled are excluded."),
          ...queue.items.slice(0, 5).map((item) => itemCard(setPath, item, "adjudicate")),
          h("h2", {}, "Score"),
          h("div", { class: "panel" },
            h("div", { class: "row" }, h("label", {}, "Predictions JSON {run, predictions}", predictions),
              h("button", { class: "secondary", onclick: () => act(scoreStatus, async () => { await api("POST", `${setPath}/predictions`, JSON.parse(await predictions.files[0].text())); }) }, "Import predictions"),
              h("button", { onclick: () => act(scoreStatus, async () => { await api("POST", `${setPath}:score`); refresh(); }) }, "Score held-out cases"),
              h("button", { disabled: true, title: "Calibration activation requires a Worker change (HM-8)" }, "Promote calibration"),
              scoreStatus),
            h("p", { class: "muted" }, "Calibration activation requires a Worker change (HM-8). Reports are candidates only (activation: not-approved)."),
            reports.reports.map((r) => h("details", {}, h("summary", { class: "mono" }, `${r.id} · ${r.report.modelId} · ${r.createdAt.slice(0, 19)}`),
              h("table", {}, h("thead", {}, h("tr", {}, ["Decision", "Cohort", "Adjudicated", "Precision (95% low)", "FPR (95% high)"].map((t) => h("th", {}, t)))),
                h("tbody", {}, r.report.metrics.map((m) => h("tr", {}, h("td", { class: "mono" }, m.decisionId), h("td", { class: "mono" }, `${m.cohort.profileId}:${m.cohort.gradeBand}`),
                  h("td", {}, m.adjudicated), h("td", {}, m.precision.lower95?.toFixed(3) ?? "—"), h("td", {}, m.falsePositiveRate.upper95?.toFixed(3) ?? "—"))))))),
          ));
      }
    }
    body.replaceChildren(...parts);
  }

  root.append(h("h1", {}, "Labels"), h("div", { class: "panel row" }, picker.element), body);
  load().catch((error) => body.replaceChildren(h("p", { class: "error" }, error.message)));
  return root;
}
