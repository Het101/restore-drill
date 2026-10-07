// One restore drill: take the newest backup under a prefix, restore it somewhere disposable,
// prove it is a usable database, then throw the copy away. A backup that was never restored
// is a hope, not a backup.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { restorePostgres } = require('./pg');

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

// Identifiers: "name", or "schema"."name" when the config says schema.name.
const quote = (name) => String(name).split('.').map((p) => `"${p.replace(/"/g, '""')}"`).join('.');
// Timestamps may be epoch seconds or milliseconds (anything after 2001 in ms is > 1e12), ISO text,
// or Postgres text output ("2026-10-07 05:00:00.123+00"); a timestamp without a zone is read as UTC.
function toMs(v) {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s));
  // Postgres prints zones as +00 or +0530; Date.parse wants +00:00.
  const iso = s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00').replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  return Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`);
}

// Each engine answers the same four questions, so every check works on both.
function sqliteEngine(db) {
  const one = (sql, ...args) => db.prepare(sql).raw().get(...args);
  return {
    hasTable: async (t) => !!one("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?", t),
    count: async (t) => one(`SELECT COUNT(*) FROM ${quote(t)}`)[0],
    newest: async (t, col) => one(`SELECT MAX(${quote(col)}) FROM ${quote(t)}`)[0],
    query: async (sql) => { const row = one(sql); return row ? row[0] : null; },
  };
}
function postgresEngine(pg) {
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return {
    hasTable: async (t) => (await pg.query(`SELECT to_regclass(${lit(quote(t))}) IS NOT NULL`)) === 't',
    count: async (t) => Number(await pg.query(`SELECT COUNT(*) FROM ${quote(t)}`)),
    newest: async (t, col) => { const v = await pg.query(`SELECT MAX(${quote(col)})::text FROM ${quote(t)}`); return v === '' ? null : v; },
    query: async (sql) => { const out = await pg.query(sql); return out === '' ? null : out.split('\n')[0].split('|')[0]; },
  };
}

// Each check returns { name, ok, detail }. Details can hold row counts, so they stay out of public output.
async function runCheck(db, c, now) {
  if (c.query) {
    const v = await db.query(c.query);
    const got = v === null || v === undefined ? '(no rows)' : String(v);
    return { name: c.name || `query = ${c.expect}`, ok: got === String(c.expect), detail: `returned ${got}` };
  }
  if (!c.table) throw new Error('a check needs "table" or "query"');
  if (!(await db.hasTable(c.table))) return { name: `${c.table} exists`, ok: false, detail: 'table missing' };
  if (c.newest) {
    const v = await db.newest(c.table, c.newest);
    if (v === null || v === undefined) return { name: `${c.table} has recent rows`, ok: false, detail: 'no rows' };
    const age = now - toMs(v);
    return { name: `${c.table} newest row within ${c.max_age}`, ok: age <= duration(c.max_age), detail: `newest row ${human(Math.max(0, age))} old` };
  }
  const n = await db.count(c.table);
  const min = c.min_rows ?? 1;
  const name = min === 0 ? `${c.table} table is present` : `${c.table} has at least ${min} row${min === 1 ? '' : 's'}`;
  return { name, ok: n >= min, detail: `${n} rows` };
}

async function restoreAndCheck(drill, file, dir, now, r) {
  if (drill.engine === 'postgres') {
    const pg = await restorePostgres(file, dir); // throws if the dump does not restore
    try {
      r.checks.push({ name: 'restores cleanly into a fresh PostgreSQL', ok: true, detail: 'pg_restore exited 0' });
      const db = postgresEngine(pg);
      for (const c of drill.checks || []) r.checks.push(await runCheck(db, c, now));
    } finally {
      await pg.stop();
    }
    return;
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    r.checks.push({ name: 'opens and passes integrity_check', ok: integrity === 'ok', detail: integrity });
    const engine = sqliteEngine(db);
    for (const c of drill.checks || []) r.checks.push(await runCheck(engine, c, now));
  } finally {
    db.close();
  }
}

async function runDrill(drill, store, { now = Date.now(), tmp = os.tmpdir() } = {}) {
  const started = Date.now();
  const r = { name: drill.name, engine: drill.engine || 'sqlite', ok: false, at: new Date(now).toISOString(), checks: [] };
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
      const file = path.join(dir, 'backup');
      fs.writeFileSync(file, body);
      t = Date.now();
      await restoreAndCheck({ ...drill, engine: r.engine }, file, dir, now, r);
      r.restoreMs = Date.now() - t;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    // "file is not a database", a pg_restore error and friends land here: the restore itself failed.
    r.error = err.message;
  }
  r.ok = !r.error && r.checks.length > 0 && r.checks.every((c) => c.ok);
  r.ms = Date.now() - started;
  return r;
}

// What anyone may see: pass/fail, timings, backup age. No row counts, no query results.
function publicView(r) {
  return {
    name: r.name, engine: r.engine || 'sqlite', ok: r.ok, at: r.at, ms: r.ms, restoreMs: r.restoreMs ?? null,
    backup: r.backup ? { at: r.backup.at, age: r.backup.age, bytes: r.backup.bytes } : null,
    checks: r.checks.map((c) => ({ name: c.name, ok: c.ok })),
    error: r.error ? r.error.replace(/https?:\/\/\S+/g, '<storage>') : undefined,
  };
}

module.exports = { runDrill, publicView, duration, human, toMs };
