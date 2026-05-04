require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const PORT = process.env.PORT || 3000;
const DAILY_QUOTA_PER_KEY = 1_000_000; // 100万 tokens per key per day

// Preset keys from env (optional backup/admin keys)
const PRESET_KEYS = (process.env.API_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

if (!DEEPSEEK_API_KEY) {
  console.error('Missing DEEPSEEK_API_KEY in .env');
  process.exit(1);
}

// ===== SQLite =====
const DB_FILE = path.join(__dirname, 'proxy.db');
const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    key TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS key_usage (
    key TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS register_log (
    ip TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS anon_keys (
    ident TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    date TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_global (
    date TEXT PRIMARY KEY,
    tokens INTEGER NOT NULL DEFAULT 0
  );
`);

const stmtInsertKey = db.prepare('INSERT OR IGNORE INTO keys (key, type, created_at) VALUES (?, ?, ?)');
const stmtInsertUsage = db.prepare('INSERT OR REPLACE INTO key_usage (key, date, tokens) VALUES (?, ?, ?)');
const stmtInsertGlobal = db.prepare('INSERT OR REPLACE INTO daily_global (date, tokens) VALUES (?, ?)');
const stmtInsertRegister = db.prepare('INSERT OR REPLACE INTO register_log (ip, date, count) VALUES (?, ?, ?)');
const stmtInsertAnon = db.prepare('INSERT OR REPLACE INTO anon_keys (ident, key, date) VALUES (?, ?, ?)');
const stmtDeleteOldUsage = db.prepare("DELETE FROM key_usage WHERE date != ?");
const stmtDeleteOldGlobal = db.prepare("DELETE FROM daily_global WHERE date != ?");
const stmtDeleteOldRegister = db.prepare("DELETE FROM register_log WHERE date != ?");
const stmtDeleteOldAnon = db.prepare("DELETE FROM anon_keys WHERE date != ?");
const stmtDeleteOldKeys = db.prepare("DELETE FROM keys WHERE type = 'anonymous' AND key NOT IN (SELECT key FROM anon_keys)");

// ===== In-memory cache =====
let globalUsage = { date: getToday(), tokens: 0 };
const keyUsageMap = new Map();
let validKeys = new Set(PRESET_KEYS);
const registerLog = new Map(); // ip -> { date, count }
const anonKeyMap = new Map(); // ident -> key

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function resetIfNewDay() {
  const today = getToday();
  if (globalUsage.date !== today) {
    const oldDate = globalUsage.date;
    globalUsage = { date: today, tokens: 0 };
    keyUsageMap.clear();
    registerLog.clear();
    anonKeyMap.clear();

    // Purge stale data from SQLite
    stmtDeleteOldUsage.run(today);
    stmtDeleteOldGlobal.run(today);
    stmtDeleteOldRegister.run(today);
    stmtDeleteOldAnon.run(today);
    stmtDeleteOldKeys.run();
  }
}

function addUsage(tokens, key) {
  resetIfNewDay();
  globalUsage.tokens += tokens;
  keyUsageMap.set(key, (keyUsageMap.get(key) || 0) + tokens);

  // Persist immediately
  stmtInsertUsage.run(key, globalUsage.date, keyUsageMap.get(key));
  stmtInsertGlobal.run(globalUsage.date, globalUsage.tokens);
}

function loadUsage() {
  const today = getToday();
  const row = db.prepare('SELECT tokens FROM daily_global WHERE date = ?').get(today);
  if (row) {
    globalUsage = { date: today, tokens: row.tokens };
  }

  const usageRows = db.prepare('SELECT key, tokens FROM key_usage WHERE date = ?').all(today);
  for (const r of usageRows) {
    keyUsageMap.set(r.key, r.tokens);
  }
  console.log(`Loaded usage: ${globalUsage.tokens.toLocaleString()} tokens today`);
}

function loadKeys() {
  // Seed preset keys into DB on first run
  const today = getToday();
  for (const k of PRESET_KEYS) {
    stmtInsertKey.run(k, 'preset', today);
    validKeys.add(k);
  }

  const rows = db.prepare("SELECT key FROM keys").all();
  for (const r of rows) validKeys.add(r.key);
}

function loadRegisterLog() {
  const rows = db.prepare('SELECT ip, date, count FROM register_log').all();
  for (const r of rows) registerLog.set(r.ip, { date: r.date, count: r.count });
  console.log(`Loaded register log: ${registerLog.size} IPs`);
}

function loadAnonKeys() {
  const today = getToday();
  const rows = db.prepare('SELECT ident, key, date FROM anon_keys').all();
  for (const r of rows) {
    if (r.date === today) {
      anonKeyMap.set(r.ident, r.key);
      validKeys.add(r.key);
    }
  }
  console.log(`Loaded anon keys: ${anonKeyMap.size} mappings`);
}

function generateKey() {
  return 'pk-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function persistKey(key, type) {
  stmtInsertKey.run(key, type, getToday());
}

function persistRegisterLog(ip, date, count) {
  stmtInsertRegister.run(ip, date, count);
}

function persistAnonKey(ident, key, date) {
  stmtInsertAnon.run(ident, key, date);
}

function gracefulExit() {
  db.close();
  process.exit(0);
}

process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// User-Agent guard — reject requests not from Papyrus Desktop
function userAgentGuard(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  if (!ua.includes('PapyrusDesktop')) {
    res.status(403).json({
      error: {
        message: 'Access denied: unsupported client',
        type: 'access_denied',
      },
    });
    return;
  }
  next();
}

// Apply UA guard to all /v1/* API routes
app.use('/v1', userAgentGuard);

function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) return String(cfIp).trim();

  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = String(forwarded).split(',')[0].trim();
    if (first) return first;
  }

  return req.ip || req.socket.remoteAddress || 'unknown';
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  if (validKeys.has(token)) {
    req.apiKey = token;
    next();
    return;
  }

  resetIfNewDay();

  const clientId = req.headers['x-papyrus-client-id'] || '';
  const ip = getClientIp(req);
  const anonIdent = clientId ? `device:${clientId}` : `ip:${ip}`;

  const existingKey = anonKeyMap.get(anonIdent);
  if (existingKey && validKeys.has(existingKey)) {
    req.apiKey = existingKey;
    next();
    return;
  }

  const log = registerLog.get(ip);
  if (log && log.date === getToday() && log.count >= 3) {
    res.status(429).json({
      error: {
        message: '该IP今日注册次数已达上限（3次）',
        type: 'rate_limit_error',
      },
    });
    return;
  }

  const newKey = generateKey();
  validKeys.add(newKey);
  anonKeyMap.set(anonIdent, newKey);
  persistKey(newKey, 'anonymous');
  persistAnonKey(anonIdent, newKey, getToday());

  if (!log || log.date !== getToday()) {
    registerLog.set(ip, { date: getToday(), count: 1 });
    persistRegisterLog(ip, getToday(), 1);
  } else {
    log.count++;
    persistRegisterLog(ip, log.date, log.count);
  }

  req.apiKey = newKey;
  next();
}

// POST /v1/register — auto-issue an API key (no auth required)
app.post('/v1/register', (req, res) => {
  const ip = getClientIp(req);
  const today = getToday();

  resetIfNewDay();

  const log = registerLog.get(ip);
  if (log && log.date === today && log.count >= 3) {
    res.status(429).json({
      error: {
        message: '该IP今日注册次数已达上限（3次）',
        type: 'rate_limit_error',
      },
    });
    return;
  }

  const key = generateKey();
  validKeys.add(key);
  persistKey(key, 'registered');

  if (!log || log.date !== today) {
    registerLog.set(ip, { date: today, count: 1 });
    persistRegisterLog(ip, today, 1);
  } else {
    log.count++;
    persistRegisterLog(ip, log.date, log.count);
  }

  res.json({
    api_key: key,
    message: '请保存此 key，后续请求需在 Authorization 头中以 Bearer <key> 携带',
  });
});

// GET /v1/models — connection test endpoint
app.get('/v1/models', authMiddleware, async (_req, res) => {
  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/models`, {
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: `DeepSeek unreachable: ${e.message}` });
  }
});

