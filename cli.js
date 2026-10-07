#!/usr/bin/env node
// restore-drill [--config drills.yml] [--json]
// Runs every drill once and exits 1 if any fails, so it also works from cron or CI.
const path = require('path');
const { loadConfig } = require('./config');
const { createStore } = require('./s3');
const { runDrill } = require('./drill');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const asJson = args.includes('--json');
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const pass = paint(32, '✓'), fail = paint(31, '✗');

(async () => {
  const config = loadConfig(path.resolve(flag('--config') || 'drills.yml'));
  const store = createStore(config.storage);
  const results = [];
  for (const drill of config.drills) {
    const r = await runDrill(drill, store);
    results.push(r);
    if (asJson) continue;
    console.log(`\n${r.ok ? pass : fail} ${paint(1, r.name)}`);
    if (r.backup) console.log(paint(2, `  ${r.backup.key} · ${(r.backup.bytes / 1024).toFixed(0)} KB · ${r.backup.age} old · restored in ${r.restoreMs ?? '–'} ms`));
    for (const c of r.checks) console.log(`  ${c.ok ? pass : fail} ${c.name} ${paint(2, `(${c.detail})`)}`);
    if (r.error) console.log(`  ${fail} ${r.error}`);
  }
  const ok = results.every((r) => r.ok);
  if (asJson) console.log(JSON.stringify({ ok, drills: results }, null, 2));
  else console.log(`\n${ok ? pass : fail} ${results.filter((r) => r.ok).length} of ${results.length} backups restored and verified\n`);
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(`restore-drill: ${err.message}`);
  process.exit(2);
});
