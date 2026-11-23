// Model registry, list rates and (HM-34) the model gate.
import { api, h, usd } from "../lib.js";
import { modelGatePanel } from "./extra.js";

function perMillion(rate) {
  // numeratorUsdNano per denominator units, scaled to one million units, exact in BigInt.
  const nano = (BigInt(rate.numeratorUsdNano) * 1000000n) / BigInt(rate.denominator);
  return `${usd(nano.toString())} / M ${rate.unit.replace(/_/g, " ")}`;
}

export async function modelsView() {
  const { priceBook, models } = await api("GET", "/models");
  return h("div", {},
    h("h1", {}, "Models"),
    h("p", { class: "muted" }, `Price book ${priceBook.id}, reviewed ${priceBook.reviewedAt.slice(0, 10)}.`),
    h("div", { class: "panel" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Family", "Model", "Role", "Status", "Context", "Modalities", "Rates"].map((t) => h("th", {}, t)))),
      h("tbody", {}, models.map((m) => h("tr", {},
        h("td", {}, m.family),
        h("td", { class: "mono" }, m.modelId),
        h("td", {}, m.role),
        h("td", {}, m.status === "preview" ? h("span", { class: "badge d-hold" }, "preview") : h("span", { class: "badge d-allow" }, "GA")),
        h("td", {}, m.contextTokens.toLocaleString()),
        h("td", {}, m.modalities.join(", ")),
        h("td", { class: "mono" }, m.rates.map((r) => h("div", {}, perMillion(r), r.effectiveTo ? ` until ${r.effectiveTo.slice(0, 10)}` : ` from ${r.effectiveFrom.slice(0, 10)}`))),
      ))))),
    h("p", { class: "notice" }, "A preview family (Clairic today) runs in shadow even when a profile asks to enforce it, unless the evaluation Worker's HM_MODEL_ENFORCE_WAIVERS secret lists it. This console cannot read that secret; a revision can only note that a waiver was recorded."),
    modelGatePanel ? modelGatePanel() : "",
  );
}
