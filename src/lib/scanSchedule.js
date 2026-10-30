// How many store-scan searches may have run by a given moment this month.
// The monthly budget is split across days by weight, favoring the days
// Walmart most often marks prices down, and each day's share is spent during
// the morning (prices change overnight). Unused searches carry forward.

export const SCHEDULE = Object.freeze({
  timeZone: 'America/Chicago',
  morningStartHour: 6,
  morningEndHour: 10,
  weekdayWeights: { Wed: 3, Thu: 3 }, // most-reported markdown days
  firstWeekWeight: 2, // monthly clearance markdowns tend to land early in the month
  firstWeekDays: 7,
});

/** Calendar parts of a moment in the schedule's time zone. */
export function localParts(date, timeZone = SCHEDULE.timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      weekday: 'short', hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) + Number(parts.minute) / 60,
    weekday: parts.weekday,
    monthKey: `${parts.year}-${parts.month}`,
  };
}

function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

export function dayWeight(year, month, day, schedule = SCHEDULE) {
  let w = schedule.weekdayWeights[weekdayOf(year, month, day)] ?? 1;
  if (day <= schedule.firstWeekDays) w *= schedule.firstWeekWeight;
  return w;
}

/** Each day's share of the monthly budget, e.g. [{ day: 1, weekday: 'Sun', searches: 9.3 }, ...]. */
export function monthPlan(year, month, budget, schedule = SCHEDULE) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weights = Array.from({ length: days }, (_, i) => dayWeight(year, month, i + 1, schedule));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w, i) => ({
    day: i + 1,
    weekday: weekdayOf(year, month, i + 1),
    searches: Number(((budget * w) / total).toFixed(2)),
  }));
}

/** Searches allowed so far this month (whole number), counting today's morning progress. */
export function allowanceSoFar(now, budget, schedule = SCHEDULE) {
  const t = localParts(now, schedule.timeZone);
  const plan = monthPlan(t.year, t.month, budget, schedule);
  const before = plan.slice(0, t.day - 1).reduce((a, d) => a + d.searches, 0);
  const span = schedule.morningEndHour - schedule.morningStartHour;
  const todayShare = Math.min(1, Math.max(0, (t.hour - schedule.morningStartHour) / span));
  return Math.min(budget, Math.floor(before + plan[t.day - 1].searches * todayShare + 1e-9));
}