// POST /v1/chat/completions — stream proxy with global quota
app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
  resetIfNewDay();

  const used = keyUsageMap.get(req.apiKey) || 0;
  if (used >= DAILY_QUOTA_PER_KEY) {
    res.status(429).json({
      error: {
        message: `今日额度已用完 (${DAILY_QUOTA_PER_KEY.toLocaleString()} tokens/天)。请明天再试。`,
        type: 'quota_exceeded',
        quota: DAILY_QUOTA_PER_KEY,
        used,
      },
    });
    return;
  }

  const isStream = req.body.stream === true;

  const body = { ...req.body };
  if (isStream) {
    body.stream_options = { ...body.stream_options, include_usage: true };
  }

  try {
    const upstreamResp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!upstreamResp.ok) {
      const errText = await upstreamResp.text().catch(() => '');
      res.status(upstreamResp.status).send(errText);
      return;
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let totalTokens = 0;
      const reader = upstreamResp.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);

          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const json = JSON.parse(line.slice(6));
                if (json.usage?.total_tokens) {
                  totalTokens = json.usage.total_tokens;
                }
              } catch {}
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      addUsage(totalTokens, req.apiKey);
      res.end();
    } else {
      const data = await upstreamResp.json();
      const tokens = data.usage?.total_tokens || 0;
      addUsage(tokens, req.apiKey);
      res.json(data);
    }
  } catch (e) {
    res.status(502).json({ error: `DeepSeek unreachable: ${e.message}` });
  }
});

// GET /v1/usage — check current key usage
app.get('/v1/usage', authMiddleware, (req, res) => {
  resetIfNewDay();
  const used = keyUsageMap.get(req.apiKey) || 0;
  res.json({
    date: globalUsage.date,
    tokens_used: used,
    daily_quota: DAILY_QUOTA_PER_KEY,
    remaining: Math.max(0, DAILY_QUOTA_PER_KEY - used),
  });
});

// Serve static landing page for all other routes
app.use(express.static(path.join(__dirname), { index: 'index.html' }));

loadUsage();
loadKeys();
loadRegisterLog();
loadAnonKeys();
app.listen(PORT, () => {
  console.log(`Papyrus LiYuan DeepSeek Proxy running on port ${PORT}`);
  console.log(`Daily quota: ${DAILY_QUOTA_PER_KEY.toLocaleString()} tokens per key`);
  console.log(`Preset keys: ${PRESET_KEYS.length}, Total keys: ${validKeys.size}, Anonymous mappings: ${anonKeyMap.size}`);
});
