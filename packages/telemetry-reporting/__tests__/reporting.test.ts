import { describe, expect, it } from "vitest";
import { createSyntheticReleaseCatalog, createSyntheticReportingReader, installSyntheticRelease, projectSyntheticRelease,
  signSyntheticReaderToken, syntheticReportingCsv, type SyntheticReaderClaims, type SyntheticRelease } from "../src/index.ts";

const now = Date.parse("2026-10-29T12:00:00Z"), key = new Uint8Array(32).fill(43);
function release(): SyntheticRelease {
  return { schemaVersion: "1.0", mode: "synthetic", releaseId: "release-1", tenantId: "synthetic_tenant", cohort: "district-all", cohortRevision: "cohort-1", dataRevision: "data-1", cutId: "cut-1",
    firstLocalDate: "2026-10-19", days: 7, timezone: "America/Detroit", calendarRevision: "calendar-1", validUntil: now + 60000,
    source: "available", population: 100, policy: { fixtureRevision: "fixture-1", minimumPopulation: 20, minimumEvaluated: 10, minimumCandidate: 3 },
    cells: Array.from({ length: 168 }, (_, cell) => ({ cell, evaluated: 100, candidates: 10, cohortRevision: "cohort-1", cutId: "cut-1", countsValidUntil: now + 60000, coverage: "as-of-fixture" })) };
}
function claims(nonce = "nonce-1"): SyntheticReaderClaims {
  return { schemaVersion: "1.0", mode: "synthetic", issuer: "fixture-issuer", audience: "hall-monitor-synthetic-analytics", tenantId: "synthetic_tenant", subject: "operator-1",
    role: "district-operator", scope: "analytics:read", nonce, notBefore: now - 1, expiresAt: now + 60000 };
}

describe("fixed privacy projection", () => {
  it("releases one fixed 168-cell partition with fixture provenance and no raw identities or future metric zeros", () => {
    const response = projectSyntheticRelease(release(), now);
    expect(response.cells).toHaveLength(168); expect(response.cells[0]).toEqual({ cell: 0, evaluated: { state: "measured-fixture", value: 100 }, candidateRate: { state: "measured-fixture", value: 0.1 }, coverage: "as-of-fixture" });
    expect(response).toMatchObject({ mode: "synthetic", activation: "not-approved", capabilities: { liveCoverage: "unavailable", cases: "unavailable", urgentQueue: "unavailable" } });
    expect(JSON.stringify(response)).not.toMatch(/tenantId|subject|nonce|population|total|candidates|deliveryId|cutId/);
  });

  it("separates measured zero from missing counts and withholds undefined rates", () => {
    const r = release(); r.cells[0]!.evaluated = 0; r.cells[0]!.candidates = 0;
    r.cells[1]!.evaluated = null; r.cells[1]!.candidates = null;
    const cells = projectSyntheticRelease(r, now).cells;
    expect(cells[0]!.evaluated).toEqual({ state: "measured-fixture", value: 0 });
    expect(cells[0]!.candidateRate).toEqual({ state: "insufficient-exposure", value: null });
    expect(cells[1]!.evaluated).toEqual({ state: "source-unavailable", value: null });
  });

  it("requires known population, minimum exposure, numerator and complementary population thresholds", () => {
    for (const population of [null, 0, 19]) {
      const r = release(); r.population = population;
      expect(projectSyntheticRelease(r, now).cells.every((c) => c.evaluated.state === "suppressed" && c.evaluated.value === null)).toBe(true);
    }
    for (const candidates of [0, 1, 2, 98, 99, 100]) {
      const r = release(); r.cells[0]!.candidates = candidates;
      expect(projectSyntheticRelease(r, now).cells[0]!.candidateRate).toEqual({ state: "suppressed", value: null });
    }
    const low = release(); low.cells[0]!.evaluated = 9; low.cells[0]!.candidates = 3;
    expect(projectSyntheticRelease(low, now).cells[0]!.evaluated).toEqual({ state: "insufficient-exposure", value: null });
  });

  it("withholds incomplete, unavailable and expired counts even if raw numbers remain present", () => {
    const r = release(); r.cells[0]!.coverage = "incomplete"; r.cells[1]!.coverage = "unavailable"; r.cells[2]!.countsValidUntil = now;
    const cells = projectSyntheticRelease(r, now).cells;
    expect(cells[0]!.evaluated.state).toBe("incomplete-coverage");
    expect(cells[1]!.evaluated.state).toBe("source-unavailable");
    expect(cells[2]).toMatchObject({ evaluated: { state: "expired", value: null }, coverage: "unavailable" });
    r.source = "unavailable";
    expect(projectSyntheticRelease(r, now).cells[3]!.candidateRate.value).toBeNull();
    r.validUntil = now;
    expect(projectSyntheticRelease(r, now).cells.every((c) => c.evaluated.state === "expired")).toBe(true);
  });

  it("withholds unfinished local windows and validates the projection boundary itself", () => {
    const r = release(); r.firstLocalDate = "2026-10-26";
    expect(projectSyntheticRelease(r, now).cells.every((c) => c.evaluated.state === "source-unavailable")).toBe(true);
    r.cells[0]!.candidates = 101;
    expect(() => projectSyntheticRelease(r, now)).toThrow("invalid synthetic reporting release");
  });

  it("exports exactly the redacted cells, with no totals or suppressed values", () => {
    const r = release(); r.cells[0]!.candidates = 1; r.cells[1]!.evaluated = 5; r.cells[1]!.candidates = 2;
    const dto = projectSyntheticRelease(r, now), lines = syntheticReportingCsv(dto).trim().split("\n");
    expect(lines).toHaveLength(169);
    for (const [i, c] of dto.cells.entries()) expect(lines[i + 1]!.split(",")).toEqual([String(c.cell), c.evaluated.state, c.evaluated.value === null ? "" : String(c.evaluated.value),
      c.candidateRate.state, c.candidateRate.value === null ? "" : String(c.candidateRate.value), c.coverage]);
    expect(lines[1]).toBe("0,measured-fixture,100,suppressed,,as-of-fixture");
    expect(lines[2]).toBe("1,insufficient-exposure,,insufficient-exposure,,as-of-fixture");
  });
});

