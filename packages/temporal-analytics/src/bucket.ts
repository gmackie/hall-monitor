import { parseTemporalMetricEvent, type TemporalMetricEvent } from "./events.ts";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** UTC-to-institution-local time only. Never use a student's IP/geolocation. */
function formatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatterCache.get(timeZone);
  if (existing !== undefined) return existing;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", hourCycle: "h23",
    timeZoneName: "shortOffset",
  });
  formatterCache.set(timeZone, created);
  return created;
}

/** Dimensions are calendar-local; hour 1 may occur twice on a DST fall-back date. */
export interface LocalTimeBucket {
  readonly timeZone: string;
  readonly localDate: string;
  readonly localHour: number;
  /** Monday=0 to Sunday=6. */
  readonly weekday: number;
  /** 0..167; repeated DST hours contribute twice to this cell. */
  readonly hourOfWeek: number;
  readonly weekStartingMonday: string;
  /** Actual local UTC offset. Distinguishes repeated fall-back hours. */
  readonly utcOffsetMinutes: number;
}

export function localTimeBucket(utcIso: string, timeZone: string): LocalTimeBucket {
  // Validate via the same strict time semantics as an admitted metric.
  parseTemporalMetricEvent({
    schemaVersion: 1, occurredAt: utcIso, kind: "content_evaluated",
    category: "none", priority: "routine", modality: "text",
    gradeBand: "unspecified", source: "hall_monitor", calendarKind: "unknown",
  } satisfies TemporalMetricEvent);

  const parts = formatter(timeZone).formatToParts(new Date(utcIso));
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === name)?.value;
  const year = part("year"), month = part("month"), day = part("day");
  const hourText = part("hour"), dayText = part("weekday"), zone = part("timeZoneName");
  const localHour = Number(hourText);
  const weekday = WEEKDAYS.indexOf(dayText as (typeof WEEKDAYS)[number]);
  if (year === undefined || month === undefined || day === undefined ||
      weekday < 0 || !Number.isInteger(localHour) || localHour < 0 || localHour > 23 ||
      zone === undefined) {
    throw new TypeError("unable to derive institutional local time");
  }
  const match = /^GMT(?:(?<sign>[+-])(?<h>\d{1,2})(?::(?<m>\d{2}))?)?$/.exec(zone);
  if (match === null) throw new TypeError("unsupported IANA UTC offset representation");
  const hours = Number(match.groups?.h ?? 0);
  const minutes = Number(match.groups?.m ?? 0);
  const sign = match.groups?.sign === "-" ? -1 : 1;
  if (hours > 14 || minutes > 59) throw new TypeError("invalid local UTC offset");
  const utcOffsetMinutes = sign * (hours * 60 + minutes);
  const localDate = year + "-" + month + "-" + day;
  const monday = new Date(localDate + "T00:00:00.000Z");
  monday.setUTCDate(monday.getUTCDate() - weekday);
  return {
    timeZone, localDate, localHour, weekday,
    hourOfWeek: weekday * 24 + localHour,
    weekStartingMonday: monday.toISOString().slice(0, 10),
    utcOffsetMinutes,
  };
}
