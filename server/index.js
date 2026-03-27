// ═══════════════════════════════════════════════════════════════
//  ZYNTH Server  —  sync + scheduled Telegram messages
// ═══════════════════════════════════════════════════════════════
'use strict';

const express   = require('express');
const Database  = require('better-sqlite3');
const cron      = require('node-cron');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');

// ── Config ────────────────────────────────────────────────────
const TG_TOKEN   = process.env.TG_TOKEN   || '';
const API_SECRET = process.env.API_SECRET || 'zynth-dev-secret';
const PORT       = process.env.PORT       || 3000;
const DB_DIR     = path.dirname(process.env.DB_PATH || './data/zynth.db');
const DB_PATH    = process.env.DB_PATH    || './data/zynth.db';

if (!TG_TOKEN) console.warn('[WARN] TG_TOKEN not set — Telegram messages disabled');

// ── Database ──────────────────────────────────────────────────
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id    TEXT PRIMARY KEY,
    trades     TEXT    NOT NULL DEFAULT '[]',
    expenses   TEXT    NOT NULL DEFAULT '[]',
    settings   TEXT    NOT NULL DEFAULT '{}',
    last_sync  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// Prepared statements
const upsertUser = db.prepare(`
  INSERT INTO users (chat_id, trades, expenses, settings, last_sync)
  VALUES (@chatId, @trades, @expenses, @settings, @now)
  ON CONFLICT(chat_id) DO UPDATE SET
    trades    = excluded.trades,
    expenses  = excluded.expenses,
    settings  = excluded.settings,
    last_sync = excluded.last_sync
`);

const getUser    = db.prepare('SELECT * FROM users WHERE chat_id = ?');
const getAllUsers = db.prepare('SELECT * FROM users');

// ── Express ───────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '20mb' }));

