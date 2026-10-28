import { describe, expect, it } from "vitest";
import { BUCKET_MS, bucketStartOf, classifyLocalDate, deriveTrustedDimensions, resolveInterval, type CalendarSpan, type TenantInterval } from "../src/time.ts";

const HOUR = 3_600_000;
const interval = (timeZone: string, calendar: CalendarSpan[] = []): TenantInterval => ({
  fromMs: Date.UTC(2020, 0, 1), toMs: Date.UTC(2040, 0, 1), timeZone, calendarRevision: "cal-test", producerRevisions: ["rev-a"], calendar,
});
const dims = (zone: string, utc: string, calendar: CalendarSpan[] = []) =>
  deriveTrustedDimensions("cfg-test", interval(zone, calendar), bucketStartOf(Date.parse(utc)));

/** Walks every UTC hour from `from` to `to` and tallies the elapsed hours of each local ISO week. */
function weeks(zone: string, from: string, to: string) {
  const byWeek = new Map<string, { elapsed: number; slots: Set<string> }>();
  for (let t = Date.parse(from); t < Date.parse(to); t += HOUR) {
    const d = dims(zone, new Date(t).toISOString());
    const week = byWeek.get(d.weekStartingMonday) ?? { elapsed: 0, slots: new Set<string>() };
    week.elapsed += 1;
    // A (local date, local hour, offset) slot: a repeated fall-back hour yields two distinct slots.
    week.slots.add(`${d.localDate}T${d.localHour}@${d.utcOffsetMinutes}`);
    byWeek.set(d.weekStartingMonday, week);
  }
  return byWeek;
}

