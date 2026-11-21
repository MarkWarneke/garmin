import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySnapshot, selectData, normalizeWorkout, loadPlan } from '../src/data.mjs';
import { syncGarmin } from '../src/garmin.mjs';
import { normalizePlan, planDays, formCheckPrompt, PLAN_FORMAT } from '../public/shared/plan.mjs';
import { profilePrompt } from '../public/shared/profile.mjs';
import { createProxyFetch } from '../public/folder-workspace.mjs';
import { garminWorkout, response, mockGarmin } from './fixtures.mjs';

test('sync reads scheduled workouts with their steps and replaces the calendar window', async () => {
  const previous = emptySnapshot();
  previous.planned = [{ id: '1', date: '2026-11-18', workoutId: '5', name: 'Removed in Garmin' },
    { id: '2', date: '2026-11-01', workoutId: '6', name: 'Earlier plan' }];
  const mock = mockGarmin();
  const snapshot = await syncGarmin(previous, 'test-personal-key', { ...mock, days: 1, now: '2026-11-16' });
  assert.equal(snapshot.sync.fullySuccessful, true);
  assert.deepEqual(mock.calls.filter(c => c.url.pathname.startsWith('/calendar-service')).map(c => c.url.pathname),
    ['/calendar-service/year/2026/month/10', '/calendar-service/year/2026/month/11', '/calendar-service/year/2027/month/0'],
    'months from a week ago to eight weeks ahead, numbered from 0');
  assert.equal(mock.calls.filter(c => c.url.pathname.startsWith('/workout-service')).length, 1, 'each workout is fetched once');
  assert.deepEqual(snapshot.planned.map(w => w.name), ['Earlier plan', 'Tempo 3x6']);
  const [, tempo] = snapshot.planned;
  assert.equal(tempo.date, '2026-11-17'); assert.equal(tempo.workoutId, '77'); assert.equal(tempo.sport, 'cycling');
  assert.equal(tempo.durationSeconds, 600 + 3 * 660);
  assert.deepEqual(tempo.steps[1].steps[0], { type: 'interval', durationSeconds: 360, target: 'power.zone', targetLow: 190, targetHigh: 205, description: null });
  assert.doesNotMatch(JSON.stringify(snapshot.planned), /ownerId|1234/);
  assert.equal(selectData(snapshot, 7, '2026-11-16').planned.length, 1, 'upcoming workouts reach the assistant');
});
test('a calendar the Personal API does not offer is one warning and keeps the saved plan', async () => {
  const previous = emptySnapshot();
  previous.planned = [{ id: '1', date: '2026-11-18', workoutId: '5', name: 'Saved' }];
  const mock = mockGarmin(url => url.pathname.startsWith('/calendar-service') ? response({}, 403) : null);
  const snapshot = await syncGarmin(previous, 'test-personal-key', { ...mock, days: 1, now: '2026-11-16' });
  assert.deepEqual(snapshot.sync.warnings.map(w => [w.source, w.status]), [['planned', 403]]);
  assert.equal(mock.calls.filter(c => c.url.pathname.startsWith('/calendar-service')).length, 1);
  assert.deepEqual(snapshot.planned.map(w => w.name), ['Saved']);
  assert.equal(snapshot.health.length, 1, 'other data still syncs');
});
test('workout duration falls back to the sum of timed steps', () => {
  const w = garminWorkout();
  assert.equal(normalizeWorkout(w).durationSeconds, 2580);
  assert.equal(normalizeWorkout({ ...w, estimatedDurationInSecs: 3600 }).durationSeconds, 3600);
  assert.equal(normalizeWorkout(null).steps, null);
});
test('plan.json keeps only bounded known fields and a valid example', () => {
  const plan = normalizePlan({ title: 'Base', injected: 'x', sessions: [
    { date: '2026-11-24', sport: 'cycling', title: 'Tempo', durationMinutes: 60, garminWorkoutId: 1768732566, status: 'planned', script: '<b>' },
    { date: '2026-02-30', title: 'Invalid day' }, { date: '2026-11-25' }, { date: '2026-11-23', title: 'Yoga', durationMinutes: -5, status: 'maybe' }],
    weeks: [{ startDate: '2026-11-23', focus: 'Return', targetHours: 99 }] });
  assert.equal(plan.injected, undefined);
  assert.deepEqual(plan.sessions.map(s => s.title), ['Yoga', 'Tempo']);
  assert.equal(plan.sessions[1].garminWorkoutId, '1768732566'); assert.equal(plan.sessions[1].script, undefined);
  assert.equal(plan.sessions[0].durationMinutes, null); assert.equal(plan.sessions[0].status, null);
  assert.equal(plan.weeks[0].targetHours, null);
  assert.equal(normalizePlan([]), null);
  assert.equal(normalizePlan(JSON.parse(PLAN_FORMAT)).sessions.length, 1);
  assert.match(profilePrompt({}), /save the plan there as plan\.json/);
});
test('plan days enrich sessions with the scheduled Garmin workout and the recorded activity', () => {
  const plan = normalizePlan({ sessions: [{ date: '2026-11-24', sport: 'cycling', title: 'Tempo', garminWorkoutId: '77' },
    { date: '2026-11-25', sport: 'strength', title: 'Gym' }] });
  const planned = [{ id: '1', date: '2026-11-24', workoutId: '77', sport: 'cycling', name: 'Tempo 3x6' },
    { id: '2', date: '2026-11-25', workoutId: '78', sport: 'yoga', name: 'Yoga' }];
  const activities = [{ id: 'a', date: '2026-11-24', sport: 'indoor_cycling', name: 'Indoor Cycling' },
    { id: 'b', date: '2026-11-25', sport: 'strength_training', name: 'Strength' }];
  const [tue, wed] = planDays({ plan, planned, activities }, ['2026-11-24', '2026-11-25']);
  assert.equal(tue.sessions[0].garmin.name, 'Tempo 3x6'); assert.equal(tue.sessions[0].activity.id, 'a');
  assert.equal(tue.workouts.length, 0); assert.equal(tue.activities.length, 0);
  assert.equal(wed.sessions[0].garmin, null, 'a different sport is not claimed');
  assert.equal(wed.sessions[0].activity.id, 'b');
  assert.equal(wed.workouts[0].garmin.name, 'Yoga');
  assert.equal(planDays({ plan: null, planned: [], activities: [] }, ['2026-11-24'])[0].sessions.length, 0);
});
test('plan.json is read from the data folder and a broken file is reported, not fatal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cadence-plan-'));
  assert.deepEqual(await loadPlan(directory), { plan: null, error: null });
  await writeFile(join(directory, 'plan.json'), '{broken');
  assert.match((await loadPlan(directory)).error, /not valid JSON/);
  await writeFile(join(directory, 'plan.json'), JSON.stringify({ title: 'Base', sessions: [{ date: '2026-11-24', title: 'Tempo' }] }));
  assert.equal((await loadPlan(directory)).plan.sessions[0].title, 'Tempo');
});
test('the hosted relay maps calendar and workout requests', async () => {
  const calls = [];
  const proxy = createProxyFetch(async (url, options) => { calls.push([url, JSON.parse(options.body)]); return response({}); });
  await proxy('https://personal.connectapi.garmin.com/calendar-service/year/2026/month/10', { headers: { Authorization: 'Bearer x' } });
  await proxy('https://personal.connectapi.garmin.com/workout-service/workout/77', { headers: { Authorization: 'Bearer x' } });
  assert.deepEqual(calls, [['/api/garmin/calendar', { year: '2026', month: '10' }], ['/api/garmin/workout', { workoutId: '77' }]]);
});
test("today's form prompt lists today's session with Garmin steps, the next days, and two weeks of recovery data", () => {
  const snapshot = emptySnapshot();
  snapshot.health = [{ date: '2026-11-01', hrvMs: 40 }, { date: '2026-11-20', hrvMs: 65, restingHeartRate: 50 }, { date: '2026-11-24', hrvMs: 52, restingHeartRate: 54 }];
  snapshot.planned = [{ id: '1', date: '2026-11-24', workoutId: '77', name: 'Tempo 3x6', sport: 'cycling', ...normalizeWorkout(garminWorkout()) },
    { id: '2', date: '2026-11-26', workoutId: '78', name: 'Grundlage 60', sport: 'cycling', durationSeconds: 3600, steps: null }];
  const plan = normalizePlan({ notes: 'Yellow: drop intensity.', weeks: [{ startDate: '2026-11-23', focus: 'Return' }],
    sessions: [{ date: '2026-11-24', sport: 'cycling', title: 'Tempo', intensity: '190–205 W', garminWorkoutId: '77' }] });
  const prompt = formCheckPrompt({ data: selectData(snapshot, 28, '2026-11-24'), plan, profile: { ftpWatts: 250 } });
  assert.match(prompt, /check my form today \(Tue 2026-11-24\)/);
  assert.match(prompt, /- Tempo \(cycling\) – 190–205 W\. Garmin workout: Tempo 3x6, 43 min, steps: 10m 120–150 W · 3× \(6m 190–205 W \/ 5m\)\./);
  assert.match(prompt, /- Thu 2026-11-26: Garmin workout: Grundlage 60, 60 min\./);
  const data = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.deepEqual(data.health.map(d => d.date), ['2026-11-20', '2026-11-24'], 'two weeks of health, not the whole range');
  assert.equal(data.athlete.ftpWatts, 250); assert.equal(data.plan.week.focus, 'Return');
  assert.match(formCheckPrompt({ data: selectData(emptySnapshot(), 28, '2026-11-24') }), /Nothing planned today/);
});
