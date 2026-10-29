import { freezeReportingValue, SyntheticRelease } from "./contracts.ts";

/** Immutable synthetic release history. Never discard a past partition to permit a differencing query. */
export interface SyntheticReleaseCatalog {
  readonly status: "open" | "capacity";
  readonly releases: readonly SyntheticRelease[];
}
export const createSyntheticReleaseCatalog = (): SyntheticReleaseCatalog => freezeReportingValue({ status: "open", releases: [] });
const firstDay = (r: SyntheticRelease) => Date.parse(r.firstLocalDate) / 86_400_000;
export function installSyntheticRelease(catalog: SyntheticReleaseCatalog, input: unknown): SyntheticReleaseCatalog {
  if (catalog.status === "capacity") return catalog;
  const result = SyntheticRelease.safeParse(input);
  if (!result.success) throw new Error("invalid synthetic reporting release");
  const r = result.data;
  const existing = catalog.releases.find((x) => x.releaseId === r.releaseId);
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(r)) return catalog;
    throw new Error("release identity already installed");
  }
  if (catalog.releases.some((x) => x.tenantId === r.tenantId && (x.timezone !== r.timezone || x.calendarRevision !== r.calendarRevision ||
    (firstDay(x) < firstDay(r) + r.days && firstDay(r) < firstDay(x) + x.days)))) throw new Error("alternate or overlapping release refused");
  if (catalog.releases.length >= 32) return freezeReportingValue({ status: "capacity", releases: [] });
  return freezeReportingValue({ status: "open", releases: [...catalog.releases, r] });
}
