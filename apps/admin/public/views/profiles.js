// Policy profiles: built-in floors, the tenant's published overlay, the effective profile and the
// revision history. HM-34 adds drafting, diffs and approval through revisionActions.
import { api, h, tenantPicker } from "../lib.js";
import { revisionActions } from "./extra.js";

function pretty(value) {
  return h("pre", { class: "mono" }, JSON.stringify(value, null, 2));
}

function routingSummary(profile) {
  const routing = profile.routing ?? {};
  const families = ["clef", "clairic"].map((family) => {
    const r = routing[family];
    if (!r) return `${family}: ${family === "clef" ? "on, enforce (default)" : "off (default)"}`;
    return `${family}: ${r.enabled ? "on" : "off"}, ${r.mode ?? "enforce"}${r.kinds ? ` [${r.kinds.join(", ")}]` : ""}`;
  });
  return families.join(" · ");
}

export async function profilesView() {
  const root = h("div", {});
  const picker = tenantPicker(() => load());
  const body = h("div", {});

  async function load() {
    const tenant = picker.element.querySelector("select").value;
    if (!tenant) {
      body.replaceChildren(h("p", { class: "muted" }, "You have no tenants to view."));
      return;
    }
    body.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    const { profiles } = await api("GET", `/tenants/${encodeURIComponent(tenant)}/profiles`);
    const sections = await Promise.all(profiles.map(async (p) => {
      const { revisions } = await api("GET", `/tenants/${encodeURIComponent(tenant)}/profiles/${encodeURIComponent(p.id)}/revisions`);
      return h("div", { class: "panel" },
        h("h2", {}, p.id, " ", h("span", { class: "muted" }, p.published ? `published ${p.published.revision}` : `floor ${p.floorRevision}`)),
        h("p", {}, p.effective.studentFacing ? h("span", { class: "badge d-hold" }, "student-facing") : "", " ",
          `input ${p.effective.inputModeration} · output ${p.effective.outputModeration} · answers ${p.effective.answerAssistance} · classifier unavailable → ${p.effective.failureMode.classifierUnavailable}`),
        h("p", { class: "mono" }, routingSummary(p.effective)),
        h("details", {}, h("summary", {}, "Floor and effective profile"), h("div", { class: "row" }, h("div", {}, h("h3", {}, "Floor"), pretty(p.floor)), h("div", {}, h("h3", {}, "Effective"), pretty(p.effective)))),
        revisions.length ? h("table", {},
          h("thead", {}, h("tr", {}, ["Revision", "Status", "Author", "Approver", "Flags", "Violations", ""].map((t) => h("th", {}, t)))),
          h("tbody", {}, revisions.map((r) => h("tr", {},
            h("td", { class: "mono" }, r.revision),
            h("td", {}, r.status),
            h("td", {}, r.author),
            h("td", {}, r.approver ?? "—"),
            h("td", {}, [r.studentFacing ? "student-facing" : "", r.enforcesFamily ? "enforces a family" : "", r.waiverNoted ? "waiver noted" : ""].filter(Boolean).join(", ") || "—"),
            h("td", { class: r.violations.length ? "error" : "" }, r.violations.length ? r.violations.map((v) => `${v.field}: ${v.requested} weakens ${v.floor}`).join("; ") : "none"),
            h("td", {}, revisionActions ? revisionActions(tenant, p, r) : ""),
          )))) : h("p", { class: "muted" }, "No revisions."),
        revisionActions ? revisionActions(tenant, p, null) : "",
      );
    }));
    body.replaceChildren(...sections);
  }

  root.append(h("h1", {}, "Policy profiles"),
    h("p", { class: "muted" }, "Overlays only tighten the built-in floors. The evaluation Worker clamps any weakening field, whatever this console publishes."),
    h("div", { class: "panel row" }, picker.element), body);
  load().catch((error) => body.replaceChildren(h("p", { class: "error" }, error.message)));
  return root;
}
