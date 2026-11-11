// Clock helpers for the daily store-check cycle, which runs on Chicago time.

const TIME_ZONE = 'America/Chicago';

/** Calendar parts of a moment in the schedule's time zone; hour is fractional (5.5 = 5:30). */
export function localParts(date, timeZone = TIME_ZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) + Number(parts.minute) / 60,
  };
}

/**
 * The schedule "day" a moment belongs to, when days start at `startHour`
 * (local, possibly fractional) instead of midnight: before 4am counts as the
 * previous day for a 4am start. Returns YYYY-MM-DD.
 */
export function scheduleDayKey(date, startHour = 0, timeZone = TIME_ZONE) {
  const t = localParts(new Date(date.getTime() - startHour * 3600000), timeZone);
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

/** "05:30" -> 5.5; anything unparseable -> fallback. */
export function parseClock(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fallback;
  return Number(m[1]) + Number(m[2]) / 60;
}
