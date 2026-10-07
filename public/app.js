// Evidence page: reads /api/health and /api/history and draws one card per drill.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function spark(values, w = 220, h = 36) {
  const pts = values.filter((v) => typeof v === 'number');
  if (pts.length < 2) return null;
  const max = Math.max(...pts) || 1;
  const step = w / (values.length - 1);
  let d = '';
  values.forEach((v, i) => { if (typeof v === 'number') d += `${d ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 6)).toFixed(1)} `; });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

function card(d, runs) {
  const state = d.pending ? 'pending' : d.ok ? 'ok' : 'bad';
  const c = el('article', `drill is-${state}`);
  const head = el('header', 'drill-head');
  const title = el('div', 'drill-title');
  title.append(el('h2', '', d.name));
  if (d.engine) title.append(el('span', 'engine', d.engine === 'postgres' ? 'PostgreSQL' : 'SQLite'));
  head.append(title, el('span', 'chip', d.pending ? 'Waiting' : d.ok ? 'Restores' : 'Failed'));
  c.append(head);
  if (d.pending) { c.append(el('p', 'note', 'First drill runs a few seconds after start.')); return c; }

  const facts = el('dl', 'facts');
  const fact = (k, v) => { const f = el('div'); f.append(el('dt', '', k), el('dd', '', v)); facts.append(f); };
  fact('Backup', d.backup ? `${d.backup.age} old` : '–');
  fact('Restore', d.restoreMs !== null ? `${d.restoreMs} ms` : '–');
  fact('Size', d.backup ? kb(d.backup.bytes) : '–');
  fact('Drilled', ago(d.at));
  c.append(facts);

  const list = el('ul', 'checks');
  for (const k of d.checks) { const li = el('li', k.ok ? 'pass' : 'fail'); li.append(el('i', '', k.ok ? '✓' : '✗'), el('span', '', k.name)); list.append(li); }
  if (d.error) { const li = el('li', 'fail'); li.append(el('i', '', '✗'), el('span', '', d.error)); list.append(li); }
  c.append(list);

  if (runs.length) {
    const passed = runs.filter((r) => r.ok).length;
    const strip = el('div', 'strip');
    strip.setAttribute('role', 'img');
    strip.setAttribute('aria-label', `${passed} of ${runs.length} recent drills passed`);
    for (const r of runs) { const b = el('span', r.ok ? 'p' : 'f'); b.title = `${new Date(r.at).toLocaleString()} · ${r.ok ? 'restored' : 'failed'}${r.restoreMs ? ` · ${r.restoreMs} ms` : ''}`; strip.append(b); }
    const hist = el('div', 'hist');
    const label = el('p', 'hist-label', `${passed}/${runs.length} recent drills restored`);
    hist.append(label, strip);
    const s = spark(runs.map((r) => r.restoreMs));
    if (s) { const sw = el('div', 'spark-wrap'); sw.append(el('span', 'hist-label', 'Restore time'), s); hist.append(sw); }
    c.append(hist);
  }
  return c;
}

async function load() {
  try {
    const [health, history] = await Promise.all([fetch('/api/health').then((r) => r.json()), fetch('/api/history').then((r) => r.json())]);
    const done = health.drills.filter((d) => !d.pending);
    const bad = done.filter((d) => !d.ok);
    const hero = $('hero');
    if (!done.length) { hero.dataset.state = 'pending'; }
    else if (bad.length) {
      hero.dataset.state = 'bad';
      $('eyebrow').textContent = 'Attention';
      $('verdict').textContent = `${bad.length} of ${done.length} backups did not restore`;
    } else {
      hero.dataset.state = 'ok';
      $('eyebrow').textContent = 'Verified';
      $('verdict').textContent = done.length === 1 ? 'The backup restores' : done.length === 2 ? 'Both backups restore' : `All ${done.length} backups restore`;
    }
    $('meta').textContent = health.checkedAt ? `Last drill ${ago(health.checkedAt)} · runs every ${health.every}` : `Runs every ${health.every}`;
    $('version').textContent = `v${health.version}`;
    const box = $('drills');
    box.replaceChildren(...health.drills.map((d) => card(d, history[d.name] || [])));
  } catch {
    $('verdict').textContent = 'Could not load the drill results';
  }
}
load();
setInterval(() => { if (!document.hidden) load(); }, 60000);
