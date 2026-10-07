// Evidence page: reads /api/health and /api/history and writes the document. Every node is
// built with textContent (no innerHTML), so nothing from the API can inject markup.
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const bold = (t) => el('b', '', t);

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const stamp = (iso) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const ms = (v) => (v === null || v === undefined ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

function mark(ok) {
  const s = svgEl('svg', { viewBox: '0 0 14 14', 'aria-hidden': 'true' });
  s.append(svgEl('path', { d: ok ? 'M2.5 7.5 L5.6 10.4 L11.5 3.8' : 'M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  const m = el('span', 'mark');
  m.append(s);
  return m;
}

function strip(runs) {
  const s = el('span', 'strip');
  const last = runs.slice(-30);
  for (let i = last.length; i < 30; i++) s.append(el('i', 'e'));
  for (const r of last) { const b = el('i', r.ok ? '' : 'f'); b.title = `${stamp(r.at)} · ${r.ok ? 'restored' : 'failed'}${r.restoreMs ? ` in ${ms(r.restoreMs)}` : ''}`; s.append(b); }
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', `${last.filter((r) => r.ok).length} of ${last.length} recent drills restored`);
  return s;
}

function spark(values) {
  const pts = values.map((v) => (typeof v === 'number' ? v : null));
  if (pts.filter((v) => v !== null).length < 2) return null;
  const w = 300, h = 56, max = Math.max(...pts.filter((v) => v !== null)) || 1, step = w / (pts.length - 1);
  let d = '';
  pts.forEach((v, i) => { if (v !== null) d += `${d ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - 4 - (v / max) * (h - 10)).toFixed(1)} `; });
  const s = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', class: 'spark', 'aria-hidden': 'true' });
  s.append(svgEl('path', { d }));
  return s;
}

function row(d, runs, i) {
  const state = d.pending ? 'pending' : d.ok ? 'ok' : 'bad';
  const det = el('details', `row is-${state}`);
  det.style.setProperty('--i', i); // CSSOM, which the CSP allows (it blocks style attributes only)
  if (state === 'bad') det.open = true;
  const sum = el('summary');
  const nameCell = el('span', 'name-cell');
  const wrap = el('span', 'name-wrap');
  wrap.append(el('span', 'name', d.name), el('span', 'engine', `${d.engine === 'postgres' ? 'PostgreSQL' : 'SQLite'}${d.pending ? ' · waiting for the first drill' : d.ok ? '' : ' · did not restore'}`));
  nameCell.append(mark(state !== 'bad'), wrap);
  const chev = svgEl('svg', { viewBox: '0 0 16 16', width: '16', height: '16', class: 'chev', 'aria-hidden': 'true' });
  chev.append(svgEl('path', { d: 'M4 6 L8 10 L12 6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
  sum.append(
    nameCell,
    el('span', 'cell c-age', d.backup ? d.backup.age : '–'),
    el('span', 'cell c-restore', ms(d.restoreMs)),
    el('span', 'cell c-size', d.backup ? kb(d.backup.bytes) : '–'),
    strip(runs),
    chev,
  );
  det.append(sum);

  const ev = el('div', 'evidence');
  const list = el('ul', 'checks');
  for (const c of d.checks || []) { const li = el('li', c.ok ? 'pass' : 'fail'); li.append(el('i', c.ok ? 'ok' : 'no', c.ok ? '✓' : '✗'), el('span', '', c.name)); list.append(li); }
  if (d.error) { const li = el('li', 'fail'); li.append(el('i', 'no', '✗'), el('span', '', d.error)); list.append(li); }
  if (!list.children.length) list.append(el('li', '', 'No checks yet.'));
  const trace = el('div', 'trace');
  if (d.backup) {
    const p = el('span');
    p.append('Backup taken ', bold(stamp(d.backup.at)), ', drilled ', bold(ago(d.at)), '.');
    trace.append(p);
  }
  if (runs.length) trace.append(el('span', '', `${runs.filter((r) => r.ok).length} of ${runs.length} drills restored. Restore time:`));
  const s = spark(runs.slice(-30).map((r) => r.restoreMs));
  if (s) trace.append(s);
  ev.append(list, trace);
  det.append(ev);
  return det;
}

let health = null;
function tick() {
  if (!health || !health.checkedAt || !health.everyMs) return;
  const left = Date.parse(health.checkedAt) + health.everyMs - Date.now();
  if (left <= 0) { $('next').textContent = 'running now'; return; }
  const t = Math.floor(left / 1000);
  $('next').textContent = [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

function render(h, history) {
  health = h;
  const drills = h.drills;
  const done = drills.filter((d) => !d.pending);
  const bad = done.filter((d) => !d.ok);
  const state = !done.length ? 'pending' : bad.length ? 'bad' : 'ok';
  document.body.dataset.state = state;

  const line = (text, em) => { const s = el('span', 'line'); if (em) s.append(el('em', '', text)); else s.textContent = text; return s; };
  const h1 = $('verdict');
  if (state === 'pending') h1.replaceChildren(line('First drill'), line('is running.', true));
  else if (state === 'bad') h1.replaceChildren(line(`${bad.length} of ${done.length} backups`), line('did not restore.', true));
  else h1.replaceChildren(line(done.length === 1 ? 'The backup' : `${done.length} of ${done.length} backups`), line('restored.', true));
  $('eyebrow').textContent = state === 'bad' ? 'Attention · a restore failed' : `Restore evidence · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  // A drill that errors before its checks (no backup, a restore that throws) counts as a failed check.
  const checks = done.flatMap((d) => [...(d.checks || []), ...(d.error ? [{ ok: false }] : [])]);
  const passedChecks = checks.filter((c) => c.ok).length;
  const facts = $('facts');
  facts.replaceChildren();
  const fact = (...parts) => { const s = el('span'); s.append(...parts); facts.append(s); };
  if (h.checkedAt) fact('Last proof ', bold(ago(h.checkedAt)));
  fact('Drills every ', bold(h.every));
  if (checks.length) fact(bold(`${passedChecks}/${checks.length}`), ' checks passed');
  fact('Alerts ', bold(h.alerts ? 'on' : 'off'));

  $('seal-count').textContent = done.length ? `${done.length - bad.length}/${done.length}` : '–';
  $('ring-text').textContent = state === 'bad' ? 'RESTORE FAILED · ACTION NEEDED · RESTORE FAILED · ACTION NEEDED ·' : 'RESTORED · VERIFIED · RESTORED · VERIFIED ·';

  // The anatomy strip, measured from the last run.
  const v = (k) => document.querySelector(`[data-step="${k}"]`);
  const withBackup = done.filter((d) => d.backup);
  const youngest = withBackup.sort((a, b) => Date.parse(b.backup.at) - Date.parse(a.backup.at))[0];
  v('find').textContent = done.length ? `${withBackup.length} of ${drills.length}${youngest ? ` · newest ${youngest.backup.age}` : ''}` : '–';
  v('find').classList.toggle('warn', withBackup.length < done.length);
  const total = done.reduce((a, d) => a + (d.restoreMs || 0), 0);
  const engines = [...new Set(done.map((d) => (d.engine === 'postgres' ? 'PostgreSQL' : 'SQLite')))].join(' + ');
  v('restore').textContent = done.length ? `${ms(total)} · ${engines}` : '–';
  v('prove').textContent = checks.length ? `${passedChecks} of ${checks.length} checks` : '–';
  v('prove').classList.toggle('warn', passedChecks < checks.length);
  v('destroy').textContent = done.length ? '0 copies kept' : '–';

  $('rows').replaceChildren(...drills.map((d, i) => row(d, history[d.name] || [], i)));

  const log = Object.entries(history).flatMap(([name, runs]) => runs.map((r) => ({ name, ...r }))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 10);
  $('log').replaceChildren(...(log.length ? log.map((r) => {
    const li = el('li');
    const t = el('time', '', stamp(r.at));
    t.dateTime = r.at;
    li.append(t, el('span', 'who', r.name), el('span', `res${r.ok ? '' : ' f'}`, r.ok ? 'PASS' : 'FAIL'), el('span', 'ms', ms(r.restoreMs)));
    return li;
  }) : [el('li', 'empty', 'No drills recorded yet.')]));

  $('version').textContent = `v${h.version}`;
  tick();
}

async function load() {
  try {
    const [h, history] = await Promise.all([fetch('/api/health').then((r) => r.json()), fetch('/api/history').then((r) => r.json())]);
    render(h, history);
  } catch {
    document.body.dataset.state = 'bad';
    $('verdict').replaceChildren(el('span', 'line', 'Evidence'), el('span', 'line', 'unavailable.'));
    $('eyebrow').textContent = 'Could not reach the drill agent';
    $('rows').replaceChildren(el('p', 'empty', 'The results could not be loaded. This page retries every minute.'));
  }
}
load();
setInterval(() => { if (!document.hidden) load(); }, 60000);
setInterval(tick, 1000);