describe("immutable disjoint releases", () => {
  it("rejects unknown/raw fields, mismatched denominator/cut, F>E, invalid dates, timezone and duplicate cells", () => {
    const bad: unknown[] = [{ ...release(), mode: "production" }, { ...release(), sql: "SENTINEL" }, { ...release(), timezone: "not-a-zone" },
      { ...release(), firstLocalDate: "2026-02-30" }, { ...release(), firstLocalDate: "2026-10-20" }];
    const candidates = release(); candidates.cells[0]!.candidates = 101; bad.push(candidates);
    const cohort = release(); cohort.cells[0]!.cohortRevision = "other"; bad.push(cohort);
    const cut = release(); cut.cells[0]!.cutId = "other"; bad.push(cut);
    const duplicates = release(); duplicates.cells[0]!.cell = 1; bad.push(duplicates);
    for (const input of bad) expect(() => installSyntheticRelease(createSyntheticReleaseCatalog(), input)).toThrow("invalid synthetic reporting release");
  });

  it("refuses overlap, alternate corrections/partitions, timezone/calendar drift and replacement after expiry", () => {
    const first = installSyntheticRelease(createSyntheticReleaseCatalog(), release());
    expect(installSyntheticRelease(first, release())).toBe(first);
    const revised = { ...release(), dataRevision: "data-2" };
    expect(() => installSyntheticRelease(first, revised)).toThrow("identity already installed");
    for (const candidate of [{ ...revised, releaseId: "other-release" }, { ...release(), releaseId: "month", days: 28 },
      { ...release(), releaseId: "other-zone", timezone: "UTC" }, { ...release(), releaseId: "other-calendar", calendarRevision: "calendar-2" }])
      expect(() => installSyntheticRelease(first, candidate)).toThrow("alternate or overlapping");
    const adjacent = { ...release(), releaseId: "week-2", firstLocalDate: "2026-10-26" };
    expect(installSyntheticRelease(first, adjacent).releases).toHaveLength(2);
    const expired = { ...release(), validUntil: now - 1 };
    const history = installSyntheticRelease(createSyntheticReleaseCatalog(), expired);
    expect(() => installSyntheticRelease(history, { ...release(), releaseId: "recreated-zero" })).toThrow("overlapping");
  });

  it("retains history at the bound and becomes terminal rather than forgetting prior partitions", () => {
    let catalog = createSyntheticReleaseCatalog();
    for (let i = 0; i < 32; i++) {
      const d = new Date("2026-01-05"); d.setUTCDate(d.getUTCDate() + i * 7);
      catalog = installSyntheticRelease(catalog, { ...release(), releaseId: `week-${i}`, firstLocalDate: d.toISOString().slice(0, 10) });
    }
    expect(installSyntheticRelease(catalog, catalog.releases[0])).toBe(catalog);
    catalog = installSyntheticRelease(catalog, { ...release(), releaseId: "overflow", firstLocalDate: "2027-01-04" });
    expect(catalog).toEqual({ status: "capacity", releases: [] });
    expect(installSyntheticRelease(catalog, release())).toBe(catalog);
  });
});

