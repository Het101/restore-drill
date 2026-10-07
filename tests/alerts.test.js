const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAlerter, decide, webhookBody, emailHtml, message } = require('../alerts');
const { createAgent } = require('../server');

const HOUR = 36e5;
const ok = { name: 'Radar Cloud', ok: true, at: '2026-10-07T06:00:00Z', restoreMs: 4, backup: { key: 'radar-cloud/r.db', age: '2 h' }, checks: [{ name: 'opens and passes integrity_check', ok: true, detail: 'ok' }] };
const bad = { ...ok, ok: false, checks: [{ name: 'users has at least 1 row', ok: false, detail: '0 rows' }] };
const quiet = { info() {}, error() {} };

test('decide: alerts on change and reminds while broken, never on steady success', () => {
  assert.equal(decide(null, ok, 0, HOUR), null);
  assert.equal(decide(null, bad, 0, HOUR), 'failed');
  assert.equal(decide({ ok: true }, bad, 0, HOUR), 'failed');
  assert.equal(decide({ ok: false, alertedAt: 0 }, ok, 10, HOUR), 'recovered');
  assert.equal(decide({ ok: false, alertedAt: 0 }, bad, HOUR - 1, HOUR), null);
  assert.equal(decide({ ok: false, alertedAt: 0 }, bad, HOUR, HOUR), 'still failing');
  assert.equal(decide({ ok: true }, ok, 99 * HOUR, HOUR), null);
});

test('webhook bodies: Slack, Discord and plain JSON', () => {
  const m = message('failed', bad, 'https://drill.example');
  const slack = webhookBody('https://hooks.slack.com/services/T/B/x', m);
  assert.match(slack.text, /FAILED · \*Radar Cloud: backup did not restore\*/);
  assert.match(slack.text, /users has at least 1 row: 0 rows/);
  assert.match(webhookBody('https://discord.com/api/webhooks/1/x', m).content, /\*\*Radar Cloud/);
  const plain = webhookBody('https://ops.example/hook', m);
  assert.deepEqual(Object.keys(plain), ['event', 'drill', 'ok', 'at', 'title', 'reasons', 'backup', 'url']);
  assert.equal(plain.event, 'failed');
});

test('email: escaped, with the reasons and a link', () => {
  const html = emailHtml(message('failed', { ...bad, error: '<script>x</script>' }, 'https://drill.example'));
  assert.ok(!html.includes('<script>x'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/drill\.example"/);
});

test('onResult: one alert per change, delivered to every channel', async () => {
  const posts = [];
  const mails = [];
  const alerter = createAlerter({
    config: { webhook: 'https://ops.example/hook', email_to: 'het@example.test', remind: '24h', url: 'https://drill.example' },
    env: {}, log: quiet,
    fetchImpl: async (url, opts) => { posts.push(JSON.parse(opts.body)); return { ok: true }; },
    transport: { sendMail: async (m) => { mails.push(m); } },
  });
  assert.deepEqual(alerter.channels, ['webhook', 'email']);
  let s = await alerter.onResult(null, ok, 0);
  s = await alerter.onResult(s, bad, HOUR);
  s = await alerter.onResult(s, bad, 2 * HOUR); // still broken, inside the reminder window: quiet
  s = await alerter.onResult(s, ok, 3 * HOUR);
  assert.deepEqual(posts.map((p) => p.event), ['failed', 'recovered']);
  assert.equal(mails.length, 2);
  assert.match(mails[0].subject, /did not restore/);
  assert.equal(s.ok, true);
});

test('onResult: a failed delivery keeps the old state so the next run retries', async () => {
  let up = false;
  const alerter = createAlerter({ config: { webhook: 'https://ops.example/hook' }, env: {}, log: quiet, fetchImpl: async () => ({ ok: up, status: 503 }) });
  const s1 = await alerter.onResult({ ok: true }, bad, 0);
  assert.deepEqual(s1, { ok: true });
  up = true;
  const s2 = await alerter.onResult(s1, bad, 1);
  assert.equal(s2.ok, false);
});

test('agent: alert state survives a restart, so a redeploy does not re-alert', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-alerts-'));
  const events = [];
  const alerter = createAlerter({ config: { webhook: 'https://ops.example/hook' }, env: {}, log: quiet, fetchImpl: async (u, o) => { events.push(JSON.parse(o.body).event); return { ok: true }; } });
  const store = { list: async () => [], get: async () => Buffer.alloc(0) }; // empty bucket: every drill fails
  const config = { every: 6 * HOUR, drills: [{ name: 'App', prefix: 'app/', max_age: '26h' }] };
  await createAgent({ config, store, dataDir, log: quiet, alerter }).runAll();
  await createAgent({ config, store, dataDir, log: quiet, alerter }).runAll(); // "redeployed"
  assert.deepEqual(events, ['failed']);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
