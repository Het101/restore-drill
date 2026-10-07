// Restore Drill agent: runs every drill on a schedule, keeps a short history, and serves
//   GET /api/health   pass/fail per drill (point Uptime Kuma's JSON query at "ok")
//   GET /api/history  recent runs per drill, for the evidence page
//   GET /             the evidence page
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadConfig } = require('./config');
const { createStore } = require('./s3');
const { runDrill, publicView } = require('./drill');
const { createAlerter } = require('./alerts');
const { version } = require('./package.json');

const KEEP = 120; // runs per drill: 30 days at the default 6 h interval

function createAgent({ config, store, dataDir, log = console, alerter = createAlerter({ config: config.alerts, log }) }) {
  const file = path.join(dataDir, 'results.json');
  const alertFile = path.join(dataDir, 'alerts.json');
  let history = {};
  let alertState = {}; // per drill: the result we last alerted on, so a restart doesn't re-alert
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first start */ }
  try { alertState = JSON.parse(fs.readFileSync(alertFile, 'utf8')); } catch { /* first start */ }
  let running = false;
  let lastRun = null;

  async function runAll() {
    if (running) return;
    running = true;
    try {
      for (const drill of config.drills) {
        const r = await runDrill(drill, store);
        (history[drill.name] ||= []).push(r);
        history[drill.name] = history[drill.name].slice(-KEEP);
        const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
        if (r.ok) log.info(`[drill] ${r.name}: ok, restored ${r.backup.key} in ${r.restoreMs} ms`);
        else log.error(`[drill] ${r.name}: FAILED ${r.error || failed.join('; ')}`);
        alertState[drill.name] = await alerter.onResult(alertState[drill.name] || null, r);
      }
      lastRun = new Date().toISOString();
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(history));
      fs.writeFileSync(alertFile, JSON.stringify(alertState));
    } finally {
      running = false;
    }
  }

  function health() {
    const drills = config.drills.map((d) => {
      const runs = history[d.name] || [];
      return runs.length ? publicView(runs[runs.length - 1]) : { name: d.name, ok: null, pending: true };
    });
    const ok = drills.every((d) => d.ok === true);
    return { ok, version, checkedAt: lastRun, every: config.every / 36e5 + ' h', everyMs: config.every, alerts: alerter.channels.length > 0, drills };
  }

  function recent() {
    return Object.fromEntries(config.drills.map((d) => [d.name, (history[d.name] || []).slice(-60).map((r) => ({ at: r.at, ok: r.ok, restoreMs: r.restoreMs ?? null, bytes: r.backup?.bytes ?? null }))]));
  }

  return { runAll, health, recent };
}

function createServer(agent, publicDir = path.join(__dirname, 'public')) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // The API is public and read-only, so other pages (hetops.dev shows it live) may read it.
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { ...(url.pathname.startsWith('/api/') ? { 'access-control-allow-origin': '*' } : {}), 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'" });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'method not allowed' });
    if (url.pathname === '/api/health') return send(200, agent.health());
    if (url.pathname === '/api/history') return send(200, agent.recent());
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const target = path.join(publicDir, path.normalize(rel));
    if (!target.startsWith(publicDir + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return send(404, { error: 'not found' });
    return send(200, fs.readFileSync(target), types[path.extname(target)] || 'application/octet-stream');
  });
}

if (require.main === module) {
  const config = loadConfig(process.env.DRILL_CONFIG || path.join(__dirname, 'drills.yml'));
  const agent = createAgent({ config, store: createStore(config.storage), dataDir: process.env.DATA_DIR || path.join(__dirname, 'data') });
  const channels = createAlerter({ config: config.alerts }).channels;
  console.log(`[drill] alerts: ${channels.join(' + ') || 'off (set ALERT_WEBHOOK_URL, or ALERT_EMAIL_TO with SMTP_HOST)'}`);
  const port = Number(process.env.PORT) || 3000;
  createServer(agent).listen(port, () => console.log(`[drill] restore-drill ${version} on :${port}, ${config.drills.length} drills every ${config.every / 36e5} h`));
  // First run shortly after start, then on the interval.
  setTimeout(() => { agent.runAll(); setInterval(agent.runAll, config.every).unref(); }, 15_000).unref();
}

module.exports = { createAgent, createServer };
