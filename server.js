require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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

const USAGE_FILE = path.join(__dirname, 'usage.json');
const KEYS_FILE = path.join(__dirname, 'keys.json');
const REGISTER_FILE = path.join(__dirname, 'register.json');
const ANON_KEYS_FILE = path.join(__dirname, 'anon_keys.json');

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
    globalUsage = { date: today, tokens: 0 };
    keyUsageMap.clear();
    registerLog.clear();
    anonKeyMap.clear();
  }
}

function addUsage(tokens, key) {
  resetIfNewDay();
  globalUsage.tokens += tokens;
  keyUsageMap.set(key, (keyUsageMap.get(key) || 0) + tokens);
}

function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const raw = fs.readFileSync(USAGE_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.date === getToday()) {
        globalUsage = { date: data.date, tokens: data.global || 0 };
        if (data.keys) {
          for (const [k, v] of Object.entries(data.keys)) {
            keyUsageMap.set(k, v);
          }
        }
        console.log(`Loaded usage: ${globalUsage.tokens.toLocaleString()} tokens today`);
      } else {
        console.log('Usage file is stale, starting fresh');
      }
    }
  } catch (e) {
    console.error('Failed to load usage.json:', e.message);
  }
}

function saveUsage() {
  try {
    resetIfNewDay();
    const keys = Object.fromEntries(keyUsageMap);
    const data = { date: globalUsage.date, global: globalUsage.tokens, keys };
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save usage.json:', e.message);
  }
}

function loadKeys() {
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const data = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
      const keys = data.keys || [];
      for (const k of keys) validKeys.add(k);
    }
  } catch (e) {
    console.error('Failed to load keys.json:', e.message);
  }
}

function saveKeys() {
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys: [...validKeys] }, null, 2));
  } catch (e) {
    console.error('Failed to save keys.json:', e.message);
  }
}

function loadRegisterLog() {
  try {
    if (fs.existsSync(REGISTER_FILE)) {
      const data = JSON.parse(fs.readFileSync(REGISTER_FILE, 'utf-8'));
      if (data.date === getToday() && data.ips) {
        for (const [ip, log] of Object.entries(data.ips)) {
          registerLog.set(ip, log);
        }
        console.log(`Loaded register log: ${registerLog.size} IPs`);
      } else {
        console.log('Register log is stale, starting fresh');
      }
    }
  } catch (e) {
    console.error('Failed to load register.json:', e.message);
  }
}

function saveRegisterLog() {
  try {
    resetIfNewDay();
    const ips = Object.fromEntries(registerLog);
    fs.writeFileSync(REGISTER_FILE, JSON.stringify({ date: globalUsage.date, ips }, null, 2));
  } catch (e) {
    console.error('Failed to save register.json:', e.message);
  }
}

function loadAnonKeys() {
  try {
    if (fs.existsSync(ANON_KEYS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ANON_KEYS_FILE, 'utf-8'));
      if (data.date === getToday() && data.mappings) {
        for (const [ident, key] of Object.entries(data.mappings)) {
          anonKeyMap.set(ident, key);
          validKeys.add(key);
        }
        console.log(`Loaded anon keys: ${anonKeyMap.size} mappings`);
      } else {
        console.log('Anon keys file is stale, starting fresh');
      }
    }
  } catch (e) {
    console.error('Failed to load anon_keys.json:', e.message);
  }
}

function saveAnonKeys() {
  try {
    resetIfNewDay();
    const mappings = Object.fromEntries(anonKeyMap);
    fs.writeFileSync(ANON_KEYS_FILE, JSON.stringify({ date: globalUsage.date, mappings }, null, 2));
  } catch (e) {
    console.error('Failed to save anon_keys.json:', e.message);
  }
}

function generateKey() {
  return 'pk-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const saveInterval = setInterval(() => {
  saveUsage();
  saveKeys();
  saveRegisterLog();
  saveAnonKeys();
}, 300_000);

function gracefulExit() {
  clearInterval(saveInterval);
  saveUsage();
  saveKeys();
  saveRegisterLog();
  saveAnonKeys();
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
  saveKeys();
  saveAnonKeys();

  if (!log || log.date !== getToday()) {
    registerLog.set(ip, { date: getToday(), count: 1 });
  } else {
    log.count++;
  }
  saveRegisterLog();

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
  saveKeys();

  if (!log || log.date !== today) {
    registerLog.set(ip, { date: today, count: 1 });
  } else {
    log.count++;
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
  console.log(`Preset keys: ${PRESET_KEYS.length}, Registered keys: ${validKeys.size - PRESET_KEYS.length}, Anonymous mappings: ${anonKeyMap.size}`);
});
