const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { createStore, signV4, EMPTY_HASH } = require('../s3');
const { runDrill, publicView, duration } = require('../drill');
const { interpolate } = require('../config');
const { createAgent, createServer } = require('../server');

const HOUR = 36e5;

// A real SQLite file shaped like a HetOps backup.
function sqliteBytes({ users = 2, scanAgeMs = HOUR } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const file = path.join(dir, 'b.db');
  const db = new Database(file);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); CREATE TABLE scans (id INTEGER PRIMARY KEY, ts INTEGER)');
  for (let i = 0; i < users; i++) db.prepare('INSERT INTO users (email) VALUES (?)').run(`u${i}@example.test`);
  db.prepare('INSERT INTO scans (ts) VALUES (?)').run(Date.now() - scanAgeMs);
  db.close();
  const bytes = fs.readFileSync(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return bytes;
}

// Minimal S3: ListObjectsV2 and GetObject over a map of key -> { body, modified }.
function fakeS3(objects) {
  const server = http.createServer((req, res) => {
    assert.match(req.headers.authorization || '', /^AWS4-HMAC-SHA256 Credential=test-key\//);
    const url = new URL(req.url, 'http://x');
    const [, bucket, ...rest] = url.pathname.split('/');
    assert.equal(bucket, 'backups');
    const key = rest.map(decodeURIComponent).join('/');
    if (!key) {
      const prefix = url.searchParams.get('prefix') || '';
      const items = Object.entries(objects).filter(([k]) => k.startsWith(prefix));
      res.end(`<ListBucketResult>${items.map(([k, o]) => `<Contents><Key>${k}</Key><Size>${o.body.length}</Size><LastModified>${o.modified.toISOString()}</LastModified></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      return;
    }
    if (!objects[key]) { res.writeHead(404); res.end(); return; }
    res.end(objects[key].body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, endpoint: `http://127.0.0.1:${server.address().port}` })));
}

const DRILL = {
  name: 'App', prefix: 'app/', match: '\\.db(\\.gz)?$', max_age: '26h',
  checks: [{ table: 'users', min_rows: 1 }, { table: 'scans', newest: 'ts', max_age: '2d' }],
};

async function drill(objects, overrides = {}) {
  const { server, endpoint } = await fakeS3(objects);
  try {
    const store = createStore({ endpoint, bucket: 'backups', accessKeyId: 'test-key', secretAccessKey: 'test-secret' });
    return await runDrill({ ...DRILL, ...overrides }, store);
  } finally {
    server.close();
  }
}

test('restores the newest backup and passes every check', async () => {
  const r = await drill({
    'app/app-old.db': { body: sqliteBytes({ users: 1 }), modified: new Date(Date.now() - 30 * HOUR) },
    'app/app-new.db': { body: sqliteBytes(), modified: new Date(Date.now() - 2 * HOUR) },
    'app/notes.txt': { body: Buffer.from('not a backup'), modified: new Date() },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.backup.key, 'app/app-new.db');
  assert.equal(r.backup.count, 2);
  assert.ok(r.checks.find((c) => c.name.includes('integrity')).ok);
  assert.equal(typeof r.restoreMs, 'number');
});

test('gzipped backups are decompressed before the restore', async () => {
  const r = await drill({ 'app/app.db.gz': { body: zlib.gzipSync(sqliteBytes()), modified: new Date() } });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('a corrupt file fails the drill instead of being trusted', async () => {
  const bytes = sqliteBytes();
  bytes.fill(0x41, 0, 100); // smash the SQLite header
  const r = await drill({ 'app/app.db': { body: bytes, modified: new Date() } });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a database|malformed|file/i);
});

test('a stale backup fails even when it restores fine', async () => {
  const r = await drill({ 'app/app.db': { body: sqliteBytes(), modified: new Date(Date.now() - 50 * HOUR) } });
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].ok, false);
  assert.match(r.checks[0].detail, /old/);
});

test('missing tables, too few rows and old data each fail', async () => {
  const body = sqliteBytes({ users: 0, scanAgeMs: 5 * 24 * HOUR });
  const r = await drill({ 'app/app.db': { body, modified: new Date() } }, {
    checks: [{ table: 'users', min_rows: 1 }, { table: 'scans', newest: 'ts', max_age: '2d' }, { table: 'nope' }, { query: 'SELECT COUNT(*) FROM scans', expect: 1 }],
  });
  const byName = Object.fromEntries(r.checks.map((c) => [c.name, c.ok]));
  assert.equal(r.ok, false);
  assert.equal(byName['users has at least 1 row'], false);
  assert.equal(byName['scans newest row within 2d'], false);
  assert.equal(byName['nope exists'], false);
  assert.equal(byName['query = 1'], true);
});

test('no backups under the prefix is a failure, not a pass', async () => {
  const r = await drill({});
  assert.equal(r.ok, false);
  assert.match(r.error, /no backups/);
});

test('the public view hides row counts and storage URLs', () => {
  const v = publicView({ name: 'A', ok: false, at: 'x', ms: 1, checks: [{ name: 'users has at least 1 row', ok: true, detail: '42 rows' }], error: 'storage list failed at https://acct.r2.cloudflarestorage.com/b' });
  assert.equal(JSON.stringify(v).includes('42'), false);
  assert.equal(v.error.includes('r2.cloudflarestorage'), false);
});

// AWS's published examples ("Signature Calculations for the Authorization Header").
test('Signature V4 matches the AWS S3 examples', () => {
  // AWS's documented example key, split so secret scanners don't mistake it for a real one.
  const creds = { accessKeyId: 'AKIA' + 'IOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3', amzDate: '20130524T000000Z' };
  const getObject = signV4({ ...creds, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_HASH }, payloadHash: EMPTY_HASH });
  assert.equal(getObject.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  const listObjects = signV4({ ...creds, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J', headers: { 'x-amz-content-sha256': EMPTY_HASH }, payloadHash: EMPTY_HASH });
  assert.equal(listObjects.signature, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

test('config: ${VAR} and ${VAR:-default} come from the environment', () => {
  const missing = new Set();
  const out = interpolate({ a: '${A}', b: '${B:-fallback}', c: ['x-${A}'], d: '${NOPE}' }, { A: '1' }, missing);
  assert.deepEqual(out, { a: '1', b: 'fallback', c: ['x-1'], d: '' });
  assert.deepEqual([...missing], ['NOPE']);
  assert.equal(duration('26h'), 26 * HOUR);
  assert.throws(() => duration('soon'));
});

test('agent: health is pending, then reports each drill; the server serves it', async () => {
  const { server: s3, endpoint } = await fakeS3({ 'app/app.db': { body: sqliteBytes(), modified: new Date() } });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-data-'));
  const agent = createAgent({
    config: { every: 6 * HOUR, drills: [DRILL] },
    store: createStore({ endpoint, bucket: 'backups', accessKeyId: 'test-key', secretAccessKey: 'test-secret' }),
    dataDir, log: { info() {}, error() {} },
  });
  assert.equal(agent.health().ok, false);
  assert.equal(agent.health().drills[0].pending, true);
  await agent.runAll();
  assert.equal(agent.health().ok, true);
  assert.ok(fs.existsSync(path.join(dataDir, 'results.json')));

  const web = createServer(agent);
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${web.address().port}`;
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const health = await res.json();
  assert.equal(health.ok, true);
  assert.equal(health.drills[0].checks.length, 4);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.match(await (await fetch(`${base}/`)).text(), /Restore Drill/);
  web.close();
  s3.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
