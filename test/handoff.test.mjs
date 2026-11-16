import test from 'node:test';
import assert from 'node:assert/strict';
import { localSnapshotLocation, withLocalSnapshotLink } from '../public/shared/handoff.mjs';
import { briefing, emptySnapshot, selectData } from '../public/shared/model.mjs';

test('local snapshot links support Mac and Windows paths and escape URL and Markdown delimiters', () => {
  const mac = localSnapshotLocation('/Users/Mark/Training (bike) #1/snapshot.json');
  assert.equal(mac.url, 'file:///Users/Mark/Training%20%28bike%29%20%231/snapshot.json');
  assert.equal(decodeURIComponent(new URL(mac.url).pathname), mac.path);
  const windows = localSnapshotLocation('C:\\Users\\Mark\\Training plan\\snapshot.json');
  assert.equal(windows.url, 'file:///C:/Users/Mark/Training%20plan/snapshot.json');
  assert.equal(localSnapshotLocation(windows.url).path, windows.path);
  assert.equal(localSnapshotLocation(mac.url).path, mac.path);
});

test('local links require a full snapshot path instead of pretending relative paths or web URLs grant file access', () => {
  for (const path of ['', 'data/snapshot.json', '~/Training/snapshot.json', '/Users/Mark/Training',
    'https://example.com/snapshot.json', 'file://remote.example/Training/snapshot.json', '/Users/Mark/../snapshot.json']) {
    assert.throws(() => localSnapshotLocation(path));
  }
});

test('linked prompts instruct assistants to read the complete snapshot beyond the selected export range', () => {
  const snapshot = emptySnapshot();
  snapshot.health = [{ date: '2026-01-01', hrvMs: 50 }, { date: '2026-11-16', hrvMs: 55 }];
  const selected = briefing(selectData(snapshot, 30, '2026-11-16'));
  assert.doesNotMatch(selected, /2026-01-01/);
  const prompt = withLocalSnapshotLink(selected, '/Users/Mark/Training/snapshot.json');
  assert.match(prompt, /\[snapshot\.json\]\(file:\/\/\/Users\/Mark\/Training\/snapshot\.json\)/);
  assert.match(prompt, /ALL saved activities, daily health records, and sync coverage/);
  assert.match(prompt, /outside the selected range/);
  assert.match(prompt, /If you cannot access the file, ask me to attach snapshot\.json/);
  assert.ok(prompt.endsWith(selected));
});
