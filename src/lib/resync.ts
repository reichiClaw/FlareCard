import type { Storage } from "../storage/types";
import type { ContactService } from "./contacts";

/**
 * Scheduled "force push" of the address book.
 *
 * CardDAV is pull-only: devices download what changed since their last sync
 * token. A forced re-sync gives every contact a new revision and ETag, so on
 * the next sync every phone and Mac downloads the whole address book again.
 * That restores contacts that were deleted or edited locally without waiting
 * for the client to notice its rejected change.
 *
 * FlareCard runs on a single Durable Object without cron triggers, so the
 * schedule is evaluated lazily: every incoming request first checks whether a
 * run is due. Devices sync often enough that this is indistinguishable from a
 * timer, and a run only ever happens when there is someone to sync with.
 */

export type ResyncMode = "off" | "interval" | "daily" | "weekly";

export interface ResyncSchedule {
  mode: ResyncMode;
  /** interval mode: hours between runs (1..168). */
  everyHours: number;
  /** daily/weekly mode: local time "HH:MM". */
  time: string;
  /** weekly mode: 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** IANA time zone the time refers to. */
  timeZone: string;
}

export interface ResyncRun {
  at: string;
  contacts: number;
  reason: "schedule" | "manual";
}

export interface ResyncStatus {
  schedule: ResyncSchedule;
  lastRun: ResyncRun | null;
  nextRun: string | null;
  /** Human-readable description of the schedule. */
  description: string;
}

export const DEFAULT_SCHEDULE: ResyncSchedule = {
  mode: "off",
  everyHours: 24,
  time: "03:00",
  weekday: 0,
  timeZone: "UTC",
};

const SCHEDULE_SETTING = "resync_schedule";
const LAST_RUN_SETTING = "resync_last_run";
const NEXT_RUN_SETTING = "resync_next_run";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export class ResyncError extends Error {}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates arbitrary JSON into a schedule, throwing ResyncError on bad input. */
export function parseSchedule(input: unknown): ResyncSchedule {
  if (!input || typeof input !== "object") throw new ResyncError("Schedule must be an object");
  const src = input as Record<string, unknown>;
  const mode = src.mode;
  if (mode !== "off" && mode !== "interval" && mode !== "daily" && mode !== "weekly") {
    throw new ResyncError("mode must be one of off, interval, daily, weekly");
  }
  const everyHours = src.everyHours === undefined ? DEFAULT_SCHEDULE.everyHours : Number(src.everyHours);
  if (!Number.isInteger(everyHours) || everyHours < 1 || everyHours > 168) {
    throw new ResyncError("everyHours must be a whole number between 1 and 168");
  }
  const time = typeof src.time === "string" ? src.time.trim() : DEFAULT_SCHEDULE.time;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ResyncError("time must be HH:MM (24-hour)");
  const weekday = src.weekday === undefined ? DEFAULT_SCHEDULE.weekday : Number(src.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new ResyncError("weekday must be 0 (Sunday) to 6 (Saturday)");
  const timeZone = typeof src.timeZone === "string" && src.timeZone.trim() ? src.timeZone.trim() : DEFAULT_SCHEDULE.timeZone;
  if (!isValidTimeZone(timeZone)) throw new ResyncError(`Unknown time zone "${timeZone}"`);
  return { mode, everyHours, time, weekday, timeZone };
}

export function describeSchedule(s: ResyncSchedule): string {
  switch (s.mode) {
    case "off":
      return "Off";
    case "interval":
      return s.everyHours === 1 ? "Every hour" : s.everyHours % 24 === 0 && s.everyHours > 24 ? `Every ${s.everyHours / 24} days` : `Every ${s.everyHours} hours`;
    case "daily":
      return `Daily at ${s.time} (${s.timeZone})`;
    case "weekly":
      return `Every ${WEEKDAYS[s.weekday]} at ${s.time} (${s.timeZone})`;
  }
}

// ---------------------------------------------------------------------------
// Time zone arithmetic (Intl only; no tz database shipped with the Worker)

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Wall-clock parts of `at` in `timeZone`. */
export function localParts(at: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(at)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: SHORT_WEEKDAYS.indexOf(parts.weekday),
  };
}

/** Offset of `timeZone` from UTC at instant `at`, in ms (positive east of Greenwich). */
function offsetAt(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the wall clock in `timeZone` shows the given date and
 * time. Around DST transitions a non-existent time resolves to the instant after
 * the gap; an ambiguous time resolves to its first occurrence.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const o1 = offsetAt(new Date(wall), timeZone);
  let candidate = wall - o1;
  const o2 = offsetAt(new Date(candidate), timeZone);
  if (o2 !== o1) {
    const alternative = wall - o2;
    // A consistent candidate maps back onto the requested wall time; when neither
    // does, the time falls into a DST gap and the later instant is used.
    if (offsetAt(new Date(alternative), timeZone) === o2) candidate = alternative;
    else candidate = Math.max(candidate, alternative);
  }
  return new Date(candidate);
}