describe("reader-only fixture authentication", () => {
  it("allows a tenant operator, refuses cross-tenant/writer/role spoofing and consumes concurrent replay once", async () => {
    const reader = await createSyntheticReportingReader(key, "fixture-issuer"), catalog = installSyntheticRelease(createSyntheticReleaseCatalog(), release());
    const token = await signSyntheticReaderToken(claims(), key);
    const outcomes = await Promise.all([reader.read(token, { releaseId: "release-1" }, catalog, now), reader.read(token, { releaseId: "release-1" }, catalog, now)]);
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 401]);
    const otherTenant = await signSyntheticReaderToken({ ...claims("nonce-2"), tenantId: "other" }, key);
    expect(await reader.read(otherTenant, { releaseId: "release-1" }, catalog, now)).toEqual({ status: 404, code: "not-found" });
    expect(await reader.read({ ...token, claims: { ...token.claims, role: "teacher" } }, { releaseId: "release-1" }, catalog, now)).toEqual({ status: 401, code: "unauthorized" });
    expect(await reader.read({ keyId: "writer-key", body: "telemetry", mac: token.mac }, { releaseId: "release-1" }, catalog, now)).toEqual({ status: 401, code: "unauthorized" });
  });

  it("rejects key/issuer/audience/expiry tampering and raw query/filter/tenant fields", async () => {
    const reader = await createSyntheticReportingReader(key, "fixture-issuer"), catalog = installSyntheticRelease(createSyntheticReleaseCatalog(), release());
    const valid = await signSyntheticReaderToken(claims(), key);
    for (const bad of [{ ...valid, mac: "0".repeat(64) }, { ...valid, claims: { ...valid.claims, audience: "hall-monitor-writer" } },
      await signSyntheticReaderToken({ ...claims(), issuer: "other" }, key), await signSyntheticReaderToken(claims(), new Uint8Array(32).fill(2)),
      await signSyntheticReaderToken({ ...claims(), expiresAt: now }, key)]) expect((await reader.read(bad, { releaseId: "release-1" }, catalog, now)).status).toBe(401);
    for (const [i, query] of [{ releaseId: "release-1", tenantId: "other" }, { releaseId: "release-1", grade: "9-12" },
      { releaseId: "release-1", start: "2026-10-20", end: "2026-10-28" }, { releaseId: "release-1", sql: "SENTINEL" }].entries()) {
      const token = await signSyntheticReaderToken(claims(`query-${i}`), key);
      expect(await reader.read(token, query, catalog, now)).toEqual({ status: 400, code: "invalid-query" });
    }
  });

  it("does not evict nonce evidence at the fixture bound", async () => {
    const reader = await createSyntheticReportingReader(key, "fixture-issuer"), catalog = installSyntheticRelease(createSyntheticReleaseCatalog(), release());
    for (let i = 0; i < 1024; i++) {
      const token = await signSyntheticReaderToken(claims(`capacity-${i}`), key);
      // Unknown releases still consume an authenticated nonce, without projecting 168 rows.
      expect((await reader.read(token, { releaseId: "not-found" }, catalog, now)).status).toBe(404);
    }
    const token = await signSyntheticReaderToken(claims("overflow"), key);
    expect(await reader.read(token, { releaseId: "release-1" }, catalog, now)).toEqual({ status: 503, code: "unavailable" });
  });
});
