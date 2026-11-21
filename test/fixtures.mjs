export const activity = (id = 1, day = '2026-11-16') => ({ activityId: id, activityName: 'Evening ride', startTimeLocal: `${day} 18:00:00`,
  startTimeGMT: `${day} 17:00:00`, activityType: { typeKey: 'road_cycling' }, duration: 3600, distance: 25000, averageHR: 135,
  maxHR: 170, elevationGain: 220, activityTrainingLoad: 68, aerobicTrainingEffect: 2.8,
  startLatitude: 52.52, startLongitude: 13.4, userProfileId: 1234,
});
export const daily = (day = '2026-11-16') => ({ calendarDate: day, heartRate: { restingValue: 52 }, movement: { steps: { value: 7000 } },
  stress: { avgLevel: 29 }, bodyBattery: { maxValue: 81, minValue: 24, latestValue: 36 } });
export const sleep = (day = '2026-11-16') => ({ calendarDate: day, sleepTimeSeconds: 27000, deepSleepSeconds: 5000,
  remSleepSeconds: 6000, lightSleepSeconds: 16000, sleepScores: { overall: { value: 85 } } });
export const hrv = (day = '2026-11-16') => ({ calendarDate: day, lastNightAvg: 55, weeklyAvg: 53, status: 'BALANCED',
  baseline: { lowUpper: 44, balancedLow: 48, balancedUpper: 62, markerValue: 0.5 } });
export const settings = () => ({ displayName: 'private-display-name', availableTrainingDays: ['SATURDAY', 'MONDAY', 'WEDNESDAY'],
  preferredLongTrainingDays: ['SATURDAY'], timeZone: 'Europe/Berlin' });
export const zones = () => [{ sport: 'DEFAULT', trainingMethod: 'HR_MAX', maxHeartRateUsed: 190, restingHeartRateUsed: 50, zone1Floor: 95 },
  { sport: 'CYCLING', trainingMethod: 'LACTATE_THRESHOLD', maxHeartRateUsed: 189, restingHeartRateUsed: 52, lactateThresholdHeartRateUsed: 168,
    zone1Floor: 101, zone2Floor: 126, zone3Floor: 145, zone4Floor: 160, zone5Floor: 170 }];
export const weight = () => ({ dailyWeightSummaries: [{ summaryDate: '2026-11-10', latestWeight: { calendarDate: '2026-11-10', weight: 80.4 } }] });
export const details = () => ({ activityId: 1, userProfileId: 1234, summaryDTO: { functionalThresholdPower: 250, directWorkoutRpe: 70,
  directWorkoutFeel: 75, normalizedPower: 205, startLatitude: 52.52 },
  splitSummaries: [{ splitType: 'INTERVAL_ACTIVE', noOfSplits: 5, duration: 1500, averagePower: 260, normalizedPower: 262,
    averageHR: 165, startLatitude: 52.52, startLongitude: 13.4, endLatitude: 52.53, endLongitude: 13.41 },
  { splitType: 'INTERVAL_REST', noOfSplits: 4, duration: 600, averagePower: 120 }] });
export const workouts = () => [{ workoutName: '5x5 VO2', steps: [{ stepIndex: 1, intensity: 'INTERVAL', durationType: 'TIME',
  durationValue: 300, targetType: 'POWER', targetValueLow: 255, targetValueHigh: 270 }] }];
export const calendar = (day = '2026-11-17') => ({ calendarItems: [
  { id: 901, itemType: 'workout', date: day, title: 'Tempo 3x6', workoutId: 77, sportTypeKey: 'cycling' },
  { id: 902, itemType: 'activity', date: day, title: 'Evening ride' }] });
export const garminWorkout = () => ({ workoutId: 77, workoutName: 'Tempo 3x6', description: 'Gentle tempo', ownerId: 1234,
  sportType: { sportTypeId: 2, sportTypeKey: 'cycling' },
  workoutSegments: [{ workoutSteps: [
    { type: 'ExecutableStepDTO', stepType: { stepTypeKey: 'warmup' }, endCondition: { conditionTypeKey: 'time' }, endConditionValue: 600,
      targetType: { workoutTargetTypeKey: 'power.zone' }, targetValueOne: 120, targetValueTwo: 150 },
    { type: 'RepeatGroupDTO', numberOfIterations: 3, workoutSteps: [
      { type: 'ExecutableStepDTO', stepType: { stepTypeKey: 'interval' }, endCondition: { conditionTypeKey: 'time' }, endConditionValue: 360,
        targetType: { workoutTargetTypeKey: 'power.zone' }, targetValueOne: 190, targetValueTwo: 205 },
      { type: 'ExecutableStepDTO', stepType: { stepTypeKey: 'recovery' }, endCondition: { conditionTypeKey: 'time' }, endConditionValue: 300,
        targetType: { workoutTargetTypeKey: 'no.target' } }] }] }] });
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
    if (parsed.pathname.endsWith('/userprofile/settings')) return response(settings());
    if (parsed.pathname.endsWith('/heartRateZones/v2')) return response(zones());
    if (parsed.pathname.includes('/weight/range/')) return response(weight());
    if (/\/activity-service\/activity\/\d+$/.test(parsed.pathname)) return response(details());
    if (/\/activity-service\/activity\/\d+\/workouts$/.test(parsed.pathname)) return response(workouts());
    if (/^\/calendar-service\/year\/\d{4}\/month\/\d{1,2}$/.test(parsed.pathname)) return response(calendar());
    if (/^\/workout-service\/workout\/\d+$/.test(parsed.pathname)) return response(garminWorkout());
    throw new Error(`Unexpected test endpoint: ${parsed.pathname}`);
  };
  return { fetchImpl, calls };
}
