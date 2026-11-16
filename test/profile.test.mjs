import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfile, profilePrompt, planHandoff, emptyProfile, PROFILE_FIELDS } from '../public/shared/profile.mjs';

test('profiles keep only known fields within bounds', () => {
  const p = normalizeProfile({ goal: '  Ride 120 km  ', ftpWatts: '250', weightKg: 1000, eventDate: '2027-02-30',
    experience: 'pro', prompt: '   ', injected: 'x', updatedAt: 'nope' });
  assert.equal(p.goal, 'Ride 120 km'); assert.equal(p.ftpWatts, 250); assert.equal(p.weightKg, null);
  assert.equal(p.eventDate, null); assert.equal(p.experience, null); assert.equal(p.prompt, null);
  assert.equal(p.injected, undefined); assert.equal(p.updatedAt, null);
  assert.deepEqual(Object.keys(normalizeProfile(null)), Object.keys(emptyProfile()));
  assert.ok(PROFILE_FIELDS.every(f => f.why), 'every field explains why it is needed');
});
test('the generated prompt states provided details and asks for missing essentials instead of inventing them', () => {
  const prompt = profilePrompt({ goal: 'Gran fondo', eventDate: '2027-03-01', ftpWatts: 250, ftpTestDate: '2026-10-12', weightKg: 80,
    daysPerWeek: 4, hoursPerWeek: 7 }, { days: 90, today: '2026-11-16' });
  assert.match(prompt, /Today is 2026-11-16/);
  assert.match(prompt, /FTP: 250 W \(tested 2026-10-12\)/);
  assert.match(prompt, /3\.13 W\/kg/);
  assert.match(prompt, /on 2027-03-01 \(15 weeks from today\)/);
  assert.match(prompt, /4 days per week, about 7 hours per week/);
  assert.match(prompt, /ask me about: my training background, which sports to include\./);
  assert.doesNotMatch(prompt, /how many weeks to plan/);
  assert.match(prompt, /last 90 days/);
  assert.match(profilePrompt({}), /ask me about: my main goal, how many weeks to plan, my FTP/);
  const text = planHandoff('My edited prompt  ', { range: { days: 7 } });
  assert.ok(text.startsWith('My edited prompt\n\nGarmin data (JSON):\n{'));
});
test('long free-text answers are kept, not cut to a few sentences', () => {
  const goal = 'Build towards a gran fondo. '.repeat(80);
  assert.equal(normalizeProfile({ goal }).goal, goal.trim());
});
