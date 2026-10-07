// Alerts on state changes, not on every run: one message when a drill starts failing, one when
// it recovers, and a reminder while it stays broken. Channels: a webhook (Slack, Discord or any
// URL that takes JSON) and email over SMTP.
//   drills.yml  alerts: { webhook, email_to, remind, url }
//   env         SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, MAIL_FROM
const { duration } = require('./drill');

// What, if anything, to say about this run given the last one we alerted on.
function decide(prev, r, now, remindMs) {
  if (!prev) return r.ok ? null : 'failed';
  if (prev.ok && !r.ok) return 'failed';
  if (!prev.ok && r.ok) return 'recovered';
  if (!r.ok && remindMs > 0 && now - (prev.alertedAt || 0) >= remindMs) return 'still failing';
  return null;
}

const reasons = (r) => [...(r.error ? [r.error] : []), ...r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)];

function message(event, r, url) {
  const failed = event !== 'recovered';
  const title = failed
    ? `${r.name}: backup ${event === 'still failing' ? 'still does not' : 'did not'} restore`
    : `${r.name}: backup restores again`;
  const lines = failed ? reasons(r) : [`All ${r.checks.length} checks pass. Restored in ${r.restoreMs ?? '?'} ms.`];
  const backup = r.backup ? `${r.backup.key} (${r.backup.age} old)` : 'no backup found';
  return { event, title, lines, backup, url, drill: r.name, ok: r.ok, at: r.at };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Slack and Discord each want their own shape; anything else gets the plain event.
function webhookBody(url, m) {
  const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
  const text = `${m.ok ? 'RECOVERED' : 'FAILED'} · *${m.title}*\n${m.lines.map((l) => `• ${l}`).join('\n')}\nBackup: ${m.backup}${m.url ? `\n${m.url}` : ''}`;
  if (host === 'hooks.slack.com') return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
  if (/(^|\.)discord(app)?\.com$/.test(host)) return { content: text.replace(/\*/g, '**') };
  return { event: m.event, drill: m.drill, ok: m.ok, at: m.at, title: m.title, reasons: m.lines, backup: m.backup, url: m.url };
}

function emailHtml(m) {
  const ink = m.ok ? '#2f7a3e' : '#b42a20';
  return `<!doctype html><html><body style="margin:0;background:#f2f3f1;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#16171a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fbfbfa;border:1px solid #d9dad6;border-radius:6px">
<tr><td style="padding:28px 32px 8px;font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:${ink}">Restore Drill · ${esc(m.event)}</td></tr>
<tr><td style="padding:6px 32px 14px;font-size:22px;font-weight:700;letter-spacing:-.02em">${esc(m.title)}</td></tr>
<tr><td style="padding:0 32px 18px;font-size:14px;line-height:1.6">${m.lines.map((l) => `<div style="padding:6px 0;border-top:1px solid #e6e7e3">${esc(l)}</div>`).join('')}</td></tr>
<tr><td style="padding:0 32px 26px;font:12px/1.5 ui-monospace,Menlo,monospace;color:#5d5f63">Backup: ${esc(m.backup)}<br>Drilled: ${esc(m.at)}</td></tr>
${m.url ? `<tr><td style="padding:0 32px 30px"><a href="${esc(m.url)}" style="display:inline-block;background:#16171a;color:#fbfbfa;text-decoration:none;padding:10px 16px;border-radius:4px;font-size:14px;font-weight:600">Open the evidence page</a></td></tr>` : ''}
</table></td></tr></table></body></html>`;
}

function createAlerter({ config = {}, env = process.env, fetchImpl = fetch, log = console, transport } = {}) {
  const webhook = config.webhook || '';
  const emailTo = config.email_to || '';
  const remindMs = config.remind ? duration(config.remind) : 24 * 36e5;
  let mailer = transport || null;
  if (!mailer && emailTo && env.SMTP_HOST) {
    const nodemailer = require('nodemailer');
    mailer = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT) || 587,
      secure: String(env.SMTP_SECURE || 'false') === 'true',
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  const from = env.MAIL_FROM || 'Restore Drill <no-reply@hetops.dev>';
  const channels = [...(webhook ? ['webhook'] : []), ...(emailTo && mailer ? ['email'] : [])];

  async function send(m) {
    const sent = [];
    if (webhook) {
      try {
        const res = await fetchImpl(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(webhookBody(webhook, m)) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        sent.push('webhook');
      } catch (err) { log.error(`[alert] webhook failed: ${err.message}`); }
    }
    if (emailTo && mailer) {
      try {
        await mailer.sendMail({ from, to: emailTo, subject: `Restore Drill: ${m.title}`, text: `${m.title}\n\n${m.lines.join('\n')}\n\nBackup: ${m.backup}\n${m.url || ''}`, html: emailHtml(m) });
        sent.push('email');
      } catch (err) { log.error(`[alert] email failed: ${err.message}`); }
    }
    return sent;
  }

  // Returns the new alert state for this drill (persisted by the agent).
  async function onResult(prev, r, now = Date.now()) {
    const event = decide(prev, r, now, remindMs);
    if (!event || !channels.length) return { ok: r.ok, alertedAt: event ? now : prev?.alertedAt || 0 };
    const sent = await send(message(event, r, config.url));
    log.info(`[alert] ${r.name}: ${event} -> ${sent.join(', ') || 'nothing delivered'}`);
    // Nothing delivered: keep the old state so the next run tries again.
    return sent.length ? { ok: r.ok, alertedAt: now } : prev || null;
  }

  async function test() {
    const r = { name: 'Restore Drill test', ok: false, at: new Date().toISOString(), checks: [{ name: 'this is a test alert', ok: false, detail: 'no backup is broken' }], backup: null };
    return send({ ...message('failed', r, config.url), title: 'Test alert: delivery works' });
  }

  return { onResult, test, channels };
}

module.exports = { createAlerter, decide, message, webhookBody, emailHtml };
