// Coaching metrics derived from saved activities. Pure functions: no Garmin requests, no stored state.
const addDays = (day, amount) => new Date(Date.parse(`${day}T12:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
const round = (value, digits = 1) => value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
const sum = values => values.reduce((total, v) => total + (v || 0), 0);

// The FTP Garmin used for each ride, in date order, keeping only changes.
export function ftpHistory(activities) {
  const history = [];
  for (const a of [...activities].filter(a => a.ftpWatts).sort((a, b) => a.date.localeCompare(b.date))) {
    if (history.at(-1)?.ftpWatts !== a.ftpWatts) history.push({ date: a.date, ftpWatts: a.ftpWatts });
  }
  return history;
}
export const ftpOn = (history, day) => history.findLast(h => h.date <= day)?.ftpWatts ?? history[0]?.ftpWatts ?? null;

// Training stress score: Garmin's when it has one, else duration × NP² / FTP² with the FTP valid on that day.
export function sessionStress(activity, ftp = activity.ftpWatts) {
  if (activity.trainingStressScore != null) return activity.trainingStressScore;
  if (!activity.normalizedPower || !ftp || !activity.durationSeconds) return null;
  return activity.durationSeconds * activity.normalizedPower ** 2 / (ftp ** 2 * 3600) * 100;
}

// Fitness (42-day) and fatigue (7-day) exponentially weighted averages of Garmin's activity training load.
// Garmin load covers every sport, including gym sessions without power, so one scale fits all activities.
export function trainingLoad(activities, endDate, { days = 42 } = {}) {
  const loads = new Map();
  for (const a of activities) if (a.date <= endDate) loads.set(a.date, (loads.get(a.date) || 0) + (a.trainingLoad || 0));
  const first = [...loads.keys()].sort()[0];
  if (!first) return null;
  let fitness = 0, fatigue = 0, historyDays = 0;
  const daily = [];
  for (let day = first; day <= endDate; day = addDays(day, 1)) {
    const load = loads.get(day) || 0;
    fitness += (load - fitness) / 42; fatigue += (load - fatigue) / 7; historyDays++;
    if (day > addDays(endDate, -days)) daily.push({ date: day, load: round(load), fitness: round(fitness), fatigue: round(fatigue), form: round(fitness - fatigue) });
  }
  return { method: 'Exponentially weighted Garmin activity training load: fitness over 42 days, fatigue over 7 days, form = fitness − fatigue.',
    historyDays, reliable: historyDays >= 42, current: daily.at(-1), daily };
}

const monday = day => addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
export function weeklySummary(activities, endDate, weeks = 12) {
  const history = ftpHistory(activities), first = addDays(monday(endDate), -7 * (weeks - 1));
  return Array.from({ length: weeks }, (_, i) => {
    const weekStart = addDays(first, 7 * i), weekEnd = addDays(weekStart, 6);
    const rows = activities.filter(a => a.date >= weekStart && a.date <= weekEnd && a.date <= endDate);
    const zoneMinutes = (field, count) => rows.some(a => a[field])
      ? Array.from({ length: count }, (_, z) => round(sum(rows.map(a => a[field]?.[z])) / 60, 0)) : null;
    const hoursBySport = {};
    for (const a of rows) hoursBySport[a.sport] = round((hoursBySport[a.sport] || 0) + (a.durationSeconds || 0) / 3600, 2);
    const stress = rows.map(a => sessionStress(a, a.ftpWatts ?? ftpOn(history, a.date)));
    return { weekStart, sessions: rows.length, hours: round(sum(rows.map(a => a.durationSeconds)) / 3600, 1),
      distanceKm: round(sum(rows.map(a => a.distanceMeters)) / 1000, 1), garminLoad: round(sum(rows.map(a => a.trainingLoad)), 0),
      trainingStress: stress.some(v => v != null) ? round(sum(stress), 0) : null, hoursBySport,
      hrZoneMinutes: zoneMinutes('hrTimeInZoneSeconds', 5), powerZoneMinutes: zoneMinutes('powerTimeInZoneSeconds', 7) };
  });
}

// Best average power per duration, across all saved history and the last 90 days.
export function powerCurve(activities, endDate) {
  const best = rows => {
    const curve = {};
    for (const a of rows) for (const [seconds, watts] of Object.entries(a.bestPowerWatts || {})) {
      if (!curve[seconds] || watts > curve[seconds].watts) curve[seconds] = { watts, date: a.date, activityId: a.id };
    }
    return Object.keys(curve).length ? curve : null;
  };
  const past = activities.filter(a => a.date <= endDate);
  return { allTime: best(past), last90Days: best(past.filter(a => a.date > addDays(endDate, -90))) };
}

export function coaching(activities, endDate) {
  return { trainingLoad: trainingLoad(activities, endDate), weekly: weeklySummary(activities, endDate),
    powerCurve: powerCurve(activities, endDate), ftpHistory: ftpHistory(activities) };
}
