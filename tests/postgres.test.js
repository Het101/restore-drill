// PostgreSQL drills against real dumps made by real pg_dump. Needs the Postgres binaries
// (initdb, pg_ctl, pg_dump, pg_restore, psql); skipped where they are missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { available } = require('../pg');
const { runDrill, toMs } = require('../drill');

const HOUR = 36e5;
// A private temp root, so the leftover check can't see other test files' directories.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-drill-'));
const binDir = () => (process.env.PG_BIN || ['17', '16', '15'].map((v) => `/usr/lib/postgresql/${v}/bin`).find((d) => fs.existsSync(`${d}/initdb`)) || '');
const bin = (n) => (binDir() ? path.join(binDir(), n) : n);

// A source database shaped like Umami, dumped once in each format.
let dumps = null;
function makeDumps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-src-'));
  const data = path.join(dir, 'data');
  const port = '54999';
  execFileSync(bin('initdb'), ['-D', data, '-U', 'src', '--auth=trust', '--no-sync'], { stdio: 'ignore' });
  execFileSync(bin('pg_ctl'), ['-D', data, '-l', path.join(dir, 'log'), '-w', '-o', `-c listen_addresses='' -k ${dir} -p ${port}`, 'start'], { stdio: 'ignore' });
  const c = ['-h', dir, '-p', port, '-U', 'src'];
  try {
    execFileSync(bin('psql'), [...c, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-c', `
      CREATE SCHEMA analytics;
      CREATE TABLE website (website_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
      CREATE TABLE analytics.website_event (id bigserial PRIMARY KEY, created_at timestamptz NOT NULL, url text);
      CREATE ROLE app_owner; ALTER TABLE website OWNER TO app_owner;
      INSERT INTO website (name) VALUES ('hetops.dev'), ('dns.hetops.dev');
      INSERT INTO analytics.website_event (created_at, url) SELECT now() - (n || ' minutes')::interval, '/p' || n FROM generate_series(1, 500) n;
    `]);
    const custom = path.join(dir, 'db.dump');
    const plain = path.join(dir, 'db.sql');
    execFileSync(bin('pg_dump'), [...c, '-d', 'postgres', '--format=custom', '-f', custom]);
    execFileSync(bin('pg_dump'), [...c, '-d', 'postgres', '--format=plain', '-f', plain]);
    return { custom: fs.readFileSync(custom), plain: fs.readFileSync(plain) };
  } finally {
    execFileSync(bin('pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const store = (objects) => ({
  list: async (prefix) => Object.entries(objects).filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.body.length, modified: o.modified })),
  get: async (key) => objects[key].body,
});

const DRILL = {
  name: 'Umami', engine: 'postgres', prefix: 'umami/', max_age: '26h',
  checks: [
    { table: 'website', min_rows: 2 },
    { table: 'analytics.website_event', min_rows: 100 },
    { table: 'analytics.website_event', newest: 'created_at', max_age: '1d' },
    { query: 'SELECT COUNT(*) FROM website WHERE name LIKE \'%hetops%\'', expect: 2 },
  ],
};

test('postgres drills', async (t) => {
  if (!(await available())) {
    t.skip('PostgreSQL binaries not installed');
    return;
  }
  dumps = dumps || makeDumps();

  await t.test('a custom-format dump restores into a throwaway server and passes every check', async () => {
    const r = await runDrill(DRILL, store({ 'umami/pg-dump-umami.dmp': { body: dumps.custom, modified: new Date(Date.now() - HOUR) } }), { tmp: TMP });
    assert.equal(r.ok, true, JSON.stringify(r, null, 2));
    assert.equal(r.engine, 'postgres');
    assert.equal(r.checks.length, 1 + 1 + DRILL.checks.length);
  });

  await t.test('a gzipped plain SQL dump restores too', async () => {
    const r = await runDrill(DRILL, store({ 'umami/umami.sql.gz': { body: zlib.gzipSync(dumps.plain), modified: new Date() } }), { tmp: TMP });
    assert.equal(r.ok, true, JSON.stringify(r, null, 2));
  });

  await t.test('a truncated dump fails the restore instead of being trusted', async () => {
    const r = await runDrill(DRILL, store({ 'umami/broken.dmp': { body: dumps.custom.subarray(0, Math.floor(dumps.custom.length / 3)), modified: new Date() } }), { tmp: TMP });
    assert.equal(r.ok, false);
    assert.match(r.error, /pg_restore failed/);
  });

  await t.test('wrong expectations fail with the reason', async () => {
    const r = await runDrill({ ...DRILL, checks: [{ table: 'website', min_rows: 50 }, { table: 'missing_table' }, { table: 'analytics.website_event', newest: 'created_at', max_age: '1m' }] },
      store({ 'umami/pg-dump-umami.dmp': { body: dumps.custom, modified: new Date() } }), { tmp: TMP });
    assert.equal(r.ok, false);
    assert.deepEqual(r.checks.slice(2).map((c) => c.ok), [false, false, false]);
    assert.equal(r.checks[3].detail, 'table missing');
  });

  await t.test('no throwaway server or data directory is left behind', () => {
    assert.deepEqual(fs.readdirSync(TMP), []);
  });
});

test('Postgres timestamps parse with and without a zone', () => {
  assert.equal(toMs('2026-10-07 05:00:00+00'), Date.UTC(2026, 9, 7, 5));
  assert.equal(toMs('2026-10-07 05:00:00.5'), Date.UTC(2026, 9, 7, 5, 0, 0, 500));
  assert.equal(toMs('2026-10-07 10:30:00+05:30'), Date.UTC(2026, 9, 7, 5));
  assert.equal(toMs('1791300000'), 1791300000000);
  assert.equal(toMs(1791300000000), 1791300000000);
});
