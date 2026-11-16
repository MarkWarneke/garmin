// UI patterns adapted from HyperUI (MIT). See THIRD_PARTY_NOTICES.md.
import { withLocalSnapshotLink, withLocalFolderReference, localSnapshotLocation } from './shared/handoff.mjs';
import { PROFILE_FIELDS, normalizeProfile, profilePrompt, planHandoff } from './shared/profile.mjs';
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const glyphs = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  activities: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  health: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  plan: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2m4 0h2m-8 3h2"/>',
  connection: '<path d="m10 13 4-4m-7 6-2 2a4 4 0 0 0 6 6l4-4a4 4 0 0 0 0-6M17 9l2-2a4 4 0 0 0-6-6L9 5a4 4 0 0 0 0 6" transform="translate(0 1) scale(.9)"/>',
  time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  sleep: '<path d="M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5Z"/>',
  hrv: '<path d="M3 12h4l3-6 4 12 3-6h4"/>',
  cycling: '<circle cx="5" cy="17" r="4"/><circle cx="19" cy="17" r="4"/><path d="m5 17 5-9 4 4h5l-3-6M9 4h4M10 8l3 9"/>',
  gym: '<path d="M7 7 17 17M5 3 3 5m6-2L3 9m18 10-2 2m2-6-6 6M7 5 5 7m14 10-2 2"/>',
  other: '<path d="m8 21 4-8 4 8M8 5l4 5 4-5M12 10v3"/><circle cx="12" cy="3" r="1.5"/>',
  running: '<circle cx="15" cy="4" r="2"/><path d="m12 8 4 3h5m-9-3-4 6 5 2-3 6m2-14-4 1-3 4m3 1-5 5"/>',
  stress: '<path d="M7 17c-4-3-4-8 0-11m10 0c4 3 4 8 0 11M10 8c-2 2-2 5 0 7m4-7c2 2 2 5 0 7"/>',
  battery: '<rect x="3" y="7" width="17" height="10" rx="2"/><path d="M23 10v4M7 10v4m4-4v4m4-4v4"/>',
  steps: '<path d="M8 5c0 3-2 5-2 8h4c0-3 2-5 2-8a2 2 0 0 0-4 0Zm8 6c0 3-2 5-2 8h4c0-3 2-5 2-8a2 2 0 0 0-4 0Z"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name] || glyphs.activities}</svg>`;