// Auth middleware — every request must carry the shared secret
function auth(req, res, next) {
  if (req.headers['x-zynth-key'] !== API_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ── POST /sync ────────────────────────────────────────────────
// App calls this every time data changes
app.post('/sync', auth, (req, res) => {
  const { chatId, trades, expenses, settings } = req.body;
  if (!chatId) return res.status(400).json({ ok: false, error: 'chatId required' });

  try {
    upsertUser.run({
      chatId,
      trades:   JSON.stringify(trades   || []),
      expenses: JSON.stringify(expenses || []),
      settings: JSON.stringify(settings || {}),
      now:      Date.now(),
    });
    res.json({ ok: true, synced: Date.now() });
  } catch (e) {
    console.error('[sync]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /data/:chatId ─────────────────────────────────────────
// App calls this on first launch to restore data
app.get('/data/:chatId', auth, (req, res) => {
  const row = getUser.get(req.params.chatId);
  if (!row) return res.status(404).json({ ok: false, error: 'No data found for this Chat ID' });

  res.json({
    ok:       true,
    trades:   JSON.parse(row.trades),
    expenses: JSON.parse(row.expenses),
    settings: JSON.parse(row.settings),
    lastSync: row.last_sync,
    since:    new Date(row.created_at * 1000).toISOString().slice(0, 10),
  });
});

// ── GET /health ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  res.json({ ok: true, users: count, time: new Date().toISOString() });
});

// ── POST /webhook — Telegram bot webhook ──────────────────────
app.post('/webhook', (req, res) => {
  res.sendStatus(200); // always ack immediately
  const msg = req.body && req.body.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const text   = (msg.text || '').trim();
  if (text === '/start' || text.startsWith('/start ')) {
    tgSend(chatId,
      `👋 <b>Welcome to ZYNTH Journal!</b>\n\n` +
      `Your Chat ID is:\n<code>${chatId}</code>\n\n` +
      `Copy it and paste into <b>Settings → Telegram Chat ID</b> in the ZYNTH app.`
    );
  }
});

// ── Telegram ──────────────────────────────────────────────────
function tgSend(chatId, text) {
  if (!TG_TOKEN) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TG_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', e => { console.error('[tg]', e.message); resolve({ ok: false }); });
    req.write(body);
    req.end();
  });
}

// ── Message builders ──────────────────────────────────────────
function mentalState(trades) {
  const scores  = { Calm:2, Confident:2, Bored:0, Anxious:-1, FOMO:-2, Revenge:-3 };
  const planW   = { 'Yes, Fully':1, Partially:0, No:-1 };
  const last20  = [...trades].sort((a,b)=>a.date.localeCompare(b.date)).slice(-20);
  let eS=0,eN=0,pS=0,pN=0;
  last20.forEach(t => {
    if (scores[t.emotion]  !== undefined) { eS += scores[t.emotion];  eN++; }
    if (planW[t.followed_plan] !== undefined) { pS += planW[t.followed_plan]; pN++; }
  });
  const ms = (eN && pN) ? (eS/eN*0.6 + pS/pN*0.4)*2 : eN ? eS/eN : 0;
  return ms > 1 ? 'OPTIMAL' : ms > 0 ? 'GOOD' : ms > -0.5 ? 'WARNING' : 'CRITICAL';
}

function buildDailyBriefing(trades) {
  const sorted  = [...trades].sort((a,b) => a.date.localeCompare(b.date));
  const nyNow   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const today   = nyNow.toISOString().slice(0, 10);
  const wd      = nyNow.getDay();
  const wsDate  = new Date(nyNow); wsDate.setDate(nyNow.getDate() - (wd === 0 ? 6 : wd - 1));
  const weekStr = wsDate.toISOString().slice(0, 10);

  const weekTrades = sorted.filter(t => t.date >= weekStr && t.date < today);
  const wWins  = weekTrades.filter(t => t.result === 'Win').length;
  const wPnl   = weekTrades.reduce((s,t) => s + (t.pnl||0), 0);
  const state  = mentalState(trades);
  const day    = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][nyNow.getDay()];

  let msg = `📊 <b>ZYNTH Daily Briefing</b> — ${day} ${today}\n\n`;
  msg += `🧠 Mental State: <b>${state}</b>\n`;
  if (weekTrades.length) {
    msg += `📅 This week: ${wWins}W/${weekTrades.length - wWins}L  ·  ${wPnl >= 0 ? '+' : ''}$${wPnl.toFixed(0)}\n`;
  }
  const last = sorted[sorted.length - 1];
  if (last) msg += `\nLast trade: ${last.instrument} ${last.result}  ${last.pnl >= 0 ? '+' : ''}$${last.pnl}  (${last.date})\n`;

  if (state === 'CRITICAL' || state === 'WARNING') {
    msg += `\n⚠️ <b>Consider skipping today.</b> Your mental score is below safe threshold.`;
  } else {
    msg += `\n✅ Trade your plan. Stay disciplined.`;
  }
  return msg;
}

function buildWeeklyReport(trades) {
  const nyNow   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const wd      = nyNow.getDay();
  const wsDate  = new Date(nyNow); wsDate.setDate(nyNow.getDate() - (wd === 0 ? 6 : wd - 1));
  const weekStr = wsDate.toISOString().slice(0, 10);
  const sorted  = [...trades].sort((a,b) => a.date.localeCompare(b.date));
  const wk      = sorted.filter(t => t.date >= weekStr);

  if (!wk.length) return null;

  const wins  = wk.filter(t => t.result === 'Win').length;
  const wr    = Math.round(wins / wk.length * 100);
  const pnl   = wk.reduce((s,t) => s + (t.pnl||0), 0);
  const rrArr = wk.filter(t => t.rr).map(t => parseFloat(t.rr));
  const avgRR = rrArr.length ? (rrArr.reduce((a,b) => a+b, 0) / rrArr.length).toFixed(2) : '—';

  const byDay = {};
  wk.forEach(t => { byDay[t.date] = (byDay[t.date]||0) + (t.pnl||0); });
  const days  = Object.entries(byDay);
  const best  = days.reduce((a,b) => b[1] > a[1] ? b : a, days[0]);
  const worst = days.reduce((a,b) => b[1] < a[1] ? b : a, days[0]);

  let msg = `📈 <b>ZYNTH Weekly Report</b> — week of ${weekStr}\n\n`;
  msg += `Trades: ${wk.length}  ·  ${wins}W / ${wk.length - wins}L\n`;
  msg += `Win Rate: ${wr}%\n`;
  msg += `Net P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}\n`;
  msg += `Avg R:R: ${avgRR}R\n`;
  if (days.length > 1) {
    msg += `\nBest day:  ${best[0]}  +$${best[1].toFixed(0)}\n`;
    msg += `Worst day: ${worst[0]}  $${worst[1].toFixed(0)}\n`;
  }
  msg += `\n${pnl >= 0 ? '✅ Profitable week. Keep the discipline.' : '⚠️ Losing week. Review your setups before Monday.'}`;
  return msg;
}

function buildDangerAlert(trades) {
  const sorted = [...trades].sort((a,b) => a.date.localeCompare(b.date));
  const state  = mentalState(trades);

  // Losing streak
  let streak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].result === 'Loss') streak++;
    else break;
  }

  // This week win rate
  const nyNow   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const wd      = nyNow.getDay();
  const wsDate  = new Date(nyNow); wsDate.setDate(nyNow.getDate() - (wd === 0 ? 6 : wd - 1));
  const weekStr = wsDate.toISOString().slice(0, 10);
  const today   = nyNow.toISOString().slice(0, 10);
  const wk      = sorted.filter(t => t.date >= weekStr && t.date < today);
  const wWR     = wk.length ? Math.round(wk.filter(t => t.result==='Win').length / wk.length * 100) : null;

  let msg = `⚠️ <b>DANGEROUS TO TRADE TODAY</b>\n\nMental State: <b>${state}</b>\n`;
  if (streak >= 2) msg += `\n🔴 ${streak}-trade losing streak`;
  if (wWR !== null && wWR <= 35) msg += `\n📉 Only ${wWR}% win rate this week`;
  msg += `\n\nOpen ZYNTH for the full breakdown. Stay safe.`;
  return msg;
}

