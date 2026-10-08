const PACIFIC = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Search Console counts days in Pacific Time; this is today's date there. */
export function pacificToday(now: Date = new Date()): string {
  return PACIFIC.format(now);
}

export function shiftDate(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The default query window: 28 days ending three days ago (Pacific Time),
 * which is the newest day Google has usually finalized.
 */
export function defaultDateRange(now: Date = new Date()): { start: string; end: string } {
  const end = shiftDate(pacificToday(now), -3);
  return { start: shiftDate(end, -27), end };
}
