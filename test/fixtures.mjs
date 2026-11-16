export const activity = (id = 1, day = '2026-11-16') => ({ activityId: id, activityName: 'Evening ride', startTimeLocal: `${day} 18:00:00`,
  startTimeGMT: `${day} 17:00:00`, activityType: { typeKey: 'road_cycling' }, duration: 3600, distance: 25000, averageHR: 135,
  maxHR: 170, elevationGain: 220, activityTrainingLoad: 68, aerobicTrainingEffect: 2.8,
  startLatitude: 52.52, startLongitude: 13.4, userProfileId: 1234,
});
export const daily = (day = '2026-11-16') => ({ calendarDate: day, heartRate: { restingValue: 52 }, movement: { steps: { value: 7000 } },
  stress: { avgLevel: 29 }, bodyBattery: { maxValue: 81, minValue: 24, latestValue: 36 } });
export const sleep = (day = '2026-11-16') => ({ calendarDate: day, sleepTimeSeconds: 27000, deepSleepSeconds: 5000,
  remSleepSeconds: 6000, lightSleepSeconds: 16000, sleepScores: { overall: { value: 85 } } });
export const hrv = (day = '2026-11-16') => ({ calendarDate: day, lastNightAvg: 55, weeklyAvg: 53, status: 'BALANCED' });
export const response = (data, status = 200, headers) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
export function mockGarmin(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, options });
    const custom = handler?.(parsed, options, calls);
    if (custom) return custom;
    if (parsed.pathname.endsWith('/personal-api-key/token')) return new Response('test-access-token', { headers: { 'content-type': 'text/plain' } });
    if (parsed.pathname.includes('search/activities')) return response([activity()]);
    if (parsed.pathname.includes('dailysummaries')) return response({ data: [daily()] });
    if (parsed.pathname.includes('dailySleepSummariesByDate')) return response([sleep()]);
    if (parsed.pathname.includes('/hrv/daily/')) return response({ hrvSummaries: [hrv()] });
    throw new Error(`Unexpected test endpoint: ${parsed.pathname}`);
  };
  return { fetchImpl, calls };
}
