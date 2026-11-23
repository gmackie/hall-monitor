// Shared helpers for the admin SPA. No dependencies, no innerHTML: text is always a text node.

/** Creates an element. Text children become text nodes, never parsed as HTML. */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key === "value") node.value = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export class ApiFailure extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.code;
  }
}

/** Calls the admin API on the same origin. */
export async function api(method, path, body) {
  const response = await fetch(`/admin/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text === "" ? null : JSON.parse(text); } catch { parsed = null; }
  if (!response.ok) throw new ApiFailure(response.status, parsed);
  return parsed;
}

/**
 * Formats integer nanodollars (a decimal string) as exact USD using BigInt only: the whole part is
 * `n / 10^9`, the fraction the zero-padded remainder with trailing zeros trimmed (at least cents).
 */
export function usd(nanoString) {
  if (typeof nanoString !== "string" || !/^-?\d+$/.test(nanoString)) return "—";
  let n = BigInt(nanoString);
  const negative = n < 0n;
  if (negative) n = -n;
  const whole = n / 1000000000n;
  let fraction = (n % 1000000000n).toString().padStart(9, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${negative ? "-" : ""}$${whole.toString()}.${fraction}`;
}

export function decisionBadge(decision) {
  return h("span", { class: `badge d-${decision}` }, decision);
}

/** App-wide state: the signed-in person and the reason-code catalog. */
export const state = { me: null, reasonCodes: new Map() };

let renderFn = () => {};
export function setRender(fn) { renderFn = fn; }

export function navigate(path) {
  history.pushState(null, "", path);
  renderFn();
}

/** Re-renders the current view (after a mutation). */
export function refresh() { renderFn(); }

/** A tenant picker over the tenants the person can view; remembers the choice in the URL. */
export function tenantPicker(onChange) {
  const params = new URLSearchParams(location.search);
  const tenants = state.me?.tenants ?? [];
  const current = params.get("tenant") ?? tenants[0] ?? "";
  const select = h("select", { onchange: () => {
    const next = new URLSearchParams(location.search);
    next.set("tenant", select.value);
    history.replaceState(null, "", `${location.pathname}?${next}`);
    onChange(select.value);
  } }, tenants.map((t) => h("option", { value: t, ...(t === current ? { selected: true } : {}) }, t)));
  return { element: h("label", {}, "Tenant", select), tenant: current };
}

export function reasonTitle(code) {
  const info = state.reasonCodes.get(code);
  return info ? `${info.title} (${code})` : code;
}

/** Reports a mutation's outcome inline. */
export async function act(target, fn) {
  target.textContent = "Working…";
  target.className = "muted";
  try {
    const result = await fn();
    target.textContent = "Done.";
    return result;
  } catch (error) {
    target.textContent = error instanceof Error ? error.message : String(error);
    target.className = "error";
    return undefined;
  }
}
