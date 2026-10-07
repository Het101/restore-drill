// drills.yml: where the backups live and what a good restore looks like.
// ${VAR} is replaced from the environment, so keys never sit in the file.
const fs = require('fs');
const YAML = require('yaml');
const { duration } = require('./drill');

function interpolate(value, env, missing) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name, fallback) => {
      if (env[name] !== undefined && env[name] !== '') return env[name];
      if (fallback !== undefined) return fallback;
      missing.add(name);
      return '';
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env, missing));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, missing)]));
  return value;
}

function loadConfig(file, env = process.env) {
  const missing = new Set();
  const cfg = interpolate(YAML.parse(fs.readFileSync(file, 'utf8')) || {}, env, missing);
  if (missing.size) throw new Error(`${file}: set ${[...missing].join(', ')} in the environment`);

  const s = cfg.storage || {};
  for (const k of ['endpoint', 'bucket', 'access_key_id', 'secret_access_key']) {
    if (!s[k]) throw new Error(`${file}: storage.${k} is required`);
  }
  if (!Array.isArray(cfg.drills) || !cfg.drills.length) throw new Error(`${file}: add at least one entry under drills`);
  const drills = cfg.drills.map((d, i) => {
    if (!d.name || !d.prefix) throw new Error(`${file}: drills[${i}] needs name and prefix`);
    const engine = d.engine || 'sqlite';
    if (!['sqlite', 'postgres'].includes(engine)) throw new Error(`${file}: drills[${i}] engine "${engine}" is not supported (sqlite or postgres)`);
    const out = { ...d, engine, max_age: d.max_age || '26h' };
    duration(out.max_age);
    for (const c of d.checks || []) if (c.max_age) duration(c.max_age);
    return out;
  });
  const a = cfg.alerts || {};
  if (a.remind) duration(a.remind);
  return {
    alerts: { webhook: a.webhook || '', email_to: a.email_to || '', remind: a.remind || '24h', url: a.url || '' },
    storage: { endpoint: s.endpoint, bucket: s.bucket, region: s.region || 'auto', accessKeyId: s.access_key_id, secretAccessKey: s.secret_access_key },
    every: duration(cfg.every || '6h'),
    drills,
  };
}

module.exports = { loadConfig, interpolate };
