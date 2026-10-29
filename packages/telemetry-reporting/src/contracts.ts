import { OpaqueId } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

const Integer = z.number().int().safe().nonnegative();
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const d = new Date(v); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v && d.getUTCDay() === 1;
});
const Timezone = z.string().min(1).max(128).refine((v) => { try { new Intl.DateTimeFormat("en-US", { timeZone: v }).format(0); return true; } catch { return false; } });
export const SyntheticRelease = z.strictObject({
  schemaVersion: z.literal("1.0"), mode: z.literal("synthetic"), releaseId: OpaqueId, tenantId: OpaqueId,
  cohort: z.literal("district-all"), cohortRevision: OpaqueId, dataRevision: OpaqueId, cutId: OpaqueId,
  firstLocalDate: LocalDate, days: z.union([z.literal(7), z.literal(28)]), timezone: Timezone, calendarRevision: OpaqueId,
  validUntil: Integer, source: z.enum(["available", "unavailable"]), population: Integer.nullable(),
  policy: z.strictObject({ fixtureRevision: OpaqueId, minimumPopulation: Integer.min(2), minimumEvaluated: Integer.min(1), minimumCandidate: Integer.min(1) }),
  cells: z.array(z.strictObject({ cell: Integer.max(167), evaluated: Integer.nullable(), candidates: Integer.nullable(),
    cohortRevision: OpaqueId, cutId: OpaqueId, countsValidUntil: Integer,
    coverage: z.enum(["as-of-fixture", "incomplete", "unavailable"]) })).length(168),
}).refine((r) => new Set(r.cells.map((c) => c.cell)).size === 168 && r.cells.every((c) =>
  c.cohortRevision === r.cohortRevision && c.cutId === r.cutId && ((c.evaluated === null && c.candidates === null) ||
    (c.evaluated !== null && c.candidates !== null && c.candidates <= c.evaluated))));
export type SyntheticRelease = z.infer<typeof SyntheticRelease>;
export const SyntheticReportingQuery = z.strictObject({ releaseId: OpaqueId });
export type SyntheticReportingQuery = z.infer<typeof SyntheticReportingQuery>;

export type CellState = "measured-fixture" | "suppressed" | "insufficient-exposure" | "incomplete-coverage" | "source-unavailable" | "expired";
export interface SyntheticReportingCell {
  readonly cell: number;
  readonly evaluated: { readonly state: CellState; readonly value: number | null };
  readonly candidateRate: { readonly state: CellState; readonly value: number | null };
  readonly coverage: "as-of-fixture" | "incomplete" | "unavailable";
}
export interface SyntheticReportingResponse {
  readonly schemaVersion: "1.0"; readonly mode: "synthetic"; readonly activation: "not-approved";
  readonly releaseId: string; readonly cohort: "district-all"; readonly dataRevision: string; readonly cohortRevision: string;
  readonly firstLocalDate: string; readonly days: 7 | 28; readonly timezone: string; readonly calendarRevision: string;
  readonly cells: readonly SyntheticReportingCell[];
  readonly capabilities: { readonly evaluated: "fixture-only"; readonly candidateRate: "fixture-only"; readonly liveCoverage: "unavailable";
    readonly reports: "unavailable"; readonly cases: "unavailable"; readonly urgentQueue: "unavailable"; readonly cost: "unavailable" };
}
export function freezeReportingValue<T>(v: T): T {
  if (v !== null && typeof v === "object") { for (const value of Object.values(v)) freezeReportingValue(value); Object.freeze(v); } return v;
}