// ── Scheduled jobs ────────────────────────────────────────────
async function broadcastToAll(buildFn, settingKey) {
  const users = getAllUsers.all();
  let sent = 0;
  for (const user of users) {
    try {
      const settings = JSON.parse(user.settings);
      if (!settings[settingKey]) continue;
      const trades = JSON.parse(user.trades);
      if (!trades.length) continue;
      const msg = buildFn(trades);
      if (msg) { await tgSend(user.chat_id, msg); sent++; }
    } catch (e) {
      console.error(`[cron] Failed for ${user.chat_id}:`, e.message);
    }
  }
  console.log(`[cron] ${settingKey}: sent ${sent}/${users.length}`);
}

// Daily briefing — Mon–Fri 8:30 AM New York
cron.schedule('30 8 * * 1-5', () => {
  console.log('[cron] Daily briefings...');
  broadcastToAll(buildDailyBriefing, 'tgDailyBriefing');
}, { timezone: 'America/New_York' });

// Weekly report — Friday 5:00 PM New York
cron.schedule('0 17 * * 5', () => {
  console.log('[cron] Weekly reports...');
  broadcastToAll(buildWeeklyReport, 'tgWeeklyReport');
}, { timezone: 'America/New_York' });

// Danger check — Mon–Fri 8:00 AM New York (before market open)
cron.schedule('0 8 * * 1-5', async () => {
  console.log('[cron] Danger checks...');
  const users = getAllUsers.all();
  for (const user of users) {
    try {
      const settings = JSON.parse(user.settings);
      if (!settings.tgAlertDanger) continue;
      const trades = JSON.parse(user.trades);
      if (!trades.length) continue;

      const state = mentalState(trades);
      if (state === 'CRITICAL' || state === 'WARNING') {
        await tgSend(user.chat_id, buildDangerAlert(trades));
      }
    } catch (e) {
      console.error(`[danger] Failed for ${user.chat_id}:`, e.message);
    }
  }
}, { timezone: 'America/New_York' });

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  console.log(`\n🟢 ZYNTH server running on port ${PORT}`);
  console.log(`   Users in DB: ${userCount}`);
  console.log(`   Telegram:    ${TG_TOKEN ? 'configured' : 'NOT SET'}`);

  // Register webhook
  if (TG_TOKEN && process.env.RAILWAY_PUBLIC_DOMAIN) {
    const webhookUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook`;
    const body = JSON.stringify({ url: webhookUrl });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/setWebhook`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => console.log(`   Webhook:     ${d}\n`));
    });
    req.write(body);
    req.end();
  } else {
    console.log(`   Webhook:     skipped (RAILWAY_PUBLIC_DOMAIN not set)\n`);
  }
});