const nav = [['overview', 'Overview'], ['activities', 'Activities'], ['health', 'Health & recovery'], ['plan', 'Training plan'], ['connection', 'Data & connection']];
const categories = { cycling: { label: 'Bike', color: '#db875c' }, gym: { label: 'Gym', color: '#9fae83' }, running: { label: 'Run', color: '#86a5b4' }, other: { label: 'Other', color: '#72a392' } };
function category(sport) {
  // Garmin keys include road_biking, indoor_cycling, virtual_ride, and e_bike_fitness.
  if (/cycl|bik|ride/.test(sport)) return 'cycling';
  if (/strength|fitness|cardio|gym/.test(sport)) return 'gym';
  if (/running|run$/.test(sport)) return 'running';
  return 'other';
}
const sportLabel = s => s.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const duration = (seconds) => {
  if (seconds == null) return '—';
  const mins = Math.round(seconds / 60), hours = Math.floor(mins / 60);
  return hours ? `${hours}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
};
const numeric = (n, decimals = 0) => n == null ? '—' : n.toLocaleString('en-GB', { maximumFractionDigits: decimals });
const km = meters => meters == null ? '—' : (meters / 1000).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dayLabel = (day, options = { day: 'numeric', month: 'short' }) => new Intl.DateTimeFormat('en-GB', options).format(new Date(day + 'T12:00:00Z'));
const shiftDay = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let data, bootstrap, range = 30, busy = false, lastError = '', activitySearch = '', activitySport = 'all';
let memoryKey = '', activeSync = null, cloudWorkspace = null;
const session = {
  get: name => { try { return sessionStorage.getItem(name); } catch { return null; } },
  set: (name, value) => { try { sessionStorage.setItem(name, value); return true; } catch { return false; } },
  remove: name => { try { sessionStorage.removeItem(name); } catch {} },
};
// The Garmin key is remembered in this browser (localStorage) until Forget key. Strict CSP limits which scripts can read it.
const browser = {
  get: name => { try { return localStorage.getItem(name); } catch { return null; } },
  set: (name, value) => { try { localStorage.setItem(name, value); return true; } catch { return false; } },
  remove: name => { try { localStorage.removeItem(name); } catch {} },
};
// Keys saved by earlier versions in the tab session move to browser storage once.
if (!browser.get('cadence.garminKey') && session.get('cadence.garminKey') && browser.set('cadence.garminKey', session.get('cadence.garminKey'))) session.remove('cadence.garminKey');
const getKey = () => browser.get('cadence.garminKey') || memoryKey;
let includeSnapshotLink = session.get('cadence.includeSnapshotLink') === 'true';
let snapshotPath = session.get('cadence.snapshotPath') || '';
const getSnapshotPath = () => cloudWorkspace ? snapshotPath : bootstrap?.dataFile || '';
function clearSnapshotPath() { snapshotPath = ''; session.remove('cadence.snapshotPath'); }
function snapshotTarget() {
  if (!cloudWorkspace) {
    let url; try { url = localSnapshotLocation(getSnapshotPath()).url; } catch { url = getSnapshotPath(); }
    return `<p class="snapshot-link-target">Adds a link to <code>${escapeHtml(url)}</code> and the profile.json next to it.</p>`;
  }
  if (!cloudWorkspace.connected) return '<p class="snapshot-link-target">Choose your data folder first.</p>';
  return `<p class="snapshot-link-target">Points the assistant to <code>${escapeHtml(cloudWorkspace.name)}/snapshot.json</code> and <code>profile.json</code> in the folder you selected.</p><details class="snapshot-link-path" ${snapshotPath ? 'open' : ''}><summary>Optional: add the full path for a direct file link</summary><input type="text" id="snapshot-path" value="${escapeHtml(snapshotPath)}" placeholder="/Users/you/Documents/${escapeHtml(cloudWorkspace.name)}/snapshot.json" spellcheck="false" autocomplete="off" aria-label="Full path to snapshot.json"><p>Your browser only shares the folder name. Without a path, the assistant searches for the folder.</p></details>`;
}
// Uses a file link when the full path is known, otherwise names the selected folder.
function withSnapshotReference(text) {
  return getSnapshotPath() ? withLocalSnapshotLink(text, getSnapshotPath()) : withLocalFolderReference(text, cloudWorkspace?.name);
}
function snapshotLinkControls() {
  return `<div class="snapshot-link-settings"><label class="snapshot-link-label" for="include-snapshot-link"><input type="checkbox" id="include-snapshot-link" ${includeSnapshotLink ? 'checked' : ''}><span>Include local snapshot link</span></label><button type="button" class="snapshot-link-help" id="snapshot-info" aria-label="About local snapshot links" title="About local snapshot links"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5m0-8v1" stroke-width="1.5"/></svg></button><p class="snapshot-link-hint">Only works with the ChatGPT or Claude desktop app on the computer where your data is saved.</p>${includeSnapshotLink ? snapshotTarget() : ''}</div>`;
}
const route = () => nav.some(([r]) => r === location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
function notify(message, error = false) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.toggle('error', error); toast.hidden = false;
  clearTimeout(notify.timer); notify.timer = setTimeout(() => { toast.hidden = true; }, 5000);
}
async function localFetch(path, options) {
  try { return await fetch(path, options); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
      ? 'Cannot reach the Cadence server on this computer. Start it with npm start (or Start Cadence.command on a Mac), then try again.'
      : 'Cannot reach Cadence. Check your connection and try again.');
  }
}
async function api(path) {
  if (cloudWorkspace && path !== '/api/bootstrap') {
    const url = new URL(path, location.origin), days = Number(url.searchParams.get('days') || range);
    if (url.pathname === '/api/data' || url.pathname === '/api/export') return cloudWorkspace.data(days);
    if (url.pathname === '/api/briefing') return cloudWorkspace.briefing(days);
  }
  const response = await localFetch(path, { cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Could not load local data.');
  return value;
}
function rangeControl() {
  return `<label class="range-select">${icon('plan')}<select id="view-range" aria-label="Stats date range">${[7, 30, 90, 180, 365].map(d => `<option value="${d}" ${d === range ? 'selected' : ''}>Last ${d === 365 ? 'year' : d + ' days'}</option>`).join('')}</select></label>`;
}
function heading(eyebrow, title, subtitle, includeRange = true) {
  return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></div>${includeRange ? rangeControl() : ''}</div>`;
}
function latest(field) { return data.health.findLast(d => d[field] != null); }
function metricCaption(field) { const row = latest(field); return row ? `Recorded ${dayLabel(row.date)}` : 'No recorded data yet'; }
function stat(label, value, unit, caption, mark) {
  return `<article class="flex min-w-0 flex-col gap-4 rounded-lg border border-gray-200 bg-white p-4 shadow-xs sm:p-5"><div class="flex items-center justify-between gap-2"><strong class="block text-xs font-medium text-gray-500">${label}</strong><span class="stat-icon">${icon(mark)}</span></div><p class="text-2xl font-medium tracking-tight whitespace-nowrap text-gray-900 tabular-nums xl:text-3xl">${value}${unit ? `<small class="ml-1 text-sm font-normal tracking-normal text-gray-400">${unit}</small>` : ''}</p><p class="text-[11px]/5 text-gray-500">${caption}</p></article>`;
}
function connectionBanner() {
  if (cloudWorkspace && !cloudWorkspace.connected) return '';
  if (getKey()) return '';
  return `<section class="connect-banner"><div class="banner-mark">↗</div><div><h2>${data.sync ? 'Your history is here. Connect to bring it up to date.' : 'Good training starts with the whole picture.'}</h2><p>${data.sync ? 'No Garmin key is saved in this browser. Enter it again to sync the latest data.' : 'Connect Garmin to see your activities, sleep, and recovery together. Your key is saved only in this browser.'}</p></div><button class="button" data-connect>Connect Garmin <span>↗</span></button></section>`;
}
function warnings() {
  let html = lastError ? `<div class="warning error-banner" role="alert">${escapeHtml(lastError)}</div>` : '';
  if (data.sync?.warnings?.length) html += `<details class="warning"><summary>Some Garmin data was unavailable · ${data.sync.warnings.length} sync ${data.sync.warnings.length === 1 ? 'warning' : 'warnings'}</summary><p>The successful downloads were saved. Existing history was retained for failed requests.</p><ul>${data.sync.warnings.map(w => `<li>${escapeHtml(w.source)} · ${escapeHtml(w.startDate)}–${escapeHtml(w.endDate)}: ${escapeHtml(w.message)}</li>`).join('')}</ul></details>`;
  return html;
}
function weeklyChart() {
  const end = data.range.endDate;
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(end, i - 6));
  const values = days.map(date => Object.fromEntries(Object.keys(categories).map(key => [key,
    data.activities.filter(a => a.date === date && category(a.sport) === key).reduce((s, a) => s + (a.durationSeconds || 0) / 3600, 0)])));
  const totals = values.map(v => Object.values(v).reduce((s, n) => s + n, 0));
  const max = Math.max(1, Math.ceil(Math.max(...totals) * 2) / 2);
  const grid = Array.from({ length: 5 }, (_, i) => {
    const y = 170 - i * 37;
    return `<line x1="35" x2="567" y1="${y}" y2="${y}" stroke="#eceee5"/><text x="0" y="${y + 3}" font-size="9" fill="#a2aa94">${numeric(max * i / 4, 1)}h</text>`;
  }).join('');
  const bars = values.map((v, i) => {
    let y = 170;
    const rects = Object.keys(categories).map(key => { const height = v[key] / max * 148; y -= height;
      return height ? `<rect x="${64 + i * 74}" y="${y}" width="30" height="${height}" rx="2" fill="${categories[key].color}"><title>${dayLabel(days[i])}: ${categories[key].label} ${duration(v[key] * 3600)}</title></rect>` : '';
    }).join('');
    return `${rects}<text x="${79 + i * 74}" y="193" text-anchor="middle" fill="${i === 6 ? '#cf754c' : '#9aa28e'}" font-size="10">${dayLabel(days[i], { weekday: 'short' })}</text>`;
  }).join('');
  return `<div class="weekly-chart-wrap"><svg class="weekly-svg" viewBox="0 0 580 210" role="img" aria-label="Training duration by sport for the last seven days">${grid}${bars}</svg>${totals.some(v => v > 0) ? '' : `<div class="chart-empty"><strong>${data.sync ? 'A quiet week.' : 'Your week, at a glance.'}</strong><span>${data.sync ? 'No training recorded in the last seven days.' : 'Training sessions will appear here after syncing.'}</span></div>`}</div><div class="legend">${Object.entries(categories).map(([key, c]) => `<span><i class="legend-${key}"></i>${c.label}</span>`).join('')}</div>`;
}
function sparkline(field, color, compact = false) {
  const count = compact ? 14 : Math.min(range, 90), end = data.range.endDate;
  const byDate = new Map(data.health.map(d => [d.date, d[field]]));
  const points = Array.from({ length: count }, (_, i) => byDate.get(shiftDay(end, i + 1 - count)) ?? null);
  const measured = points.filter(v => v != null);
  if (!measured.length) return compact ? '' : '<div class="health-empty">No measurements recorded in this period</div>';
  const min = Math.min(...measured), max = Math.max(...measured), span = Math.max(max - min, max * .08, 1);
  const w = compact ? 70 : 500, h = compact ? 24 : 120, padding = compact ? 3 : 15;
  let path = '', drawing = false;
  const coords = [];
  points.forEach((value, i) => {
    if (value == null) { drawing = false; return; }
    const x = padding + i / Math.max(1, count - 1) * (w - padding * 2);
    const y = padding + (1 - (value - min + span * .15) / (span * 1.3)) * (h - padding * 2);
    path += `${drawing ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
    drawing = true; coords.push([x, y]);
  });
  const unitValue = v => field === 'sleepSeconds' ? numeric(v / 3600, 1) + 'h' : numeric(v);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(field)} trend, ${measured.length} measured days; range ${unitValue(min)} to ${unitValue(max)}">${compact ? '' : `<line x1="0" x2="500" y1="115" y2="115" stroke="#e9eee0"/><line x1="0" x2="500" y1="60" y2="60" stroke="#f0f3eb"/>`}<path d="${path}" fill="none" stroke="${color}" stroke-width="${compact ? 1.7 : 2}" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>${coords.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${compact ? 1.1 : 2}" fill="${color}"/>`).join('')}</svg>`;
}
const healthMetrics = [
  { field: 'sleepSeconds', label: 'Sleep duration', short: 'Sleep', mark: 'sleep', format: duration, unit: '', color: '#9babc2', caption: 'Measured sleep, excluding naps' },
  { field: 'hrvMs', label: 'Overnight HRV', short: 'Heart rate variability', mark: 'hrv', format: numeric, unit: 'ms', color: '#9cab88', caption: 'Garmin overnight average' },
  { field: 'restingHeartRate', label: 'Resting heart rate', short: 'Resting heart rate', mark: 'heart', format: numeric, unit: 'bpm', color: '#c79075', caption: 'Garmin daily resting heart rate' },
  { field: 'stress', label: 'Daily stress', short: 'Daily stress', mark: 'stress', format: numeric, unit: '/100', color: '#b5a77b', caption: 'Garmin daily average stress' },
  { field: 'bodyBatteryHigh', label: 'Body Battery', short: 'Body Battery peak', mark: 'battery', format: numeric, unit: '/100', color: '#7fa48e', caption: 'Highest Body Battery value of the day' },
  { field: 'steps', label: 'Daily steps', short: 'Daily steps', mark: 'steps', format: numeric, unit: 'steps', color: '#96aa80', caption: 'Recorded daily step count' },
];
function recovery() {
  return `<section class="card"><div class="card-heading"><div><h2>Recovery signals</h2><p class="sub">Latest available measurements</p></div><span class="pill">GARMIN</span></div><div class="recovery-list">${healthMetrics.slice(0, 4).map(m => `<div class="recovery-row"><span class="metric-mark ${m.mark}">${icon(m.mark)}</span><div class="recovery-name">${m.short}<span>${metricCaption(m.field)}</span></div><div class="recovery-value">${m.format(latest(m.field)?.[m.field] ?? null)}<small>${m.unit}</small></div><div class="recovery-spark">${sparkline(m.field, m.color, true)}</div></div>`).join('')}</div></section>`;
}
function activityTable(items, all = false) {
  return `<section class="card"><div class="card-heading"><div><h2>${all ? 'Your activities' : 'Recent activities'}</h2><p class="sub">${all ? items.length + ' matching sessions' : 'A little of everything you love to do'}</p></div>${all ? '' : '<button class="link-button" data-route="activities">View all <span>↗</span></button>'}</div><div class="table-container"><table class="min-w-full divide-y-2 divide-gray-200"><thead class="text-left"><tr class="*:font-medium *:text-gray-500"><th>Activity</th><th>Date</th><th>Duration</th><th>Distance</th><th>Avg. HR</th><th><span class="sr-only">Details</span></th></tr></thead><tbody class="divide-y divide-gray-100">${items.length ? items.map(a => `<tr><td><button class="activity-link" data-activity="${escapeHtml(a.id)}"><div class="activity-name"><div class="activity-icon ${category(a.sport)}">${icon(category(a.sport))}</div><div><b>${escapeHtml(a.name)}</b><span>${escapeHtml(sportLabel(a.sport))}</span></div></div></button></td><td>${dayLabel(a.date)}</td><td>${duration(a.durationSeconds)}</td><td>${a.distanceMeters != null ? km(a.distanceMeters) + ' km' : '—'}</td><td>${numeric(a.averageHeartRate)}${a.averageHeartRate != null ? ' bpm' : ''}</td><td><button class="arrow-link" data-activity="${escapeHtml(a.id)}" aria-label="View ${escapeHtml(a.name)}">↗</button></td></tr>`).join('') : `<tr><td colspan="6"><div class="table-empty"><strong>${activitySearch || activitySport !== 'all' ? 'No activities match your filters.' : 'Your next chapter starts with a sync.'}</strong><p>${data.sync ? 'Activities recorded in this period will appear here.' : 'Connect Garmin to bring your recent training into view.'}</p></div></td></tr>`}</tbody></table></div></section>`;
}
function overview() {
  return heading('MOVE. RECOVER. REPEAT.', 'Your training, in perspective.', 'A clearer view of your effort, your recovery, and what comes next.') + connectionBanner() + warnings()
    + `<div class="stat-grid">${stat('Time in motion', data.sync ? duration(data.summary.durationSeconds) : '—', '', `Last ${range} days · recorded activities`, 'time')}${stat('Training sessions', data.sync ? numeric(data.summary.activities) : '—', '', data.sync ? km(data.summary.distanceMeters) + ' km covered in this period' : 'Bike, gym, and everything in between', 'activities')}${stat('Latest sleep', duration(latest('sleepSeconds')?.sleepSeconds ?? null), '', metricCaption('sleepSeconds'), 'sleep')}${stat('Overnight HRV', numeric(latest('hrvMs')?.hrvMs ?? null), 'ms', metricCaption('hrvMs'), 'hrv')}</div>`
    + `<div class="content-grid"><section class="card"><div class="card-heading"><div><h2>A week in motion</h2><p class="sub">${dayLabel(shiftDay(data.range.endDate, -6))} – ${dayLabel(data.range.endDate)} · duration by sport</p></div><span class="pill">LAST 7 DAYS</span></div><div class="card-inner">${weeklyChart()}</div></section>${recovery()}</div>`
    + activityTable(data.activities.slice(0, 5))
    + `<div class="split-bottom"><section class="card next-card"><div class="card-inner"><p class="eyebrow">THE NEXT CHAPTER</p><h3>Make room for your next goal.</h3><p>Bike, gym, bouldering. A training plan that fits your life starts with understanding where you are today.</p><button class="text-button" data-route="plan">Your training workspace <span>↗</span></button></div></section><section class="card export-card"><div class="card-inner"><h3>Start a conversation about your training.</h3><p>Answer a few questions and copy a plan prompt with your Garmin data into ChatGPT or Claude. You choose what to share.</p><div class="export-actions"><button class="button button-secondary" data-plan ${!data.sync ? 'disabled' : ''}>Create plan prompt ↗</button><button class="text-button" data-route="plan">How it works</button></div></div></section></div>`;
}
function activities() {
  const items = data.activities.filter(a => (activitySport === 'all' || category(a.sport) === activitySport)
    && `${a.name} ${a.sport}`.toLowerCase().includes(activitySearch.toLowerCase()));
  return heading('THE WORK YOU PUT IN', 'Every session adds up.', 'Your recent activities, across all the ways you like to move.') + warnings()
    + `<div class="section-toolbar"><input type="search" id="activity-search" placeholder="Search your activities…" aria-label="Search activities" value="${escapeHtml(activitySearch)}"><select id="activity-sport" aria-label="Filter by sport"><option value="all">All sports</option>${Object.entries(categories).map(([key, c]) => `<option value="${key}" ${activitySport === key ? 'selected' : ''}>${c.label}</option>`).join('')}</select><span class="pill">${items.length} SESSIONS</span></div>` + activityTable(items, true);
}
function health() {
  return heading('THE OTHER HALF OF TRAINING', 'Recovery has a rhythm.', 'Look for patterns over time. Missing measurements stay missing.') + warnings()
    + `<div class="health-grid">${healthMetrics.map(m => {
      const row = latest(m.field), measured = data.health.filter(d => d[m.field] != null);
      const chartValues = measured.filter(d => d.date >= shiftDay(data.range.endDate, 1 - Math.min(range, 90))).map(d => d[m.field]);
      const chartRange = chartValues.length ? `Range: ${m.format(Math.min(...chartValues))}–${m.format(Math.max(...chartValues))} ${m.unit} · ` : '';
      return `<section class="card"><div class="card-heading"><h2>${m.label}</h2><span class="stat-icon">${icon(m.mark)}</span></div><div class="card-inner"><div class="health-metric-top"><div><div class="health-value">${m.format(row?.[m.field] ?? null)} <small>${m.unit}</small></div><p class="health-caption">${metricCaption(m.field)}</p></div><span class="pill">${measured.length} MEASURED DAYS</span></div><div class="line-chart">${sparkline(m.field, m.color)}</div><div class="line-legend"><span>${dayLabel(shiftDay(data.range.endDate, 1 - Math.min(range, 90)))}</span><span>${dayLabel(data.range.endDate)}</span></div><p class="health-caption">${chartRange}${m.caption} · ${range > 90 ? 'chart shows latest 90 days' : 'gaps indicate missing measurements'}</p></div></section>`;
    }).join('')}</div>`;
}
// Setup help appears only while something is missing: a folder (hosted), a Garmin key, or a first sync.
function planCards() {
  const folderMissing = cloudWorkspace && !cloudWorkspace.connected;
  const ready = data.sync && getKey() && !folderMissing;
  const steps = [['Answer a few questions.', 'Goal, FTP, heart rate, and the time you have. Each field says why it matters; skip anything and the assistant will ask.'],
    ['Review the prompt.', 'You see exactly what will be shared and can edit it. Your answers are saved to profile.json next to your data.'],
    ['Paste it into ChatGPT or Claude.', 'Cadence adds your Garmin data for the selected range. Nothing is sent automatically.']];
  const planCard = `<section class="card panel"><h2>Your data, ready to discuss.</h2><p>Turn your Garmin history into a concrete, week-by-week plan with ChatGPT or Claude.</p><ol class="how-list plan-steps">${steps.map(([title, text]) => `<li><strong>${title}</strong><p>${text}</p></li>`).join('')}</ol><div class="export-actions"><button class="button button-primary" data-plan ${!data.sync ? 'disabled' : ''}>Create plan prompt ↗</button></div>${data.sync ? '' : '<p class="field-hint">Sync your Garmin data first.</p>'}</section>`;
  if (ready) return `<div class="plan-single">${planCard}</div>`;
  const [title, text, action] = folderMissing ? ['Choose your data folder.', 'Cadence saves your history to a folder on this computer. Pick an empty folder, or one with an existing snapshot.json.', '<button class="button button-secondary" data-folder>Choose data folder ↗</button>']
    : !getKey() ? [data.sync ? 'Reconnect Garmin for fresh data.' : 'Get the foundation in place.', data.sync ? 'Your saved history is here. Enter your key again to bring it up to date before planning.' : 'Sync your recent training and recovery history first. That gives the conversation context, without guessing your goals.', '<button class="button button-secondary" data-connect>Connect Garmin ↗</button>']
    : ['Run your first sync.', 'Download your recent training and recovery history to give the plan context.', '<button class="button button-secondary" id="full-sync">Sync Garmin ↻</button>'];
  return `<div class="split-bottom"><section class="card panel"><h2>${title}</h2><p>${text}</p><div class="export-actions">${action}</div></section>${planCard}</div>`;
}
function plan() {
  const end = data.range.endDate, weekday = new Date(end + 'T12:00:00Z').getUTCDay();
  const monday = shiftDay(end, -((weekday + 6) % 7));
  return heading('A PLAN THAT FITS YOUR LIFE', 'Your next block starts here.', 'Tell ChatGPT or Claude what your data can’t, and get a plan built around your goals.', false)
    + `<section class="card"><div class="card-heading"><div><h2>Your training calendar</h2><p class="sub">${dayLabel(monday)} – ${dayLabel(shiftDay(monday, 6))}</p></div><span class="pill orange">NO PLAN YET</span></div><div class="timeline">${Array.from({ length: 7 }, (_, i) => { const date = shiftDay(monday, i); return `<div class="calendar-day"><span>${dayLabel(date, { weekday: 'short' })}</span><b>${dayLabel(date, { day: 'numeric' })}</b><i></i></div>`; }).join('')}</div><div class="calendar-note"><strong>Good plans begin with a conversation.</strong>Create a plan prompt below and talk it through with ChatGPT or Claude: your goals, available time, and how bike, gym, and bouldering fit together.</div></section>` + planCards();
}
function connection() {
  if (cloudWorkspace) return cloudConnection();
  const connected = !!getKey();
  return heading('CONNECTED, ON YOUR TERMS', 'A connection you control.', 'Your Garmin key, sync, and saved data, all in one place.', false) + warnings()
    + `<section class="card panel"><p class="eyebrow">GARMIN CONNECT PERSONAL API</p><h2>${connected ? 'Ready to keep your history up to date.' : 'Connect your Garmin account.'}</h2><p>Paste your personal API key once. This browser remembers it until you choose Forget key. Cadence exchanges it for an access token and downloads activity, sleep, HRV, and daily health summaries. Opening the app syncs the latest data.</p><div class="setting-row"><div><strong>${connected ? 'Key saved in this browser' : 'No key saved in this browser'}</strong><p>Key expiry and storage are separate: Garmin keys can last 30 days to a year; this app keeps yours in this browser’s local storage until you forget it.</p></div><div class="export-actions"><button class="button button-secondary" data-connect>${connected ? 'Change key' : 'Connect Garmin'} ↗</button>${connected ? '<button class="button button-quiet" id="forget-key">Forget key</button>' : ''}</div></div><div class="setting-row"><div><strong>Downloaded history stays local</strong><p>History stays on this computer. Keys, access tokens, account details, and GPS routes are not saved here.</p></div><button class="button button-quiet" id="full-sync" ${busy ? 'disabled' : ''}>Re-fetch full history ↻</button></div><details><summary>Latest sync details</summary>${data.sync ? `<p>Completed ${escapeHtml(new Date(data.sync.completedAt).toLocaleString('en-GB'))}. Fetched ${escapeHtml(data.sync.fetchedFrom)} through ${escapeHtml(data.sync.fetchedTo)}. ${data.sync.fullySuccessful ? 'All requested datasets were downloaded.' : 'Some requests failed; see warnings above.'}</p><p>Successful source windows: ${data.sync.coverage.length}. A successful request can return no records if a metric was not measured.</p>` : '<p>No sync has completed yet.</p>'}</details></section>`
    + howItWorks();
}
const REPOSITORY = 'https://github.com/MarkWarneke/garmin';
function howItWorks() {
  const cloud = !!cloudWorkspace;
  const step = (title, text) => `<li><strong>${title}</strong><p>${text}</p></li>`;
  const steps = [
    step('Your key stays in this browser.', 'The Garmin Personal API key is saved in this browser’s local storage, so you enter it once. Forget key removes it. It is never written to a file' + (cloud ? ' or stored on a server.' : '.')),
    cloud
      ? step('Garmin is reached through a relay.', 'Garmin does not accept requests from web pages directly, so the browser sends each request through Cadence’s Cloudflare Worker. It forwards the request with your key and returns Garmin’s complete answer, which your browser then filters. That answer can include the start and end coordinates of outdoor activities, the place name, your Garmin display name, and weight details such as BMI. The relay keeps nothing: no database, no logs. For no third party at all, run Cadence locally.')
      : step('This computer talks to Garmin.', 'The Cadence server on this computer exchanges your key for a short-lived access token and downloads the data directly from Garmin. It listens only on 127.0.0.1.'),
    step('Only summaries are saved.', `Activities (duration, distance, heart rate, power, zones, intervals, perceived effort), daily health, sleep, HRV, and your Garmin training settings are saved as plain JSON in <code>${escapeHtml(bootstrap.dataFile)}</code>. No coordinates, place names, GPS routes, FIT files, account details, or credentials.` + (cloud ? ' The browser only remembers which folder you chose.' : '')),
    step('Syncs download only what is new.', 'After the first sync, Cadence fetches the days since the last sync plus a one-week overlap for late uploads, and retries anything that failed. Re-fetch full history reloads the whole range.'),
    step('You decide what an assistant sees.', `Nothing is sent to ChatGPT, Claude, or anyone else automatically. Under Training plan, your answers go to <code>${escapeHtml(bootstrap.profileFile || 'profile.json')}</code> and into a prompt you review, edit, and copy yourself.`),
  ];
  return `<section class="card panel"><p class="eyebrow">HOW CADENCE WORKS</p><h2>What happens to your data.</h2><ol class="how-list">${steps.join('')}</ol>`
    + `<div class="setting-row"><div><strong>Export your data</strong><p>Download activities and daily health for the selected range as JSON.</p></div><div class="export-actions">${rangeControl()}<a class="button button-secondary ${!data.sync ? 'is-disabled' : ''}" href="/api/export?days=${range}" ${!data.sync ? 'aria-disabled="true" tabindex="-1"' : ''}>Download JSON ↓</a></div></div>`
    + (cloud ? '' : `<details><summary>Optional: direct access for desktop assistants (MCP)</summary><p>A small, optional MCP adapter lets ChatGPT desktop and Codex read the saved history and your athlete profile. It only runs when a client starts it, and never sees your Garmin key. In the desktop app’s MCP server settings, add a STDIO server with:</p><code class="code-box">Command: ${escapeHtml(bootstrap.nodePath)}\nArguments: ${escapeHtml(bootstrap.projectDir + 'src/mcp.mjs')}</code></details>`)
    + `<div class="setting-row"><div><strong>Source code</strong><p>Read the code, report an issue, or fork Cadence to run your own copy. Free for noncommercial use under the PolyForm Noncommercial License.</p></div><a class="button button-secondary" href="${REPOSITORY}" target="_blank" rel="noreferrer">View on GitHub ↗</a></div></section>`;
}
function folderBanner() {
  if (!cloudWorkspace || cloudWorkspace.connected) return '';
  if (!cloudWorkspace.supported) return `<section class="connect-banner"><div class="banner-mark">!</div><div><h2>This browser cannot save your data.</h2><p>Cadence needs Chrome or Edge on a desktop or laptop to save your history to a folder. You can look around, but syncing is not available here.</p></div><button class="button" data-unsupported>Why? ↗</button></section>`;
  return `<section class="connect-banner"><div class="banner-mark">↗</div><div><h2>Open your local training folder.</h2><p>Choose an existing Cadence data folder to resume, or an empty folder for your first sync. Each browser needs its own folder permission.</p></div><button class="button" data-folder>Choose data folder ↗</button></section>`;
}
async function chooseFolder() {
  // Without folder access (phones, Safari, Firefox) every save action explains why instead of failing silently.
  if (!cloudWorkspace.supported) return $('#unsupported-dialog').showModal();
  if (busy) return notify('Wait for the current sync to finish before changing folders.');
  try {
    await cloudWorkspace.choose(); clearSnapshotPath(); await reload();
    notify('Local folder opened. Saved history is ready.');
    if (getKey()) await sync();
  } catch (error) { if (error.name !== 'AbortError') notify(error.message, true); }
}
function cloudConnection() {
  const folder = cloudWorkspace.name, connected = !!getKey();
  return heading('YOUR FILES. YOUR TRAINING.', 'Open a folder. Pick up where you left off.', 'The app runs on Cloudflare. Your training history lives in files on your device.', false) + warnings()
    + `<section class="card panel"><p class="eyebrow">LOCAL WORKSPACE</p><h2>${folder ? 'Connected to ' + escapeHtml(folder) : 'Choose your training data folder.'}</h2><p>Select the folder containing your existing snapshot.json, or choose an empty folder. You can open that same folder in another Chrome or Edge browser to resume your saved history. No Garmin key is needed to read saved data.</p><div class="setting-row"><div><strong>${folder ? escapeHtml(folder) + '/snapshot.json' : 'No local folder selected'}</strong><p>The browser asks for read/write permission. IndexedDB remembers only the folder handle; your training records stay in the file.</p></div><div class="export-actions"><button class="button button-secondary" data-folder ${busy ? 'disabled' : ''}>${folder ? 'Change folder' : 'Choose data folder'} ↗</button>${folder ? '<button class="button button-quiet" id="forget-folder">Disconnect folder</button>' : ''}</div></div></section>`
    + `<section class="card panel"><p class="eyebrow">GARMIN VIA CLOUDFLARE</p><h2>${connected ? 'Key saved in this browser.' : 'Connect Garmin when you want fresh data.'}</h2><p>Anyone can use Cadence with their own Garmin Personal API key and local data folder. Your key and downloaded responses pass through Cloudflare temporarily. No training database or saved Garmin key is configured in the cloud.</p><div class="export-actions"><button class="button button-secondary" data-connect>${connected ? 'Change key' : 'Connect Garmin'} ↗</button>${connected ? '<button class="button button-quiet" id="forget-key">Forget key</button>' : ''}<button class="button button-quiet" id="full-sync" ${busy ? 'disabled' : ''}>Re-fetch full history ↻</button></div>${data.sync ? `<details><summary>Latest sync details</summary><p>Completed ${escapeHtml(new Date(data.sync.completedAt).toLocaleString('en-GB'))}. ${data.sync.fullySuccessful ? 'All requested datasets downloaded.' : 'See the sync warnings for unavailable data.'}</p></details>` : ''}</section>`
    + howItWorks();
}
function render() {
  if (!data) return;
  const current = route();
  $('#navigation').innerHTML = nav.map(([key, label]) => `<a class="nav-item rounded-lg px-4 py-3 text-sm font-medium transition-colors ${current === key ? 'active bg-orange-50 text-orange-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}" href="#${key}" aria-label="${label}" ${current === key ? 'aria-current="page"' : ''}><span class="nav-icon">${icon(key)}</span><span>${label}</span></a>`).join('');
  $('#breadcrumb').textContent = nav.find(([key]) => key === current)[1].toUpperCase();
  $('#page').innerHTML = folderBanner() + ({ overview, activities, health, plan, connection }[current])();
  $('#sync-button').disabled = busy;
  $('#sync-button').lastChild.textContent = busy ? ' Syncing…' : ' Sync Garmin';
  $('#sync-label').textContent = data.sync ? `${data.sync.fullySuccessful ? 'Synced' : 'Partial sync'} ${new Date(data.sync.completedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · ${dayLabel(data.sync.fetchedTo)}` : 'Not synced yet';
}
async function reload() {
  data = await api(`/api/data?days=${range}`);
  if (cloudWorkspace) {
    const folder = cloudWorkspace.name || 'your selected Cadence folder';
    bootstrap.dataFile = folder + '/snapshot.json'; bootstrap.profileFile = folder + '/profile.json';
  }
  render();
}
async function showConnect() {
  if (busy) return notify('Wait for the current sync to finish before changing the key.');
  if (cloudWorkspace && !cloudWorkspace.connected) return chooseFolder();
  $('#api-key').value = ''; $('#api-key').type = 'password'; $('#toggle-key').textContent = 'Show'; $('#toggle-key').setAttribute('aria-pressed', 'false');
  $('#connect-error').hidden = true;
  $('#sync-days').value = session.get('cadence.syncDays') || '90';
  $('#connect-dialog').showModal();
}
async function sync({ key = getKey(), full = false, days = Number(session.get('cadence.syncDays') || 90) } = {}) {
  if (cloudWorkspace && !cloudWorkspace.connected) return chooseFolder();
  if (!key) return showConnect();
  if (busy) return;
  busy = true; activeSync = new AbortController(); lastError = ''; render(); $('#sync-panel').hidden = false;
  $('#sync-message').textContent = 'Connecting to Garmin…'; $('#sync-progress').value = 0;
  let completed = false;
  try {
    if (cloudWorkspace) {
      const result = await cloudWorkspace.sync(key, { days, full, signal: activeSync.signal,
        onProgress: event => {
          $('#sync-message').textContent = event.message;
          $('#sync-progress').max = event.total || 1; $('#sync-progress').value = event.completed || 0;
        } });
      completed = true;
      notify(result.sync.fullySuccessful ? 'Garmin data saved to your local folder.' : 'Available data saved. Check the sync warnings.');
      await reload();
      return;
    }
    // The local server can restart while this tab remains open. Refresh its request token for every sync.
    bootstrap = await api('/api/bootstrap');
    const response = await localFetch('/api/sync', { method: 'POST', signal: activeSync.signal, headers: { 'Content-Type': 'application/json', 'X-Cadence-Token': bootstrap.csrf }, body: JSON.stringify({ key, days, full }) });
    if (!response.ok) { const v = await response.json(); throw new Error(v.error); }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    const processLine = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.error);
      if (event.type === 'progress') {
        $('#sync-message').textContent = event.message;
        $('#sync-progress').max = event.total || 1; $('#sync-progress').value = event.completed || 0;
      }
      if (event.type === 'done') { completed = true; notify(event.sync.fullySuccessful ? 'Your Garmin data is up to date.' : 'Downloaded available data. Some requests need attention.'); }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(processLine);
      }
      buffer += decoder.decode(); if (buffer.trim()) processLine(buffer);
    } finally { reader.releaseLock(); }
    if (!completed) throw new Error('The sync connection ended early. Your previous data is still available.');
    await reload();
  } catch (error) {
    lastError = error.message || 'Could not sync. Check your connection and retry.'; notify(lastError, true);
  } finally { key = ''; activeSync = null; busy = false; $('#sync-panel').hidden = true; render(); }
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); notify('Copied. Ready to paste into your conversation.'); }
  catch { notify('Clipboard unavailable. Use Download JSON instead.', true); }
}
let promptEdited = false;
const profileApi = {
  load: () => cloudWorkspace ? cloudWorkspace.profile() : api('/api/profile'),
  async save(profile) {
    if (cloudWorkspace) return cloudWorkspace.saveProfile(profile);
    const response = await localFetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cadence-Token': bootstrap.csrf }, body: JSON.stringify(profile) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Could not save your profile.');
    return value;
  },
};
// Garmin profile values offered for empty fields. They are saved only when you save the profile.
const dayName = d => d.charAt(0) + d.slice(1).toLowerCase();
function garminSuggestions(athlete) {
  if (!athlete) return {};
  const days = athlete.trainingDays || [], long = athlete.longTrainingDays || [];
  return { ftpWatts: athlete.ftpWatts, ftpTestDate: null, maxHeartRate: athlete.maxHeartRate, thresholdHeartRate: athlete.lactateThresholdHeartRate,
    weightKg: athlete.weightKg, daysPerWeek: days.length || null,
    availability: days.length ? `Training days: ${days.map(dayName).join(', ')}${long.length ? `; long sessions on ${long.map(dayName).join(', ')}` : ''}` : null };
}
function profileField(f, value, fromGarmin = false) {
  const id = 'profile-' + f.name, attrs = `id="${id}" name="${f.name}" aria-describedby="${id}-why"`;
  const input = f.type === 'textarea' ? `<textarea ${attrs} rows="4" maxlength="${f.max}" placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(value ?? '')}</textarea>`
    : f.type === 'select' ? `<select ${attrs}>${f.options.map(([v, label]) => `<option value="${v}" ${(value ?? '') === v ? 'selected' : ''}>${label}</option>`).join('')}</select>`
    : `<input ${attrs} type="${f.type}" value="${escapeHtml(value ?? '')}" ${f.type === 'number' ? `min="${f.min}" max="${f.max}" step="${f.step || 1}" inputmode="decimal"` : ''} ${f.max && f.type === 'text' ? `maxlength="${f.max}"` : ''} placeholder="${escapeHtml(f.placeholder || '')}">`;
  return `<div class="profile-field ${f.type === 'textarea' ? 'wide' : ''}"><label for="${id}">${f.label}${fromGarmin ? ' <span class="garmin-tag">from Garmin</span>' : ''}</label>${input}<p class="field-hint" id="${id}-why">${f.why}</p></div>`;
}
const formProfile = () => normalizeProfile(Object.fromEntries(new FormData($('#plan-form'))));
function updatePrompt() {
  if (!promptEdited) $('#plan-prompt').value = profilePrompt(formProfile(), { days: range });
  $('#reset-prompt').hidden = !promptEdited;
  $('#prompt-status').textContent = promptEdited ? 'Edited by you. Form changes no longer update the prompt.' : 'Updates as you fill in the form.';
  $('#plan-range').value = String(range);
  $('#plan-data-summary').textContent = `· ${numeric(data.summary.activities)} activities, ${data.health.length} days of health data.`;
}
function renderSnapshotLink() { $('#plan-snapshot-link').innerHTML = snapshotLinkControls(); }
async function openPlan() {
  let profile;
  try { profile = await profileApi.load(); } catch (error) { return notify(error.message, true); }
  const groups = [...new Set(PROFILE_FIELDS.map(f => f.group))];
  const suggested = garminSuggestions(data.athlete);
  const prefilled = PROFILE_FIELDS.filter(f => profile[f.name] == null && suggested[f.name] != null).map(f => f.name);
  $('#profile-fields').innerHTML = (prefilled.length ? `<p class="garmin-note">Pre-filled from your Garmin settings: ${prefilled.map(n => PROFILE_FIELDS.find(f => f.name === n).label.toLowerCase()).join(', ')}. Check them and save.</p>` : '')
    + groups.map(group => `<fieldset class="profile-group"><legend>${group}</legend><div class="profile-grid">${PROFILE_FIELDS.filter(f => f.group === group).map(f => profileField(f, profile[f.name] ?? suggested[f.name], prefilled.includes(f.name))).join('')}</div></fieldset>`).join('');
  promptEdited = profile.prompt != null;
  $('#plan-prompt').value = profile.prompt ?? '';
  $('#plan-error').hidden = true;
  $('#profile-saved').textContent = profile.updatedAt ? `Saved ${new Date(profile.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not saved yet';
  updatePrompt(); renderSnapshotLink();
  $('#plan-dialog').showModal();
}
async function savePlanProfile() {
  const saved = await profileApi.save({ ...formProfile(), prompt: promptEdited ? $('#plan-prompt').value : null });
  $('#profile-saved').textContent = 'Saved to ' + (bootstrap.profileFile || 'profile.json');
  return saved;
}
function planError(message) { $('#plan-error').textContent = message; $('#plan-error').hidden = false; }
function showActivity(id) {
  const a = data.activities.find(a => a.id === id); if (!a) return;
  const metric = (label, value, unit = '') => `<div class="detail-cell"><dt>${label}</dt><dd>${value} <small>${unit}</small></dd></div>`;
  $('#activity-detail').innerHTML = `<p class="eyebrow">${escapeHtml(sportLabel(a.sport).toUpperCase())}</p><h2 id="activity-title">${escapeHtml(a.name)}</h2><p class="muted">${dayLabel(a.date)}${a.localStart ? ' · ' + escapeHtml(a.localStart.slice(11, 16)) : ''}</p><dl class="detail-grid">${metric('Duration', duration(a.durationSeconds))}${metric('Distance', km(a.distanceMeters), 'km')}${metric('Average heart rate', numeric(a.averageHeartRate), 'bpm')}${metric('Maximum heart rate', numeric(a.maxHeartRate), 'bpm')}${metric('Elevation gain', numeric(a.elevationMeters), 'm')}${metric('Garmin activity load', numeric(a.trainingLoad, 1))}${metric('Aerobic effect', numeric(a.aerobicEffect, 1))}${metric('Anaerobic effect', numeric(a.anaerobicEffect, 1))}${[['Average power', a.averagePower, 'W'], ['Normalized power', a.normalizedPower, 'W'], ['Best 1-min power', a.bestPowerWatts?.[60], 'W'], ['Best 20-min power', a.max20MinPower, 'W'], ['FTP at the time', a.ftpWatts, 'W'], ['Perceived effort', a.rpe, '/10']].filter(([, v]) => v != null).map(([label, v, unit]) => metric(label, numeric(v, unit === '/10' ? 1 : 0), unit)).join('')}</dl>${a.intervals ? `<p class="eyebrow">INTERVALS</p><dl class="detail-grid">${a.intervals.map(i => metric(sportLabel(i.type.toLowerCase().replace(/^interval_/, '')) + ` × ${numeric(i.count)}`, numeric(i.averagePower ?? i.averageHeartRate ?? null), i.averagePower != null ? 'W avg' : 'bpm avg')).join('')}</dl>` : ''}<p class="attribution">Garmin device data via Garmin Connect Personal API · Device model not supplied by the activity-list endpoint.</p>`;
  $('#activity-dialog').showModal();
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button, a'); if (!button) return;
  if (button.classList.contains('skip-link')) { event.preventDefault(); $('#content').focus(); return; }
  if (button.matches('[aria-disabled="true"]')) return event.preventDefault();
  if (button.hasAttribute('data-folder')) return chooseFolder();
  if (button.hasAttribute('data-unsupported')) return $('#unsupported-dialog').showModal();
  if (button.id === 'forget-folder') { await cloudWorkspace.forget(); clearSnapshotPath(); await reload(); notify('Folder disconnected. Your files are unchanged.'); return; }
  if (cloudWorkspace && button.matches('a[href^="/api/export"]')) {
    event.preventDefault();
    try {
      const value = await cloudWorkspace.data(range);
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'cadence-training-data.json'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { notify(error.message, true); }
    return;
  }
  if (button.hasAttribute('data-connect')) showConnect();
  if (button.dataset.route) location.hash = button.dataset.route;
  if (button.dataset.close) $('#' + button.dataset.close).close();
  if (button.dataset.activity) showActivity(button.dataset.activity);
  if (button.hasAttribute('data-plan')) await openPlan();
  if (button.id === 'snapshot-info') $('#snapshot-info-dialog').showModal();
  if (button.id === 'reset-prompt') { promptEdited = false; updatePrompt(); $('#plan-prompt').focus(); }
  if (button.id === 'save-profile') {
    $('#plan-error').hidden = true;
    try { await savePlanProfile(); notify('Profile saved.'); } catch (error) { planError(error.message); }
  }
  if (button.id === 'forget-key') { activeSync?.abort(); browser.remove('cadence.garminKey'); session.remove('cadence.garminKey'); memoryKey = ''; render(); notify('Key removed from this browser. Saved training history is still available.'); }
  if (button.id === 'full-sync') await sync({ full: true });
});
document.addEventListener('change', async event => {
  if (event.target.id === 'include-snapshot-link') {
    includeSnapshotLink = event.target.checked; session.set('cadence.includeSnapshotLink', String(includeSnapshotLink));
    renderSnapshotLink();
  }
  if (event.target.id === 'plan-range') {
    range = Number(event.target.value);
    try { await reload(); updatePrompt(); } catch (error) { planError(error.message); }
  }
  if (event.target.id === 'view-range') { range = Number(event.target.value); await reload().catch(e => notify(e.message, true)); }
  if (event.target.id === 'activity-sport') { activitySport = event.target.value; render(); }
});
document.addEventListener('input', event => {
  if (event.target.id === 'snapshot-path') { snapshotPath = event.target.value; session.set('cadence.snapshotPath', snapshotPath); }
  if (event.target.id === 'plan-prompt') { promptEdited = true; updatePrompt(); }
  else if (event.target.closest('#profile-fields')) updatePrompt();
  if (event.target.id === 'activity-search') {
    activitySearch = event.target.value; const start = event.target.selectionStart; render();
    const input = $('#activity-search'); input.focus(); input.setSelectionRange(start, start);
  }
});
$('#toggle-key').addEventListener('click', () => {
  const show = $('#api-key').type === 'password'; $('#api-key').type = show ? 'text' : 'password';
  $('#toggle-key').textContent = show ? 'Hide' : 'Show'; $('#toggle-key').setAttribute('aria-pressed', String(show));
});
$('#connect-form').addEventListener('submit', async event => {
  event.preventDefault();
  const key = $('#api-key').value.trim(); const days = Number($('#sync-days').value);
  if (key.length < 8 || /[\r\n]/.test(key)) { $('#connect-error').textContent = 'Enter a valid Garmin Personal API key.'; $('#connect-error').hidden = false; return; }
  if (!browser.set('cadence.garminKey', key)) { memoryKey = key; notify('Browser storage is unavailable. The key will last until this page reloads.'); }
  session.set('cadence.syncDays', days); $('#api-key').value = ''; $('#connect-dialog').close(); await sync({ key, days });
});
$('#connect-dialog').addEventListener('close', () => { $('#api-key').value = ''; });
$('#plan-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#plan-error').hidden = true;
  const prompt = $('#plan-prompt').value;
  if (!prompt.trim()) return planError('The prompt is empty. Regenerate it from the form or write your own.');
  let text = planHandoff(prompt, data);
  if (includeSnapshotLink) {
    try { text = withSnapshotReference(text); }
    catch (error) { planError(error.message); return $('#snapshot-path')?.focus(); }
  }
  let saved = true;
  try { await savePlanProfile(); } catch { saved = false; }
  await copy(text);
  if (!saved) notify('Prompt copied, but your profile could not be saved. Choose your data folder to keep it.', true);
  $('#plan-dialog').close();
});
$('#sync-button').addEventListener('click', () => sync());
window.addEventListener('hashchange', render);
try {
  bootstrap = await api('/api/bootstrap');
  if (bootstrap.mode === 'cloud') {
    const { FolderWorkspace } = await import('./folder-workspace.mjs');
    cloudWorkspace = new FolderWorkspace(); await cloudWorkspace.restore();
    if (!cloudWorkspace.supported && session.get('cadence.unsupportedSeen') !== 'true') {
      session.set('cadence.unsupportedSeen', 'true'); $('#unsupported-dialog').showModal();
    }
    $('.local-status strong').textContent = 'Files on your device';
    $('.local-status div span').textContent = 'Your folder · Your Garmin key';
    $('.sidebar-note p').textContent = 'Your training history lives in a folder you choose. Open the same folder in another browser to continue.';
    $('.footer span:first-child').textContent = 'Local files · Garmin via Cloudflare';
    $('#connect-dialog .privacy-note p').textContent = 'Your key is saved only in this browser until you forget it. Cloudflare temporarily processes the key and Garmin responses during syncing. Training history is saved only to your selected local folder.';
  }
  await reload();
  if (getKey() && (!cloudWorkspace || cloudWorkspace.connected)) await sync();
} catch (error) {
  $('#page').innerHTML = `<div class="warning error-banner"><strong>Could not load Cadence.</strong><p>${escapeHtml(error.message)}</p><p>Check your connection, then refresh the page.</p></div>`;
}
