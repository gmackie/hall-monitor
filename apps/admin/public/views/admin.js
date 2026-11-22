// Role grants and the audit log (global admin only).
import { act, api, h, refresh } from "../lib.js";

const ROLES = ["viewer", "policy-editor", "labeler", "adjudicator", "publisher", "admin"];

export async function adminView() {
  const [{ roles }, { entries }] = await Promise.all([api("GET", "/roles"), api("GET", "/audit?limit=200")]);
  const email = h("input", { placeholder: "person@example.com", size: 28 });
  const tenant = h("input", { placeholder: "tenant or * for admin", size: 18 });
  const role = h("select", {}, ROLES.map((r) => h("option", { value: r }, r)));
  const status = h("span", { class: "muted" });
  const grant = (action, body) => act(status, async () => {
    await api("POST", action, body);
    refresh();
  });
  return h("div", {},
    h("h1", {}, "Roles & audit"),
    h("div", { class: "panel" },
      h("div", { class: "row" },
        h("label", {}, "Email", email), h("label", {}, "Tenant", tenant), h("label", {}, "Role", role),
        h("button", { onclick: () => grant("/roles", { email: email.value, tenant: tenant.value, role: role.value }) }, "Grant"),
        status),
      h("p", { class: "muted" }, "admin is global (tenant *). Every other role is per tenant and also lets the holder view that tenant."),
    ),
    h("div", { class: "panel" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Email", "Tenant", "Role", "Granted by", "At", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, roles.map((r) => h("tr", {},
        h("td", {}, r.email), h("td", { class: "mono" }, r.tenant), h("td", {}, r.role), h("td", {}, r.grantedBy), h("td", { class: "mono" }, r.grantedAt.slice(0, 19)),
        h("td", {}, h("button", { class: "secondary", onclick: () => grant("/roles:revoke", { email: r.email, tenant: r.tenant, role: r.role }) }, "Revoke"))))))),
    h("h2", {}, "Audit log"),
    h("div", { class: "panel" }, h("table", {},
      h("thead", {}, h("tr", {}, ["At", "Actor", "Action", "Tenant", "Target"].map((t) => h("th", {}, t)))),
      h("tbody", {}, entries.map((e) => h("tr", {},
        h("td", { class: "mono" }, e.at.slice(0, 19)), h("td", {}, e.actor), h("td", { class: "mono" }, e.action),
        h("td", { class: "mono" }, e.tenant), h("td", { class: "mono" }, `${e.target_type}:${e.target_id}`)))))),
  );
}
