// Evaluation explorer: one tenant's retained, content-free records, filtered like GET /v1/evaluations.
import { api, decisionBadge, h, navigate, tenantPicker, usd } from "../lib.js";

const FILTERS = [
  ["decision", "Enforced decision", ["", "allow", "coach", "hold", "block", "support"]],
  ["mode", "Mode", ["", "enforce", "shadow"]],
  ["escalated", "Escalated", ["", "true", "false"]],
  ["profileId", "Profile"],
  ["surface", "Surface"],
  ["reasonCode", "Reason code"],
  ["modelId", "Model"],
  ["requestId", "Request id"],
];

/** The models called on a record's route, in order. */
function modelsOf(record) {
  return (record.result.route?.classifiers ?? []).flatMap((c) => c.calls.map((call) => call.modelId.replace("@cf/cloudflare/", "")));
}

/** The would-be decision of a shadow record, or nothing. */
export function wouldBe(record) {
  return record.mode === "shadow" && record.result.shadow ? record.result.shadow.decision : null;
}

export async function evaluationsView() {
  const root = h("div", {});
  const params = new URLSearchParams(location.search);
  const picker = tenantPicker(() => load(null));
  let tenant = picker.tenant;
  const inputs = Object.fromEntries(FILTERS.map(([key, , options]) => [key, options
    ? h("select", {}, options.map((o) => h("option", { value: o, ...(params.get(key) === o ? { selected: true } : {}) }, o === "" ? "any" : o)))
    : h("input", { value: params.get(key) ?? "", size: 14 })]));
  const table = h("div", { class: "panel" });
  const more = h("div", {});

  async function load(cursor) {
    tenant = picker.element.querySelector("select").value;
    if (!tenant) {
      table.replaceChildren(h("p", { class: "muted" }, "You have no tenants to view. Ask an admin for a role."));
      return;
    }
    const query = new URLSearchParams({ limit: "50" });
    for (const [key, input] of Object.entries(inputs)) if (input.value) query.set(key, input.value);
    if (cursor) query.set("cursor", cursor);
    if (!cursor) table.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    try {
      const page = await api("GET", `/tenants/${encodeURIComponent(tenant)}/evaluations?${query}`);
      const rows = page.items.map((record) => h("tr", { class: "clickable", onclick: () => navigate(`/evaluations/${encodeURIComponent(record.evaluationId)}?tenant=${encodeURIComponent(tenant)}`) },
        h("td", { class: "mono" }, new Date(record.recordedAt).toLocaleString()),
        h("td", {}, decisionBadge(record.result.decision)),
        h("td", {}, wouldBe(record) ? decisionBadge(wouldBe(record)) : h("span", { class: "muted" }, "—")),
        h("td", {}, record.mode),
        h("td", { class: "mono" }, `${record.policy.profileId}@${record.policy.revision}`),
        h("td", { class: "mono" }, record.surface),
        h("td", { class: "mono" }, record.result.reasonCodes.join(", ")),
        h("td", { class: "mono" }, modelsOf(record).join(" → ") || "—"),
        h("td", { class: "mono" }, record.result.receipt ? usd(record.result.receipt.totalGrossUsdNano) + (record.result.receipt.hasUnknownCost ? "+" : "") : "—"),
      ));
      const body = cursor ? table.querySelector("tbody") : h("tbody", {});
      body.append(...rows);
      if (!cursor) {
        table.replaceChildren(page.items.length === 0 ? h("p", { class: "muted" }, "No records match.") : h("table", {},
          h("thead", {}, h("tr", {}, ["Recorded", "Enforced", "Would be (shadow)", "Mode", "Profile", "Surface", "Reason codes", "Models", "Cost"].map((t) => h("th", {}, t)))),
          body));
      }
      more.replaceChildren(page.nextCursor ? h("button", { class: "secondary", onclick: () => load(page.nextCursor) }, "Load more") : "");
    } catch (error) {
      table.replaceChildren(h("p", { class: "error" }, error.message));
    }
  }

  root.append(
    h("h1", {}, "Evaluations"),
    h("p", { class: "muted" }, "Retained, content-free records. Shadow-mode records enforce allow; the would-be decision is what enforcement would have returned."),
    h("div", { class: "panel row" }, picker.element, FILTERS.map(([key, label]) => h("label", {}, label, inputs[key])), h("button", { onclick: () => load(null) }, "Apply")),
    table,
    more,
  );
  load(null);
  return root;
}