describe("trusted chronological dimensions (W8a)", () => {
  it.each(["America/Detroit", "America/Los_Angeles"])("%s: spring week has 167 elapsed hours and fall week 169, none merged", (zone) => {
    // 2026: US DST starts Sunday 8 March and ends Sunday 1 November.
    const spring = weeks(zone, "2026-02-23T00:00:00Z", "2026-03-23T00:00:00Z");
    const fall = weeks(zone, "2026-10-12T00:00:00Z", "2026-11-16T00:00:00Z");
    expect(spring.get("2026-03-02")!.elapsed).toBe(167);
    expect(spring.get("2026-03-02")!.slots.size).toBe(167);
    expect(spring.get("2026-03-09")!.elapsed).toBe(168);
    expect(fall.get("2026-10-26")!.elapsed).toBe(169);
    // 169 DISTINCT slots: the repeated 01:00 hour is two chronological hours, never one 168-cell tile.
    expect(fall.get("2026-10-26")!.slots.size).toBe(169);
    expect(fall.get("2026-11-02")!.elapsed).toBe(168);
  });

  it("keeps both repeated fall-back hours distinct by UTC instant and offset, and skips the spring hour", () => {
    const first = dims("America/Detroit", "2026-11-01T05:30:00Z"); // 01:30 EDT
    const second = dims("America/Detroit", "2026-11-01T06:30:00Z"); // 01:30 EST
    expect(first).toMatchObject({ localDate: "2026-11-01", localHour: 1, utcOffsetMinutes: -240, weekday: 6, weekStartingMonday: "2026-10-26" });
    expect(second).toMatchObject({ localDate: "2026-11-01", localHour: 1, utcOffsetMinutes: -300 });
    expect(bucketStartOf(Date.parse("2026-11-01T05:30:00Z"))).not.toBe(bucketStartOf(Date.parse("2026-11-01T06:30:00Z")));
    // Spring forward: 02:00-02:59 local never occurs in Detroit on 8 March 2026.
    const hours = new Set<number>();
    for (let t = Date.parse("2026-03-08T04:00:00Z"); t < Date.parse("2026-03-08T12:00:00Z"); t += HOUR) {
      const d = dims("America/Detroit", new Date(t).toISOString());
      if (d.localDate === "2026-03-08") hours.add(d.localHour);
    }
    expect(hours.has(1)).toBe(true);
    expect(hours.has(2)).toBe(false);
    expect(hours.has(3)).toBe(true);
  });

  it("does not invent daylight saving for Phoenix or Honolulu", () => {
    for (const [zone, offset] of [["America/Phoenix", -420], ["Pacific/Honolulu", -600]] as const) {
      const offsets = new Set<number>();
      for (const month of [0, 2, 5, 9, 10]) offsets.add(dims(zone, new Date(Date.UTC(2026, month, 15, 12)).toISOString()).utcOffsetMinutes);
      expect([...offsets]).toEqual([offset]);
      for (const week of weeks(zone, "2026-02-23T00:00:00Z", "2026-03-23T00:00:00Z").values()) expect(week.elapsed).toBeLessThanOrEqual(168);
      expect(weeks(zone, "2026-10-12T00:00:00Z", "2026-11-16T00:00:00Z").get("2026-10-26")!.elapsed).toBe(168);
    }
  });

  it("derives half-hour and 45-minute zones exactly, with the local hour changing on the quarter", () => {
    expect(dims("Asia/Kolkata", "2026-10-28T18:29:59Z")).toMatchObject({ localDate: "2026-10-28", localHour: 23, utcOffsetMinutes: 330 });
    expect(dims("Asia/Kolkata", "2026-10-28T18:30:00Z")).toMatchObject({ localDate: "2026-10-29", localHour: 0, utcOffsetMinutes: 330 });
    expect(dims("Asia/Kathmandu", "2026-10-28T18:15:00Z")).toMatchObject({ localDate: "2026-10-29", localHour: 0, utcOffsetMinutes: 345 });
    expect(dims("Asia/Kathmandu", "2026-10-28T18:00:00Z")).toMatchObject({ localDate: "2026-10-28", localHour: 23, utcOffsetMinutes: 345 });
    // The bucket grid is the finest unit these share with whole-hour zones: no bucket straddles a local hour.
    for (const zone of ["Asia/Kolkata", "Asia/Kathmandu", "Pacific/Chatham", "America/St_Johns", "Australia/Lord_Howe"]) {
      for (let t = Date.parse("2026-10-01T00:00:00Z"); t < Date.parse("2026-10-03T00:00:00Z"); t += BUCKET_MS) {
        expect(() => dims(zone, new Date(t).toISOString())).not.toThrow();
      }
    }
  });

  it("starts the Monday-based week correctly across the year boundary", () => {
    // 1 January 2027 is a Friday; its week began Monday 28 December 2026.
    expect(dims("America/Detroit", "2027-01-01T17:00:00Z")).toMatchObject({ localDate: "2027-01-01", weekday: 4, weekStartingMonday: "2026-12-28" });
    // New Year's Eve evening in Detroit is already 1 January in UTC: the local date wins.
    expect(dims("America/Detroit", "2027-01-01T02:00:00Z")).toMatchObject({ localDate: "2026-12-31", localHour: 21, weekday: 3, weekStartingMonday: "2026-12-28" });
    expect(dims("Pacific/Honolulu", "2027-01-01T09:30:00Z")).toMatchObject({ localDate: "2026-12-31", localHour: 23 });
  });

  it("classifies dates only from the district calendar: holiday, weekend, unknown", () => {
    const calendar: CalendarSpan[] = [
      { from: "2026-11-26", to: "2026-11-27", kind: "holiday" },
      { from: "2026-11-28", to: "2026-11-29", kind: "weekend" },
    ];
    expect(dims("America/Detroit", "2026-11-26T17:00:00Z", calendar).calendarKind).toBe("holiday");
    expect(dims("America/Detroit", "2026-11-29T17:00:00Z", calendar).calendarKind).toBe("weekend");
    // A Saturday/Sunday the calendar does not list is NOT inferred as a weekend; neither is a Wednesday as instructional.
    expect(dims("America/Detroit", "2026-11-22T17:00:00Z", calendar).calendarKind).toBe("unknown");
    expect(dims("America/Detroit", "2026-11-25T17:00:00Z", calendar).calendarKind).toBe("unknown");
    expect(dims("America/Detroit", "2026-11-25T17:00:00Z").calendarKind).toBe("unknown");
    expect(classifyLocalDate(calendar, "2026-11-30")).toBe("unknown");
    // The classification follows the LOCAL date, not the UTC date.
    expect(dims("America/Detroit", "2026-11-27T03:00:00Z", calendar)).toMatchObject({ localDate: "2026-11-26", calendarKind: "holiday" });
    expect(dims("America/Detroit", "2026-11-28T03:00:00Z", calendar)).toMatchObject({ localDate: "2026-11-27", calendarKind: "holiday" });
    expect(dims("America/Detroit", "2026-11-28T05:00:00Z", calendar)).toMatchObject({ localDate: "2026-11-28", calendarKind: "weekend" });
  });

  it("pins the zone, calendar and revision effective at the occurrence, across a configuration change", () => {
    const boundary = Date.UTC(2026, 10, 1, 12);
    const before: TenantInterval = { ...interval("America/Detroit"), fromMs: Date.UTC(2026, 0, 1), toMs: boundary, calendarRevision: "cal-1", calendar: [{ from: "2026-10-31", to: "2026-10-31", kind: "holiday" }] };
    const after: TenantInterval = { ...interval("America/Phoenix"), fromMs: boundary, toMs: Date.UTC(2027, 0, 1), calendarRevision: "cal-2", calendar: [{ from: "2026-10-31", to: "2026-10-31", kind: "weekend" }] };
    const at = (iso: string) => {
      const ms = Date.parse(iso);
      const chosen = resolveInterval([before, after], ms)!;
      return deriveTrustedDimensions(chosen === before ? "cfg-a" : "cfg-b", chosen, bucketStartOf(ms));
    };
    // Same local date, classified differently by the revision effective for each occurrence.
    expect(at("2026-10-31T18:00:00Z")).toMatchObject({ configRevision: "cfg-a", calendarRevision: "cal-1", timeZone: "America/Detroit", calendarKind: "holiday" });
    expect(at("2026-11-01T12:00:00Z")).toMatchObject({ configRevision: "cfg-b", calendarRevision: "cal-2", timeZone: "America/Phoenix", utcOffsetMinutes: -420 });
    // The last bucket before the boundary and the first after never share a revision.
    expect(at("2026-11-01T11:59:59Z").configRevision).toBe("cfg-a");
    expect(at("2026-11-01T12:00:00Z").configRevision).toBe("cfg-b");
    expect(boundary % BUCKET_MS).toBe(0);
  });

  it("refuses to pin a bucket that straddles a local hour or offset change instead of guessing", () => {
    // A window that is not on the 15-minute grid can cross a local hour boundary (Kolkata's hours
    // begin at :30 UTC); one row must never mix two local hours, so the derivation throws.
    const kolkata = interval("Asia/Kolkata");
    expect(() => deriveTrustedDimensions("cfg-test", kolkata, Date.parse("2026-10-28T18:20:00Z"))).toThrow();
    expect(() => deriveTrustedDimensions("cfg-test", kolkata, Date.parse("2026-10-28T18:15:00Z"))).not.toThrow();
    expect(() => deriveTrustedDimensions("cfg-test", kolkata, Date.parse("2026-10-28T18:30:00Z"))).not.toThrow();
    // A window straddling a DST offset change is likewise refused (Detroit falls back at 06:00Z).
    expect(() => deriveTrustedDimensions("cfg-test", interval("America/Detroit"), Date.parse("2026-11-01T05:50:00Z"))).toThrow();
  });
});