/** First instant strictly after `after` at which the schedule fires, or null when off. */
export function nextOccurrence(s: ResyncSchedule, after: Date, lastRun: Date | null = null): Date | null {
  switch (s.mode) {
    case "off":
      return null;
    case "interval": {
      const base = lastRun ?? after;
      return new Date(base.getTime() + s.everyHours * HOUR);
    }
    case "daily":
    case "weekly": {
      const [hh, mm] = s.time.split(":").map(Number);
      // Start from the local calendar day of `after` and walk forward day by day.
      const start = localParts(after, s.timeZone);
      for (let i = 0; i < 9; i++) {
        const dayUtc = new Date(Date.UTC(start.year, start.month - 1, start.day + i, 12));
        const candidate = zonedTimeToUtc(dayUtc.getUTCFullYear(), dayUtc.getUTCMonth() + 1, dayUtc.getUTCDate(), hh, mm, s.timeZone);
        if (candidate.getTime() <= after.getTime()) continue;
        if (s.mode === "weekly" && localParts(candidate, s.timeZone).weekday !== s.weekday) continue;
        return candidate;
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------

export class ResyncScheduler {
  /** In-memory mirror of NEXT_RUN_SETTING so a tick is a number comparison. */
  private nextRunMs: number | null | undefined;
  private running: Promise<ResyncRun> | null = null;

  constructor(
    private storage: Storage,
    private contacts: ContactService,
    private now: () => Date = () => new Date(),
  ) {}

  async getSchedule(): Promise<ResyncSchedule> {
    const raw = await this.storage.getSetting(SCHEDULE_SETTING);
    if (!raw) return { ...DEFAULT_SCHEDULE };
    try {
      return parseSchedule(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_SCHEDULE };
    }
  }

  async lastRun(): Promise<ResyncRun | null> {
    const raw = await this.storage.getSetting(LAST_RUN_SETTING);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ResyncRun;
    } catch {
      return null;
    }
  }

  private async nextRun(): Promise<number | null> {
    if (this.nextRunMs === undefined) {
      const raw = await this.storage.getSetting(NEXT_RUN_SETTING);
      const n = raw ? Number(raw) : NaN;
      this.nextRunMs = Number.isFinite(n) && n > 0 ? n : null;
    }
    return this.nextRunMs;
  }

  private async setNextRun(at: Date | null): Promise<void> {
    this.nextRunMs = at ? at.getTime() : null;
    await this.storage.setSetting(NEXT_RUN_SETTING, at ? String(at.getTime()) : "");
  }

  async status(): Promise<ResyncStatus> {
    const schedule = await this.getSchedule();
    const next = await this.nextRun();
    return {
      schedule,
      lastRun: await this.lastRun(),
      nextRun: schedule.mode !== "off" && next ? new Date(next).toISOString() : null,
      description: describeSchedule(schedule),
    };
  }

  /** Validates and stores a schedule; the first run is computed from now. */
  async setSchedule(input: unknown): Promise<ResyncStatus> {
    const schedule = parseSchedule(input);
    await this.storage.setSetting(SCHEDULE_SETTING, JSON.stringify(schedule));
    await this.setNextRun(nextOccurrence(schedule, this.now()));
    return this.status();
  }

  /** Runs a forced re-sync immediately; concurrent calls share one run. */
  runNow(reason: ResyncRun["reason"] = "manual"): Promise<ResyncRun> {
    if (this.running) return this.running;
    this.running = (async () => {
      const at = this.now();
      const contacts = await this.contacts.forceResync(at);
      const run: ResyncRun = { at: at.toISOString(), contacts, reason };
      await this.storage.setSetting(LAST_RUN_SETTING, JSON.stringify(run));
      return run;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** True when a scheduled run is overdue. Cheap: reads storage once per instance. */
  async isDue(): Promise<boolean> {
    const next = await this.nextRun();
    return next !== null && this.now().getTime() >= next;
  }

  /**
   * Called on every request: performs the scheduled run if it is due and moves
   * the schedule forward. Missed occurrences (no traffic for days) collapse into
   * a single run; the next one is computed from the actual run time.
   */
  async tick(): Promise<ResyncRun | null> {
    if (!(await this.isDue())) return null;
    if (this.running) return null;
    const schedule = await this.getSchedule();
    if (schedule.mode === "off") {
      await this.setNextRun(null);
      return null;
    }
    const run = await this.runNow("schedule");
    await this.setNextRun(nextOccurrence(schedule, this.now(), new Date(run.at)));
    return run;
  }
}
