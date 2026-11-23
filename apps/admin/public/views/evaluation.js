// One evaluation: the deep-link target /evaluations/<evaluationId>[?tenant=<tenant>].
import { api, decisionBadge, h, reasonTitle, usd } from "../lib.js";

function span(s) {
  return s ? `${s.start}–${s.end}` : "—";
}

function findingsTable(findings) {
  if (!findings?.length) return h("p", { class: "muted" }, "No findings.");
  return h("table", {},
    h("thead", {}, h("tr", {}, ["Reason", "Category", "Severity", "Evaluator", "Confidence", "Span", "Evidence"].map((t) => h("th", {}, t)))),
    h("tbody", {}, findings.map((f) => h("tr", {},
      h("td", {}, reasonTitle(f.reasonCode)),
      h("td", {}, f.category),
      h("td", {}, f.severity),
      h("td", { class: "mono" }, `${f.evaluatorId}@${f.evaluatorVersion}`),
      h("td", {}, f.confidence === undefined ? "—" : f.confidence.toFixed(2)),
      h("td", { class: "mono" }, span(f.span)),
      h("td", { class: "mono" }, (f.evidence ?? []).map((e) => `${e.field} ${span(e.span)}${e.confidence === undefined ? "" : ` (${e.confidence.toFixed(2)})`}`).join("; ") || "—"),
    ))));
}

function routePanel(route, receipt) {
  const attempts = new Map((receipt?.attempts ?? []).map((a) => [a.attemptId, a]));
  if (!route?.classifiers?.length) return h("p", { class: "muted" }, "No model route recorded.");
  return route.classifiers.map((c) => h("div", { class: "panel" },
    h("dl", { class: "kv" },
      h("dt", {}, "Family"), h("dd", {}, `${c.family} (${c.evaluatorId}@${c.evaluatorVersion})`),
      h("dt", {}, "Status"), h("dd", {}, c.status + (c.skipReason ? `: ${c.skipReason}` : "")),
      h("dt", {}, "Mode"), h("dd", {}, c.mode === "shadow" ? "shadow (findings never reach the decision)" : "enforce"),
      h("dt", {}, "Calibration"), h("dd", {}, c.calibrationRevision ?? "uncalibrated thresholds"),
      h("dt", {}, "Escalated"), h("dd", {}, c.escalated ? `yes: ${c.escalationReason ?? "—"}` : "no", c.fellBack ? " (fell back to the primary)" : ""),
    ),
    c.calls.length ? h("table", {},
      h("thead", {}, h("tr", {}, ["Model", "Role", "Outcome", "Tokens in/out", "Cost"].map((t) => h("th", {}, t)))),
      h("tbody", {}, c.calls.map((call) => {
        const a = call.attemptId ? attempts.get(call.attemptId) : undefined;
        return h("tr", {},
          h("td", { class: "mono" }, call.modelId),
          h("td", {}, call.role),
          h("td", {}, call.outcome),
          h("td", { class: "mono" }, a ? `${a.units.inputTokens ?? "?"} / ${a.units.outputTokens ?? "?"}` : "—"),
          h("td", { class: "mono" }, a?.grossUsdNano ? usd(a.grossUsdNano) : a ? `unknown (${a.state})` : "—"));
      }))) : "",
    c.shadowFindings?.length ? [h("h2", {}, "Shadow findings"), findingsTable(c.shadowFindings)] : "",
  ));
}

export async function evaluationView(evaluationId) {
  const tenant = new URLSearchParams(location.search).get("tenant");
  const path = `/evaluations/${encodeURIComponent(evaluationId)}${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""}`;
  let found;
  try {
    found = await api("GET", path);
  } catch (error) {
    if (error.status === 404) return h("div", {}, h("h1", {}, "Evaluation not found"),
      h("p", { class: "muted" }, "It may have expired, or it belongs to a tenant you cannot view."), h("a", { href: "/evaluations", "data-link": true }, "Back to evaluations"));
    throw error;
  }
  const { record } = found;
  const result = record.result;
  const shadow = record.mode === "shadow" && result.shadow ? result.shadow : null;
  const receipt = result.receipt;
  return h("div", {},
    h("p", {}, h("a", { href: `/evaluations?tenant=${encodeURIComponent(found.tenant)}`, "data-link": true }, "← Evaluations")),
    h("h1", {}, "Evaluation ", h("span", { class: "mono" }, record.evaluationId)),
    h("div", { class: "panel" },
      h("div", {}, "Enforced: ", decisionBadge(result.decision)),
      shadow ? h("div", { class: "shadow-note" }, "Shadow: would have been ", decisionBadge(shadow.decision),
        shadow.reasonCodes?.length ? h("div", { class: "muted" }, "Would-be reasons: ", shadow.reasonCodes.map(reasonTitle).join(", ")) : "") : "",
      result.degraded ? h("p", { class: "error" }, `Degraded: ${result.degraded.reason}`) : "",
      result.uncertain ? h("p", { class: "muted" }, "Marked uncertain.") : "",
    ),
    h("div", { class: "panel" }, h("dl", { class: "kv" },
      h("dt", {}, "Tenant"), h("dd", { class: "mono" }, found.tenant),
      h("dt", {}, "Product / surface"), h("dd", { class: "mono" }, `${record.product} · ${record.surface}`),
      h("dt", {}, "Kind / content"), h("dd", { class: "mono" }, `${record.evaluationKind} · ${record.contentType}`),
      h("dt", {}, "Policy"), h("dd", { class: "mono" }, `${record.policy.profileId}@${record.policy.revision}`),
      h("dt", {}, "Mode"), h("dd", {}, record.mode),
      h("dt", {}, "Context"), h("dd", { class: "mono" }, Object.entries(record.context).map(([k, v]) => `${k}=${v}`).join(" ")),
      h("dt", {}, "Request"), h("dd", { class: "mono" }, record.requestId),
      h("dt", {}, "Recorded"), h("dd", {}, new Date(record.recordedAt).toLocaleString(), h("span", { class: "muted" }, ` (expires ${new Date(record.expiresAt).toLocaleDateString()})`)),
    )),
    h("h2", {}, "Reason codes"),
    h("div", { class: "panel" }, result.reasonCodes.length ? h("ul", {}, result.reasonCodes.map((c) => h("li", {}, reasonTitle(c)))) : h("p", { class: "muted" }, "None.")),
    h("h2", {}, "Findings"),
    h("div", { class: "panel" }, findingsTable(result.findings), h("p", { class: "muted" }, "Spans are UTF-16 offsets into the product's own copy of the content; Hall Monitor keeps no text.")),
    h("h2", {}, "Model route"),
    routePanel(result.route, receipt),
    h("h2", {}, "Cost"),
    h("div", { class: "panel" }, receipt
      ? h("dl", { class: "kv" },
        h("dt", {}, "Total"), h("dd", { class: "mono" }, usd(receipt.totalGrossUsdNano), receipt.hasUnknownCost ? " (lower bound: some attempts have unknown cost)" : ""),
        h("dt", {}, "Attempts"), h("dd", {}, String(receipt.attempts.length)),
        h("dt", {}, "Price book"), h("dd", { class: "mono" }, [...new Set(receipt.attempts.map((a) => a.priceBookId))].join(", ") || "—"))
      : h("p", { class: "muted" }, "No billed calls.")),
  );
}
