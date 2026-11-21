import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectDir, saveSnapshot, emptySnapshot, isoDay } from '../src/data.mjs';

test('optional MCP adapter exposes read-only saved data over a real stdio connection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cadence-mcp-test-'));
  const today = isoDay();
  await saveSnapshot({ ...emptySnapshot(), planned: [{ id: '1', date: today, workoutId: '77', name: 'Tempo 3x6', sport: 'cycling' }] }, directory);
  await writeFile(join(directory, 'plan.json'), JSON.stringify({ title: 'Base', sessions: [{ date: today, sport: 'cycling', title: 'Tempo', garminWorkoutId: '77', intensity: '190–205 W' }] }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(projectDir, 'src/mcp.mjs')], env: { CADENCE_DATA_DIR: directory }, stderr: 'pipe' });
  const client = new Client({ name: 'cadence-integration-tests', version: '1.0.0' });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 7);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint === true && tool.annotations.openWorldHint === false));
  const status = await client.callTool({ name: 'garmin_sync_status', arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).sync, null);
  const overview = await client.callTool({ name: 'garmin_training_overview', arguments: { days: 7 } });
  assert.equal(JSON.parse(overview.content[0].text).range.days, 7);
  const invalid = await client.callTool({ name: 'garmin_training_overview', arguments: { days: 999 } });
  assert.equal(invalid.isError, true);
  const plan = JSON.parse((await client.callTool({ name: 'training_plan', arguments: {} })).content[0].text);
  assert.equal(plan.planFile.title, 'Base');
  assert.equal(plan.days[0].sessions[0].garmin.name, 'Tempo 3x6', 'sessions are enriched with the scheduled Garmin workout');
  const form = (await client.callTool({ name: 'todays_form', arguments: {} })).content[0].text;
  assert.match(form, /Planned today:\n- Tempo \(cycling\) – 190–205 W\. Garmin workout: Tempo 3x6\./);
});
