// One restore drill: take the newest backup under a prefix, restore it somewhere disposable,
// prove it is a usable database, then throw the copy away. A backup that was never restored
// is a hope, not a backup.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');

const UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
function duration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(String(text).trim());
  if (!m) throw new Error(`bad duration "${text}" (use 30m, 26h, 7d)`);
  return Number(m[1]) * UNITS[m[2]];
}
function human(ms) {
  if (ms < 6e4) return `${Math.round(ms / 1e3)} s`;
  if (ms < 36e5) return `${Math.round(ms / 6e4)} min`;
  if (ms < 864e5) return `${(ms / 36e5).toFixed(1).replace(/\.0$/, '')} h`;
  return `${(ms / 864e5).toFixed(1).replace(/\.0$/, '')} d`;
}

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(t);
// Timestamps may be stored in seconds or milliseconds; anything after 2001 in ms is > 1e12.
const toMs = (v) => (typeof v === 'string' ? Date.parse(v) : v > 1e12 ? v : v * 1000);

// Each check returns { name, ok, detail }. Details can hold row counts, so they stay out of public output.
function runCheck(db, c, now) {
  if (c.query) {
    const row = db.prepare(c.query).raw().get();
    const got = row ? String(row[0]) : '(no rows)';
    return { name: c.name || `query = ${c.expect}`, ok: got === String(c.expect), detail: `returned ${got}` };
  }
  if (!c.table) throw new Error('a check needs "table" or "query"');
  if (!hasTable(db, c.table)) return { name: `${c.table} exists`, ok: false, detail: 'table missing' };
  if (c.newest) {
    const v = db.prepare(`SELECT MAX(${quote(c.newest)}) FROM ${quote(c.table)}`).raw().get()[0];
    if (v === null || v === undefined) return { name: `${c.table} has recent rows`, ok: false, detail: 'no rows' };
    const age = now - toMs(v);
    return { name: `${c.table} newest row within ${c.max_age}`, ok: age <= duration(c.max_age), detail: `newest row ${human(Math.max(0, age))} old` };
  }
  const n = db.prepare(`SELECT COUNT(*) FROM ${quote(c.table)}`).raw().get()[0];
  const min = c.min_rows ?? 1;
  const name = min === 0 ? `${c.table} table is present` : `${c.table} has at least ${min} row${min === 1 ? '' : 's'}`;
  return { name, ok: n >= min, detail: `${n} rows` };
}

async function runDrill(drill, store, { now = Date.now(), tmp = os.tmpdir() } = {}) {
  const started = Date.now();
  const r = { name: drill.name, ok: false, at: new Date(now).toISOString(), checks: [] };
  try {
    const match = drill.match ? new RegExp(drill.match) : null;
    const objects = (await store.list(drill.prefix)).filter((o) => o.size > 0 && (!match || match.test(o.key)));
    if (!objects.length) throw new Error(`no backups under ${drill.prefix}`);
    const newest = objects.reduce((a, b) => (b.modified > a.modified ? b : a));
    const age = now - newest.modified.getTime();
    r.backup = { key: newest.key, bytes: newest.size, at: newest.modified.toISOString(), age: human(Math.max(0, age)), count: objects.length };
    r.checks.push({ name: `newest backup within ${drill.max_age}`, ok: age <= duration(drill.max_age), detail: `${r.backup.age} old` });

    let t = Date.now();
    let body = await store.get(newest.key);
    if (newest.key.endsWith('.gz')) body = zlib.gunzipSync(body);
    r.downloadMs = Date.now() - t;

    // The disposable restore target: a private temp directory, removed whatever happens.
    const dir = fs.mkdtempSync(path.join(tmp, 'restore-drill-'));
    try {
      const file = path.join(dir, 'restored.db');
      fs.writeFileSync(file, body);
      t = Date.now();
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        const integrity = db.pragma('integrity_check', { simple: true });
        r.checks.push({ name: 'opens and passes integrity_check', ok: integrity === 'ok', detail: integrity });
        for (const c of drill.checks || []) r.checks.push(runCheck(db, c, now));
      } finally {
        db.close();
      }
      r.restoreMs = Date.now() - t;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    // "file is not a database" and friends land here: the restore itself failed.
    r.error = err.message;
  }
  r.ok = !r.error && r.checks.length > 0 && r.checks.every((c) => c.ok);
  r.ms = Date.now() - started;
  return r;
}

// What anyone may see: pass/fail, timings, backup age. No row counts, no query results.
function publicView(r) {
  return {
    name: r.name, ok: r.ok, at: r.at, ms: r.ms, restoreMs: r.restoreMs ?? null,
    backup: r.backup ? { at: r.backup.at, age: r.backup.age, bytes: r.backup.bytes } : null,
    checks: r.checks.map((c) => ({ name: c.name, ok: c.ok })),
    error: r.error ? r.error.replace(/https?:\/\/\S+/g, '<storage>') : undefined,
  };
}

module.exports = { runDrill, publicView, duration, human };
