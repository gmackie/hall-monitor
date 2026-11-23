// Hall Monitor admin SPA: plain ES modules, no build step. Every API call goes to /admin/v1 on the
// same origin; Cloudflare Access supplies the session (Cf-Access-Jwt-Assertion) to the Worker.
import { api, ApiFailure, h, setRender, state } from "./lib.js";
import { evaluationsView } from "./views/evaluations.js";
import { evaluationView } from "./views/evaluation.js";
import { profilesView } from "./views/profiles.js";
import { modelsView } from "./views/models.js";
import { adminView } from "./views/admin.js";
import { extraRoutes } from "./views/extra.js";

const ROUTES = [
  // The deep link PlayTrek uses: /evaluations/<evaluationId>[?tenant=<tenant>].
  { path: /^\/evaluations\/([^/]+)$/, view: evaluationView },
  { path: /^\/(?:evaluations)?$/, view: evaluationsView, nav: ["/evaluations", "Evaluations"] },
  { path: /^\/profiles$/, view: profilesView, nav: ["/profiles", "Profiles"] },
  { path: /^\/models$/, view: modelsView, nav: ["/models", "Models"] },
  ...extraRoutes,
  { path: /^\/admin$/, view: adminView, nav: ["/admin", "Roles & audit"], adminOnly: true },
];

function renderNav() {
  const nav = document.getElementById("nav");
  nav.replaceChildren(...ROUTES.filter((r) => r.nav && (!r.adminOnly || state.me?.isAdmin)).map((r) => {
    const active = location.pathname.startsWith(r.nav[0]) || (r.nav[0] === "/evaluations" && location.pathname === "/");
    return h("a", { href: r.nav[0], "data-link": true, class: active ? "active" : "" }, r.nav[1]);
  }));
}

async function render() {
  const view = document.getElementById("view");
  renderNav();
  const match = ROUTES.map((r) => ({ r, m: r.path.exec(location.pathname) })).find((x) => x.m);
  if (!match) {
    view.replaceChildren(h("p", {}, "Not found."));
    return;
  }
  view.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  try {
    view.replaceChildren(await match.r.view(...match.m.slice(1).map(decodeURIComponent)));
  } catch (error) {
    view.replaceChildren(errorBox(error));
  }
}
setRender(render);

export function errorBox(error) {
  if (error instanceof ApiFailure && error.status === 401) return h("p", { class: "error" }, "Your Cloudflare Access session has expired. Reload the page to sign in again.");
  if (error instanceof ApiFailure && error.status === 403) return h("p", { class: "error" }, "Your role does not allow this.");
  return h("p", { class: "error" }, error instanceof Error ? error.message : String(error));
}

document.addEventListener("click", (event) => {
  const link = event.target.closest?.("a[data-link]");
  if (link && !event.metaKey && !event.ctrlKey && link.origin === location.origin) {
    event.preventDefault();
    history.pushState(null, "", link.pathname + link.search);
    render();
  }
});
window.addEventListener("popstate", render);

async function boot() {
  try {
    state.me = await api("GET", "/me");
    document.getElementById("who").textContent = `${state.me.email}${state.me.isAdmin ? " · admin" : ""}`;
    const catalog = await api("GET", "/reason-codes");
    state.reasonCodes = new Map(catalog.codes.map((c) => [c.code, c]));
  } catch (error) {
    document.getElementById("view").replaceChildren(errorBox(error));
    return;
  }
  await render();
}
boot();
