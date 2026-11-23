// Config releases: what the next release would carry, publishing, history and rollback.
import { act, api, h, refresh, state } from "../lib.js";

export async function releasesView() {
  const data = await api("GET", "/releases");
  const status = h("span", { class: "muted" });
  const modeTenant = h("select", {}, (state.me?.tenants ?? []).map((t) => h("option", { value: t }, t)));
  const modeValue = h("select", {}, ["shadow", "enforce", "(clear)"].map((m) => h("option", { value: m }, m)));
  return h("div", {},
    h("h1", {}, "Config releases"),
    h("p", { class: "muted" }, "A release is the complete set of tenant overlays (and tenant modes, once any are set), stored immutably under its digest. The evaluation Worker verifies the digest, still clamps every overlay to the floors, and falls back to its secrets if the release does not verify. The first release replaces HM_POLICY_OVERLAYS entirely."),
    h("div", { class: "panel" },
      h("h2", {}, "Next release"),
      data.pending.length
        ? h("ul", {}, data.pending.map((r) => h("li", { class: "mono" }, `${r.tenant}/${r.profileId}@${r.revision} — by ${r.author}, approved by ${r.approver}`)))
        : h("p", { class: "muted" }, "No newly approved revisions you can view."),
      data.hiddenPending ? h("p", { class: "muted" }, `${data.hiddenPending} more approved revision(s) on tenants you cannot view; publishing needs the publisher role there.`) : "",
      h("p", { class: "muted" }, "Two-person rule: you cannot publish a student-facing or family-enforcing revision you wrote."),
      h("div", { class: "row" }, h("button", { onclick: () => act(status, async () => { await api("POST", "/releases"); refresh(); }) }, "Publish release"), status)),
    state.me?.isAdmin ? h("div", { class: "panel" },
      h("h2", {}, "Tenant modes"),
      data.tenantModes.length
        ? h("ul", {}, data.tenantModes.map((m) => h("li", { class: "mono" }, `${m.tenant}: ${m.setting} (${m.updatedBy})`)))
        : h("p", { class: "muted" }, "None set: releases leave the Worker's HM_TENANT_MODES in force. Once any is set, a release replaces it and unlisted tenants are enforced."),
      h("div", { class: "row" }, h("label", {}, "Tenant", modeTenant), h("label", {}, "Mode", modeValue),
        h("button", { class: "secondary", onclick: () => act(status, async () => {
          await api("PUT", `/tenants/${encodeURIComponent(modeTenant.value)}/mode`, { setting: modeValue.value === "(clear)" ? null : modeValue.value });
          refresh();
        }) }, "Save for next release"))) : "",
    h("h2", {}, "History"),
    h("div", { class: "panel" }, data.releases.length ? h("table", {},
      h("thead", {}, h("tr", {}, ["Release", "Digest", "Published by", "Second person", "Created", "Carries", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, data.releases.map((r) => h("tr", {},
        h("td", { class: "mono" }, r.releaseId, r.active ? h("span", { class: "badge d-allow" }, " active") : ""),
        h("td", { class: "mono" }, `${r.digest.slice(0, 19)}…`),
        h("td", {}, r.author), h("td", {}, r.approver),
        h("td", { class: "mono" }, r.createdAt.slice(0, 19)),
        h("td", { class: "mono" }, r.profiles.join(", ") || "—", r.tenantModes ? ` · modes ${JSON.stringify(r.tenantModes)}` : ""),
        h("td", {}, r.active ? "" : h("button", { class: "secondary", onclick: () => act(status, async () => { if (confirm(`Activate ${r.releaseId}? The Worker picks it up within a minute.`)) { await api("POST", `/releases/${encodeURIComponent(r.releaseId)}:activate`); refresh(); } }) }, "Activate")),
      )))) : h("p", { class: "muted" }, "No releases yet.")),
  );
}
