/* =====================================================================
   MemeForge — server.js   (zero dependencies · needs Node 22.5 or newer)

   What this server does
   ---------------------------------------------------------------------
   1. Stores fees + settings in an SQL database (SQLite file: data/memeforge.db)
   2. Serves the public pages from /public
   3. Serves /fees-config.js DYNAMICALLY from the database, so the existing
      pages and payment.js keep working with no changes: whatever you save in
      the admin dashboard is what visitors get.
   4. Counts daily unique visitors (random cookie id, no IP stored)
   5. Records every created token + the revenue your fee wallet received.
      The server checks the transaction ON-CHAIN, so numbers can't be faked
      by just posting a made-up signature.
   6. Admin dashboard (/admin): login, logout, edit fees/network/wallet,
      change password, daily report + CSV export.
   7. Admin logo upload (stored in the database, served publicly at /logo).
   8. Built-in database manager (the "phpMyAdmin" of this project): size
      monitor with a limit, browse tables, delete old/selected rows, shrink
      the file, download a backup. See the DATABASE MANAGER section below.

   Run:   node server.js      then open  http://localhost:3000
   Admin: http://localhost:3000/admin     (first-run password: 12345 — change it!)
   ===================================================================== */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';   // set to 1 when behind nginx/Cloudflare
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'memeforge.db');

const LAMPORTS = 1_000_000_000;
const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/* =====================================================================
   DATABASE
   ===================================================================== */
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
  -- simple key/value settings (network, rpc, fee wallet, timezone, admin password hash)
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- every price the admin can change. key 'creation' = base fee, the rest = premium features
  CREATE TABLE IF NOT EXISTS fees (
    key    TEXT PRIMARY KEY,
    label  TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0)      -- in SOL
  );

  -- one row per (day, visitor): the primary key is what makes visitors "unique per day"
  CREATE TABLE IF NOT EXISTS visits (
    day     TEXT NOT NULL,                         -- YYYY-MM-DD in the configured timezone
    visitor TEXT NOT NULL,                         -- random cookie id, not an IP address
    PRIMARY KEY (day, visitor)
  );

  -- every token created through the site (verified on-chain before it is stored)
  CREATE TABLE IF NOT EXISTS tokens (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    signature        TEXT NOT NULL UNIQUE,         -- UNIQUE = a transaction can never be counted twice
    mint             TEXT NOT NULL,
    creator          TEXT NOT NULL,
    network          TEXT NOT NULL,
    day              TEXT NOT NULL,
    revenue_lamports INTEGER NOT NULL,             -- what the fee wallet actually received
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tokens_day ON tokens(day);

  -- the daily revenue report, kept per network so test (devnet) SOL never mixes with real SOL
  CREATE TABLE IF NOT EXISTS daily_stats (
    day              TEXT NOT NULL,
    network          TEXT NOT NULL,
    tokens           INTEGER NOT NULL DEFAULT 0,
    revenue_lamports INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, network)
  );

  -- uploaded files (the admin logo). Kept in the database so ONE file holds everything.
  CREATE TABLE IF NOT EXISTS assets (
    key        TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- visitor totals of days whose raw 'visits' rows were purged. This is what keeps the
  -- report's history intact after you free up space (see purgeVisits / DATABASE MANAGER).
  CREATE TABLE IF NOT EXISTS daily_visitors (
    day      TEXT PRIMARY KEY,
    visitors INTEGER NOT NULL
  );
`);

/* ---------- upgrades for databases created by older versions (safe to run every start) ---------- */
function addColumn(table, column, ddl) {
  if (!db.prepare(`PRAGMA table_info("${table}")`).all().some(c => c.name === column))
    db.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} ${ddl}`);
}
// What each token cost the creator, split into "sent to MemeForge" and "paid to Solana".
addColumn('tokens', 'paid_lamports', 'INTEGER NOT NULL DEFAULT 0');      // total the creator's wallet lost in this transaction
addColumn('tokens', 'network_lamports', 'INTEGER NOT NULL DEFAULT 0');   // paid - revenue = rent deposits + network fee (stays with Solana)
addColumn('tokens', 'token_name', "TEXT NOT NULL DEFAULT ''");           // read from the on-chain metadata instruction
addColumn('tokens', 'token_symbol', "TEXT NOT NULL DEFAULT ''");
addColumn('tokens', 'wallet_name', "TEXT NOT NULL DEFAULT ''");          // which wallet app signed (reported by the browser)
addColumn('tokens', 'features', "TEXT NOT NULL DEFAULT ''");             // premium features ticked (reported by the browser)
addColumn('daily_stats', 'spent_lamports', 'INTEGER NOT NULL DEFAULT 0');
addColumn('daily_stats', 'network_lamports', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
  -- every wallet address that connected on the token creator page (self-reported by the browser)
  CREATE TABLE IF NOT EXISTS wallets (
    address    TEXT PRIMARY KEY,
    wallet     TEXT NOT NULL DEFAULT '',            -- wallet app used (Phantom, Solflare, ...)
    first_day  TEXT NOT NULL,                       -- YYYY-MM-DD in the configured timezone
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
    connects   INTEGER NOT NULL DEFAULT 1
  );

  -- the wallets offered in the "Connect a wallet" popup of the token creator (managed in admin → Wallets)
  CREATE TABLE IF NOT EXISTS wallet_options (
    id          TEXT PRIMARY KEY,                   -- slug, e.g. "phantom"
    name        TEXT NOT NULL,
    logo_url    TEXT NOT NULL DEFAULT '',           -- optional https image link
    provider    TEXT NOT NULL DEFAULT '',           -- where the wallet injects itself, e.g. "phantom.solana"
    flag        TEXT NOT NULL DEFAULT '',           -- optional property that must be true, e.g. "isPhantom"
    install_url TEXT NOT NULL DEFAULT '',
    deeplink    TEXT NOT NULL DEFAULT '',           -- mobile link template containing {url} (and optionally {ref})
    color       TEXT NOT NULL DEFAULT '',           -- #rrggbb badge color used when there is no logo
    sort        INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1
  );
`);

// (table is created just above)
addColumn('wallet_options', 'popular', 'INTEGER NOT NULL DEFAULT 0');      // admin-editable "Popular" badge (shown first in the popup)

// First-run defaults (INSERT OR IGNORE = never overwrites what the admin saved later).
const seedSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
const seedFee = db.prepare('INSERT OR IGNORE INTO fees(key, label, amount) VALUES (?, ?, ?)');
[
  ['network', 'mainnet-beta'],                      // "mainnet-beta" or "devnet"
  ['rpc_url', ''],                                  // empty = free public RPC for the network
  ['fee_wallet', 'JLqXStBQFBRQnKfnGrGDFuBX8uKDJeZCGhLUqqttg3m'],
  ['timezone', 'Asia/Manila'],                      // decides when a "day" starts and ends
  ['db_limit_mb', '100'],                           // the admin's database size limit (warns at 80%)
].forEach(([k, v]) => seedSetting.run(k, v));
[
  ['creation',     'Token creation (base fee)',        0.1],
  ['banner',       'Token banner',                     0.1],
  ['social',       'Social links',                     0.1],
  ['creator',      'Creator info',                     0.1],
  ['mintRevoke',   'Revoke mint authority',            0.1],
  ['freezeRevoke', 'Revoke freeze authority',          0.1],
  ['metaRevoke',   'Revoke metadata update authority', 0.1],
].forEach(([k, l, a]) => seedFee.run(k, l, a));

const getSetting = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? '';
const setSetting = (k, v) => db.prepare(
  'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
const getFees = () => Object.fromEntries(db.prepare('SELECT key, amount FROM fees').all().map(r => [r.key, r.amount]));

// RPC endpoint and revenue wallet are kept PER NETWORK (keys rpc_url_mainnet / rpc_url_devnet / fee_wallet_mainnet / fee_wallet_devnet).
// Databases from older versions had one shared rpc_url + fee_wallet: copy them over once (the old RPC stays with the network
// that was active, the old wallet goes to both). The old keys are left untouched.
const netKey = n => n === 'devnet' ? 'devnet' : 'mainnet';
for (const net of ['mainnet-beta', 'devnet']) {
  seedSetting.run('rpc_url_' + netKey(net), net === getSetting('network') ? getSetting('rpc_url') : '');
  seedSetting.run('fee_wallet_' + netKey(net), getSetting('fee_wallet'));
}
const walletFor = net => getSetting('fee_wallet_' + netKey(net));
const rpcFor = net => getSetting('rpc_url_' + netKey(net)) || defaultRpc(net);   // empty = free public RPC of that network

/* =====================================================================
   WALLET LIST (what the token creator's "Connect a wallet" popup offers)
   `provider` is the browser object the wallet extension / in-app browser injects.
   These are the commonly documented spots; if a wallet is installed but not shown
   as "Detected", just edit its Provider in admin → Wallets.
   ===================================================================== */
const { WALLET_PRESETS, TOP_COUNT, logoFor } = require('./wallet-presets.js');
const POPULAR_DEFAULT = new Set(['phantom', 'solflare']);   // the only wallets that start with the ★ Popular badge   // 130+ wallets (the full catalog shown in admin → Wallets)
// Offer the "top" wallets (the first TOP_COUNT presets). Runs ONCE per database: new installs get them at first start,
// and databases from older versions (which only had 3) get the missing ones added. After that the admin owns the list,
// so deleting one is never undone by a restart.
if (getSetting('wallets_seeded_v2') !== '1') {
  const ins = db.prepare(`INSERT OR IGNORE INTO wallet_options(id, name, logo_url, provider, flag, install_url, deeplink, color, sort, enabled, popular)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
  let next = Number(db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 m FROM wallet_options').get().m);
  for (const w of WALLET_PRESETS.slice(0, TOP_COUNT)) {
    if (db.prepare('SELECT 1 FROM wallet_options WHERE id = ? OR lower(name) = lower(?)').get(w.id, w.name)) continue;
    ins.run(w.id, w.name, w.logo, w.provider, w.flag, w.install_url, w.deeplink, w.color, next++, POPULAR_DEFAULT.has(w.id) ? 1 : 0);
  }
  setSetting('wallets_seeded', '1'); setSetting('wallets_seeded_v2', '1');
}
// Gives every wallet that has NO logo link its original logo (catalog wallets by id/name, others from their install link).
// Never touches a logo link the admin already set. Returns how many wallets were filled.
function fillWalletLogos() {
  const byId = new Map(WALLET_PRESETS.map(p => [p.id, p])), byName = new Map(WALLET_PRESETS.map(p => [p.name.toLowerCase(), p]));
  const up = db.prepare('UPDATE wallet_options SET logo_url = ? WHERE id = ?');
  let n = 0;
  for (const w of db.prepare("SELECT id, name, install_url FROM wallet_options WHERE logo_url = ''").all()) {
    const logo = (byId.get(w.id) || byName.get(String(w.name).toLowerCase()) || {}).logo || logoFor(w.install_url);
    if (logo) { up.run(logo, w.id); n++; }
  }
  return n;
}
// Once per database: existing wallets get their logos automatically. After that the admin owns the links.
if (getSetting('wallet_logos_v1') !== '1') { fillWalletLogos(); setSetting('wallet_logos_v1', '1'); }
// Once per database: the catalog's "Popular" wallets that are already on the list get the Popular badge. After that the admin owns it.
if (getSetting('wallet_popular_v1') !== '1') {
  const up = db.prepare('UPDATE wallet_options SET popular = 1 WHERE id = ? OR lower(name) = lower(?)');
  for (const w of WALLET_PRESETS) if (POPULAR_DEFAULT.has(w.id)) up.run(w.id, w.name);
  setSetting('wallet_popular_v1', '1');
}
// Once per database: only Phantom and Solflare keep the Popular badge. Every other wallet can still be marked Popular
// by the admin (admin → Wallets → the ★ button). After this one-time reset the admin owns the badges.
if (getSetting('wallet_popular_v2') !== '1') {
  db.exec("UPDATE wallet_options SET popular = CASE WHEN id IN ('phantom','solflare') THEN 1 ELSE 0 END");
  setSetting('wallet_popular_v2', '1');
}
const publicWallets = () => db.prepare('SELECT * FROM wallet_options WHERE enabled = 1 ORDER BY sort, rowid').all().map(w => ({
  id: w.id, name: w.name, logo: w.logo_url, provider: w.provider, flag: w.flag, install: w.install_url, deeplink: w.deeplink, color: w.color, popular: !!w.popular,
}));

/* =====================================================================
   PASSWORD (scrypt hash + salt; the plain password is never stored)
   ===================================================================== */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function checkPassword(pw, stored) {
  try {
    const [saltHex, hashHex] = stored.split(':');
    const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch { return false; }
}
// First run: the admin password is 12345 (flagged as "default" so the dashboard nags you to change it).
if (!getSetting('admin_pass_hash')) {
  setSetting('admin_pass_hash', hashPassword('12345'));
  setSetting('admin_pass_default', '1');
}

/* =====================================================================
   SMALL HELPERS
   ===================================================================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sol = l => (Number(l || 0) / LAMPORTS).toFixed(6);                     // lamports -> "0.123456" SOL text for CSV
const reportNet = url => ['mainnet-beta', 'devnet'].includes(url.searchParams.get('network')) ? url.searchParams.get('network') : getSetting('network');
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
// A real Solana address = base58 text that decodes to exactly 32 bytes (so 0x... Ethereum addresses, Bitcoin addresses etc. are refused).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58ByteLength(s) {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) return -1; n = n * 58n + BigInt(i); }
  let len = n === 0n ? 0 : n.toString(16).length; len = Math.ceil(len / 2);
  let zeros = 0; while (zeros < s.length && s[zeros] === '1') zeros++;
  return zeros + len;
}
const isAddress = s => typeof s === 'string' && s.length >= 32 && s.length <= 44 && BASE58.test(s) && b58ByteLength(s) === 32;
const isSignature = s => typeof s === 'string' && s.length >= 64 && s.length <= 90 && BASE58.test(s);
const validTz = tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

// Text that came from a browser or from the chain: drop control characters, trim, cap the length.
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max);

// One CSV cell. Quotes everything and defuses spreadsheet formulas (=, +, -, @) in text that users control, such as token names.
const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = cells => cells.map(csvCell).join(',');

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58_ALPHABET.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0; while (zeros < s.length && s[zeros] === '1') zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

// "Today" as YYYY-MM-DD in the admin's timezone (so a day matches YOUR calendar day).
function dayOf(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: getSetting('timezone') || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = req => !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
function setCookie(res, req, name, value, { maxAge, httpOnly = true, sameSite = 'Lax' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (isHttps(req)) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
const clientIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body ?? '';
  // Content-Length lets the admin page show a real download progress bar (backup file).
  const len = status === 200 ? { 'Content-Length': Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data)) } : {};
  res.writeHead(status, { ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), 'Cache-Control': 'no-store', ...len, ...headers });
  res.end(data);
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function readJson(req, limit = 64 * 1024) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON required');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'Body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

// Tiny in-memory rate limiter: max `max` hits per `windowMs` per key.
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) { buckets.set(key, { n: 1, reset: now + windowMs }); return true; }
  return ++b.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60_000).unref();

/* =====================================================================
   ADMIN SESSIONS + LOGIN PROTECTION
   ===================================================================== */
const SESSION_MS = 8 * 60 * 60 * 1000;               // stay logged in for 8 hours
const sessions = new Map();                           // token -> expiry time
const fails = new Map();                              // ip -> { n, until }

function adminSession(req) {
  const t = parseCookies(req).mf_admin;
  const exp = t && sessions.get(t);
  if (!exp) return null;
  if (Date.now() > exp) { sessions.delete(t); return null; }
  return t;
}
function requireAdmin(req) {
  if (!adminSession(req)) throw new HttpError(401, 'Not logged in');
  // CSRF defence in depth: if the browser sent an Origin, it must be this site.
  const o = req.headers.origin;
  if (o && req.method !== 'GET') { try { if (new URL(o).host !== req.headers.host) throw 0; } catch { throw new HttpError(403, 'Bad origin'); } }
}

/* =====================================================================
   BLOCKCHAIN CHECK — used to verify a reported token creation
   ===================================================================== */
const defaultRpc = net => net === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com';
async function rpcCall(method, params) {
  const url = rpcFor(getSetting('network'));
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}

// Reads the transaction from the chain and returns what REALLY happened.
async function verifyCreationTx(signature, mint) {
  const feeWallet = walletFor(getSetting('network'));
  let tx = null;
  for (let i = 0; i < 6 && !tx; i++) {               // RPC can lag a moment behind confirmation
    tx = await rpcCall('getTransaction', [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }]);
    if (!tx) await sleep(1500);
  }
  if (!tx || !tx.meta) throw new HttpError(404, 'Transaction not found on the configured network');
  if (tx.meta.err) throw new HttpError(400, 'Transaction failed on-chain');

  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable || []),
    ...(tx.meta.loadedAddresses?.readonly || []),
  ];
  // Must really be a token creation: it has to touch this mint, the Token program and Metaplex metadata.
  if (!keys.includes(mint) || !keys.includes(TOKEN_PROGRAM) || !keys.includes(METADATA_PROGRAM))
    throw new HttpError(400, 'Not a token creation transaction');
  // Must be fresh, so old unrelated transactions can't be reported.
  if (tx.blockTime && Date.now() / 1000 - tx.blockTime > 30 * 60) throw new HttpError(400, 'Transaction is too old');

  const creator = keys[0];                           // fee payer = the person who made the token
  let revenue = 0;
  const i = keys.indexOf(feeWallet);
  // revenue = exactly how much the fee wallet's balance went up in this transaction.
  // (If the creator IS the fee wallet — e.g. you testing — the transfer nets to zero, so revenue stays 0.)
  if (i >= 0 && creator !== feeWallet) revenue = Math.max(tx.meta.postBalances[i] - tx.meta.preBalances[i], 0);
  // paid = how much the creator's wallet really lost (fee payer = first account). network = the part that did NOT go to you:
  // account rent deposits + the network fee, which stay with Solana.
  const paid = Math.max((tx.meta.preBalances[0] - tx.meta.postBalances[0]) || 0, 0);
  const network = Math.max(paid - revenue, 0);
  const { name, symbol } = readTokenNames(tx, keys);
  return { creator, revenue, paid, network, name, symbol, blockTime: tx.blockTime };
}

// Token name + symbol, read from the Metaplex "create metadata" instruction inside the transaction itself,
// so they come from the chain and not from whatever the browser says. Returns empty strings if not found.
function readTokenNames(tx, keys) {
  try {
    for (const ix of tx.transaction.message.instructions || []) {
      if (keys[ix.programIdIndex] !== METADATA_PROGRAM) continue;
      const d = base58Decode(String(ix.data));
      if (![0, 16, 33].includes(d[0])) continue;            // CreateMetadataAccount v1 / v2 / v3
      let o = 1; const out = [];
      for (let n = 0; n < 2; n++) {                          // name, symbol: u32 length + utf8
        const len = d.readUInt32LE(o); o += 4;
        if (len > 200 || o + len > d.length) return { name: '', symbol: '' };
        out.push(cleanText(d.subarray(o, o + len).toString('utf8').replace(/\0+$/g, ''), 64)); o += len;
      }
      return { name: out[0], symbol: out[1] };
    }
  } catch { /* fall through */ }
  return { name: '', symbol: '' };
}

// Saves the token and adds its numbers to the daily report, in one all-or-nothing SQL transaction.
function recordToken({ signature, mint, creator, network, day, revenue, paid = 0, networkCost = 0, name = '', symbol = '', walletName = '', features = '' }) {
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO tokens(signature, mint, creator, network, day, revenue_lamports, paid_lamports, network_lamports, token_name, token_symbol, wallet_name, features)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(signature, mint, creator, network, day, revenue, paid, networkCost, name, symbol, walletName, features);
    db.prepare(`INSERT INTO daily_stats(day, network, tokens, revenue_lamports, spent_lamports, network_lamports) VALUES (?, ?, 1, ?, ?, ?)
                ON CONFLICT(day, network) DO UPDATE SET tokens = tokens + 1,
                                                       revenue_lamports = revenue_lamports + excluded.revenue_lamports,
                                                       spent_lamports   = spent_lamports   + excluded.spent_lamports,
                                                       network_lamports = network_lamports + excluded.network_lamports`)
      .run(day, network, revenue, paid, networkCost);
    // a creator is always a known wallet, even if the "connected" ping never reached us
    db.prepare('INSERT OR IGNORE INTO wallets(address, wallet, first_day) VALUES (?, ?, ?)').run(creator, walletName, day);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// A wallet connected on the token creator page. Upserts the address and counts the connection.
function recordWallet(address, walletName) {
  db.prepare(`INSERT INTO wallets(address, wallet, first_day) VALUES (?, ?, ?)
              ON CONFLICT(address) DO UPDATE SET connects = connects + 1, last_seen = datetime('now'),
                                                 wallet = CASE WHEN excluded.wallet <> '' THEN excluded.wallet ELSE wallet END`)
    .run(address, walletName, dayOf());
}

/* =====================================================================
   REPORT (daily visitors + tokens + revenue)
   ===================================================================== */
function buildReport(days, network, offset = 0) {
  offset = Math.min(Math.max(parseInt(offset, 10) || 0, 0), 3650);   // 0 = ends today; 7 = ends 7 days ago, ...
  days = Math.min(Math.max(parseInt(days, 10) || 30, 1), 366);
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < days + 2 && rows.length < days; i++) {   // walk back day by day in the admin's timezone
    const d = dayOf(new Date(Date.now() - (offset + i) * 86_400_000));
    if (seen.has(d)) continue; seen.add(d);
    rows.push({ day: d, visitors: 0, tokens: 0, revenue_lamports: 0, spent_lamports: 0, network_lamports: 0, wallets: 0 });
  }
  const from = rows[rows.length - 1].day;
  const byDay = Object.fromEntries(rows.map(r => [r.day, r]));
  // visitors = totals saved when old rows were purged + rows still in the table.
  // (A purge never touches today, so the two parts never overlap.)
  for (const v of db.prepare('SELECT day, visitors c FROM daily_visitors WHERE day >= ?').all(from)) if (byDay[v.day]) byDay[v.day].visitors += v.c;
  for (const v of db.prepare('SELECT day, COUNT(*) c FROM visits WHERE day >= ? GROUP BY day').all(from)) if (byDay[v.day]) byDay[v.day].visitors += v.c;
  for (const s of db.prepare('SELECT day, tokens, revenue_lamports, spent_lamports, network_lamports FROM daily_stats WHERE day >= ? AND network = ?').all(from, network))
    if (byDay[s.day]) Object.assign(byDay[s.day], { tokens: s.tokens, revenue_lamports: s.revenue_lamports, spent_lamports: s.spent_lamports, network_lamports: s.network_lamports });
  // wallets = NEW wallet addresses first seen that day
  for (const w of db.prepare('SELECT first_day day, COUNT(*) c FROM wallets WHERE first_day >= ? GROUP BY first_day').all(from)) if (byDay[w.day]) byDay[w.day].wallets = w.c;
  return rows;                                       // newest day first
}
// The oldest day that has any data (so the report's "Previous" button knows when to stop).
function firstDataDay(network) {
  const q = sql => db.prepare(sql).get()?.d || null;
  const all = [q('SELECT MIN(day) d FROM visits'), q('SELECT MIN(day) d FROM daily_visitors'), q('SELECT MIN(day) d FROM daily_stats'), q('SELECT MIN(first_day) d FROM wallets')].filter(Boolean);
  return all.length ? all.sort()[0] : dayOf();
}
function lifetime(network) {
  const r = db.prepare(`SELECT COALESCE(SUM(tokens),0) t, COALESCE(SUM(revenue_lamports),0) r, COALESCE(SUM(spent_lamports),0) s,
                               COALESCE(SUM(network_lamports),0) n FROM daily_stats WHERE network = ?`).get(network);
  return { tokens: r.t, revenue_lamports: r.r, spent_lamports: r.s, network_lamports: r.n };
}

/* ---------- lists for the admin Reports page: visitor wallets + created tokens ---------- */
const pageArgs = (page, size) => {
  size = Math.min(Math.max(parseInt(size, 10) || 25, 5), 100);
  return { size, page: Math.max(parseInt(page, 10) || 1, 1) };
};
const addrFilter = q => String(q ?? '').replace(/[^1-9A-HJ-NP-Za-km-z]/g, '').slice(0, 44);   // search box: base58 characters only

// Visitor wallets with what each one created and spent on `network`.
const WALLET_SELECT = `
  SELECT w.address, w.wallet, w.first_seen, w.last_seen, w.connects,
         COALESCE(t.tokens, 0) tokens, COALESCE(t.paid, 0) paid_lamports, COALESCE(t.fee, 0) fee_lamports, COALESCE(t.net, 0) network_lamports
  FROM wallets w
  LEFT JOIN (SELECT creator, COUNT(*) tokens, SUM(paid_lamports) paid, SUM(revenue_lamports) fee, SUM(network_lamports) net
             FROM tokens WHERE network = ? GROUP BY creator) t ON t.creator = w.address
  WHERE (? = '' OR instr(w.address, ?) > 0)
  ORDER BY w.last_seen DESC, w.rowid DESC`;
function listWallets(network, q, page, size, all = false) {
  q = addrFilter(q);
  const total = Number(db.prepare("SELECT COUNT(*) c FROM wallets WHERE (? = '' OR instr(address, ?) > 0)").get(q, q).c);
  if (all) return { rows: db.prepare(WALLET_SELECT + ' LIMIT 50000').all(network, q, q).map(r => ({ ...r })), total };
  const a = pageArgs(page, size), pages = Math.max(Math.ceil(total / a.size), 1), pg = Math.min(a.page, pages);
  const rows = db.prepare(WALLET_SELECT + ' LIMIT ? OFFSET ?').all(network, q, q, a.size, (pg - 1) * a.size).map(r => ({ ...r }));
  const today = Number(db.prepare('SELECT COUNT(*) c FROM wallets WHERE first_day = ?').get(dayOf()).c);
  return { rows, total, page: pg, pages, size: a.size, newToday: today };
}
const TOKEN_SELECT = `
  SELECT id, created_at, day, token_name, token_symbol, mint, creator, signature, wallet_name, features,
         paid_lamports, revenue_lamports fee_lamports, network_lamports
  FROM tokens WHERE network = ? AND (? = '' OR instr(creator, ?) > 0 OR instr(mint, ?) > 0) ORDER BY id DESC`;
function listTokens(network, q, page, size, all = false) {
  q = addrFilter(q);
  const total = Number(db.prepare("SELECT COUNT(*) c FROM tokens WHERE network = ? AND (? = '' OR instr(creator, ?) > 0 OR instr(mint, ?) > 0)").get(network, q, q, q).c);
  if (all) return { rows: db.prepare(TOKEN_SELECT + ' LIMIT 50000').all(network, q, q, q).map(r => ({ ...r })), total };
  const a = pageArgs(page, size), pages = Math.max(Math.ceil(total / a.size), 1), pg = Math.min(a.page, pages);
  const rows = db.prepare(TOKEN_SELECT + ' LIMIT ? OFFSET ?').all(network, q, q, q, a.size, (pg - 1) * a.size).map(r => ({ ...r }));
  return { rows, total, page: pg, pages, size: a.size };
}

/* =====================================================================
   SETTINGS VALIDATION (admin dashboard → database)
   ===================================================================== */
function readSettings() {
  return {
    network: getSetting('network'), timezone: getSetting('timezone'),
    rpcUrls: { 'mainnet-beta': getSetting('rpc_url_mainnet'), devnet: getSetting('rpc_url_devnet') },
    feeWallets: { 'mainnet-beta': getSetting('fee_wallet_mainnet'), devnet: getSetting('fee_wallet_devnet') },
    fees: db.prepare('SELECT key, label, amount FROM fees ORDER BY rowid').all(),
    passwordIsDefault: getSetting('admin_pass_default') === '1',
  };
}
function saveSettings(b) {
  if (!['mainnet-beta', 'devnet'].includes(b.network)) throw new HttpError(400, 'Network must be mainnet-beta or devnet');
  // one RPC endpoint + one revenue wallet per network (a single rpcUrl/feeWallet from an old client applies to the active network)
  const rpcs = {}, wallets = {};
  for (const net of ['mainnet-beta', 'devnet']) {
    const label = net === 'devnet' ? 'Devnet' : 'Mainnet';
    const legacyRpc = net === b.network ? b.rpcUrl : undefined, legacyWallet = net === b.network ? b.feeWallet : undefined;
    const rpc = String(b.rpcUrls?.[net] ?? legacyRpc ?? getSetting('rpc_url_' + netKey(net))).trim();
    if (rpc && !/^https?:\/\/[^\s]+$/i.test(rpc)) throw new HttpError(400, `${label} RPC URL must start with http:// or https:// (or be empty)`);
    const wallet = String(b.feeWallets?.[net] ?? legacyWallet ?? getSetting('fee_wallet_' + netKey(net))).trim();
    if (!isAddress(wallet)) throw new HttpError(400, `${label} revenue wallet is not a valid Solana address`);
    rpcs[net] = rpc; wallets[net] = wallet;
  }
  const tz = String(b.timezone ?? '').trim();
  if (!validTz(tz)) throw new HttpError(400, 'Unknown timezone (example: Asia/Manila)');
  const known = new Set(db.prepare('SELECT key FROM fees').all().map(r => r.key));
  const fees = {};
  for (const [k, v] of Object.entries(b.fees || {})) {
    if (!known.has(k)) throw new HttpError(400, `Unknown fee: ${k}`);
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw new HttpError(400, `Fee "${k}" must be a number from 0 to 1000 SOL`);
    fees[k] = Math.round(n * 1e6) / 1e6;
  }
  db.exec('BEGIN');
  try {
    setSetting('network', b.network); setSetting('timezone', tz);
    for (const net of ['mainnet-beta', 'devnet']) { setSetting('rpc_url_' + netKey(net), rpcs[net]); setSetting('fee_wallet_' + netKey(net), wallets[net]); }
    const up = db.prepare('UPDATE fees SET amount = ? WHERE key = ?');
    for (const [k, n] of Object.entries(fees)) up.run(n, k);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* =====================================================================
   LOGO UPLOAD
   The admin uploads an image (as a base64 data URL inside JSON). We never trust the
   browser's claimed type: the file's first bytes ("magic bytes") decide what it is.
   SVG is refused on purpose - an SVG can carry scripts.
   ===================================================================== */
const LOGO_MAX_BYTES = 1024 * 1024;                    // 1 MB
const LOGO_BODY_LIMIT = 1_600_000;                     // 1 MB of image = ~1.4 MB of base64 text
function sniffImage(b) {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const g = b.subarray(0, 6).toString('latin1');
  if (g === 'GIF87a' || g === 'GIF89a') return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
function saveLogo(dataUrl) {
  const m = /^data:image\/[a-z0-9+.-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl ?? ''));
  if (!m) throw new HttpError(400, 'Send the logo as an image file.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length === 0) throw new HttpError(400, 'The image is empty.');
  if (buf.length > LOGO_MAX_BYTES) throw new HttpError(413, 'Logo must be 1 MB or smaller.');
  const mime = sniffImage(buf);
  if (!mime) throw new HttpError(400, 'Use a PNG, JPG, GIF or WebP image (SVG is not allowed for safety).');
  db.prepare(`INSERT INTO assets(key, mime, data, updated_at) VALUES ('logo', ?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`)
    .run(mime, new Uint8Array(buf));
  return { mime, bytes: buf.length };
}

/* =====================================================================
   DATABASE MANAGER  (the built-in "phpMyAdmin" for this project)

   phpMyAdmin only speaks MySQL/MariaDB. This project uses SQLite, so instead of bolting
   on a second database server, the admin dashboard has its own manager that does what
   you actually need: watch the size, look inside the tables, free space safely.

   Safety rules (enforced HERE on the server, not just in the buttons):
   - Table names come from a fixed list and are never taken from the browser as SQL.
   - settings + fees can be viewed but never deleted (they run the site).
   - Purging visits first saves each day's visitor total into daily_visitors, so the
     report keeps its history. A purge never touches today.
   - Deleting rows does not shrink the file by itself (SQLite reuses the space later).
     "Optimize" (VACUUM) gives the space back to the disk.
   ===================================================================== */
const BROWSABLE = ['visits', 'tokens', 'wallets', 'daily_stats', 'daily_visitors', 'wallet_options', 'fees', 'settings'];
// What may be deleted, and how. ids:true = individual rows may be picked.
const DELETE_RULES = {
  visits:         { ids: false },   // only "older than N days" (so the visitor history can be saved first)
  tokens:         { ids: true },
  wallets:        { ids: true, noAge: true },   // visitor wallet list: pick rows (no "older than" - a wallet has no single day)
  daily_stats:    { ids: true },
  daily_visitors: { ids: true },
};
const fileSize = f => { try { return fs.statSync(f).size; } catch { return 0; } };
const dbSizes = () => { const main = fileSize(DB_FILE), wal = fileSize(DB_FILE + '-wal'); return { main, wal, total: main + wal }; };

function tableInfo() {
  return BROWSABLE.map(name => {
    const rows = Number(db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c);   // name is from the fixed list above
    let bytes = null;                                  // "dbstat" is missing in some SQLite builds -> size just shows "-"
    try {
      bytes = Number(db.prepare(`SELECT SUM(pgsize) s FROM dbstat WHERE name = ?
        OR name IN (SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?)`).get(name, name).s ?? 0);
    } catch { /* ignore */ }
    return { name, rows, bytes, deletable: !!DELETE_RULES[name], byIds: !!DELETE_RULES[name]?.ids };
  });
}
function dbOverview() {
  const size = dbSizes();
  const limitMb = Number(getSetting('db_limit_mb')) || 100;
  const percent = Math.round(size.total / (limitMb * 1048576) * 1000) / 10;
  return { ...size, limitMb, percent, status: percent >= 100 ? 'over' : percent >= 80 ? 'warn' : 'ok', tables: tableInfo() };
}
function browseTable(name, page, size) {
  if (!BROWSABLE.includes(name)) throw new HttpError(400, 'Unknown table');
  size = Math.min(Math.max(parseInt(size, 10) || 25, 5), 100);
  const total = Number(db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c);
  const pages = Math.max(Math.ceil(total / size), 1);
  page = Math.min(Math.max(parseInt(page, 10) || 1, 1), pages);
  const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(c => c.name);
  const rows = db.prepare(`SELECT rowid AS _id, * FROM "${name}" ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(size, (page - 1) * size)
    .map(r => ({ ...r }));
  if (name === 'settings') for (const r of rows) if (r.key === 'admin_pass_hash') r.value = '••••••••';   // never show the hash
  return { name, columns, rows, total, page, pages, size, deletable: !!DELETE_RULES[name], byIds: !!DELETE_RULES[name]?.ids, byAge: !!DELETE_RULES[name] && !DELETE_RULES[name].noAge };
}
// Saves per-day visitor totals of the rows about to be deleted (days before `cutoff`).
function rollupVisits(cutoff) {
  db.prepare(`INSERT INTO daily_visitors(day, visitors)
              SELECT day, COUNT(*) FROM visits WHERE day < ? GROUP BY day
              ON CONFLICT(day) DO UPDATE SET visitors = visitors + excluded.visitors`).run(cutoff);
}
function optimizeDb() {
  const before = dbSizes().total;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { before, after: dbSizes().total };
}
// body: { table, mode: 'older'|'ids', days, ids, dryRun, optimize }
function deleteRows(b) {
  const table = String(b.table ?? '');
  const rule = DELETE_RULES[table];
  if (!rule) throw new HttpError(403, 'Rows in this table cannot be deleted from the dashboard.');
  let where, args, cutoff = null;
  if (b.mode === 'older') {
    if (rule.noAge) throw new HttpError(400, 'Rows in this table can only be deleted by selecting them.');
    const days = Number(b.days);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new HttpError(400, 'Days must be a whole number from 0 to 3650.');
    cutoff = dayOf(new Date(Date.now() - days * 86_400_000));       // 0 days = everything before today
    where = 'day < ?'; args = [cutoff];
  } else if (b.mode === 'ids') {
    if (!rule.ids) throw new HttpError(400, 'Rows in this table can only be deleted by age ("older than N days").');
    const ids = Array.isArray(b.ids) ? b.ids : [];
    if (!ids.length || ids.length > 500 || !ids.every(n => Number.isInteger(n) && n > 0)) throw new HttpError(400, 'Select between 1 and 500 rows.');
    where = `rowid IN (${ids.map(() => '?').join(',')})`; args = ids;
  } else throw new HttpError(400, 'Unknown delete mode');

  if (b.dryRun) return { dryRun: true, count: Number(db.prepare(`SELECT COUNT(*) c FROM "${table}" WHERE ${where}`).get(...args).c) };

  let deleted = 0;
  db.exec('BEGIN');                                   // all-or-nothing, like recordToken()
  try {
    if (table === 'visits') rollupVisits(cutoff);
    deleted = Number(db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...args).changes);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const shrink = b.optimize ? optimizeDb() : null;
  return { deleted, shrink };
}
// A consistent copy of the whole database, safe to take while the site is running.
function makeBackup() {
  const tmp = path.join(os.tmpdir(), `memeforge-backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  try { return fs.readFileSync(tmp); } finally { fs.rmSync(tmp, { force: true }); }
}

/* =====================================================================
   WALLET OPTIONS (admin → Wallets)
   Everything the admin types is validated here. Nothing is ever executed: `provider` is only
   used by the browser to LOOK UP a property on window (dangerous names are refused), and links must be https.
   ===================================================================== */
const PATH_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){0,3}$/;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const httpsUrl = (v, label, max = 500) => {
  v = String(v ?? '').trim();
  if (!v) return '';
  if (v.length > max || /\s/.test(v)) throw new HttpError(400, `${label} is not a valid link.`);
  let u; try { u = new URL(v); } catch { throw new HttpError(400, `${label} must be a full link starting with https://`); }
  if (u.protocol !== 'https:') throw new HttpError(400, `${label} must start with https://`);
  return v;
};
function cleanWalletInput(b, existing) {
  const name = cleanText(b.name, 30);
  if (!name) throw new HttpError(400, 'Wallet name is required (max 30 characters).');
  const logo = httpsUrl(b.logoUrl, 'Logo link');
  const provider = String(b.provider ?? '').trim();
  if (provider && (!PATH_RE.test(provider) || provider.split('.').some(k => BAD_KEYS.has(k))))
    throw new HttpError(400, 'Provider must look like phantom.solana (letters, numbers, dots; up to 4 parts).');
  const flag = String(b.flag ?? '').trim();
  if (flag && (!/^[A-Za-z_$][\w$]{0,40}$/.test(flag) || BAD_KEYS.has(flag))) throw new HttpError(400, 'Detection flag must be a single word such as isPhantom (or empty).');
  const install = httpsUrl(b.installUrl, 'Install link');
  const deeplink = httpsUrl(b.deeplink, 'Mobile link');
  if (deeplink && !deeplink.includes('{url}')) throw new HttpError(400, 'Mobile link must contain {url} where the page address goes.');
  const color = String(b.color ?? '').trim();
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, 'Color must look like #6b5cf0.');
  const popular = b.popular === undefined ? (existing ? existing.popular : 0) : (b.popular === true || b.popular === 1 ? 1 : 0);
  return { name, logo, provider, flag, install, deeplink, color, popular, enabled: b.enabled === false || b.enabled === 0 ? 0 : 1 };
}
const walletRows = () => db.prepare('SELECT * FROM wallet_options ORDER BY sort, rowid').all().map(w => ({
  id: w.id, name: w.name, logoUrl: w.logo_url, provider: w.provider, flag: w.flag, installUrl: w.install_url,
  deeplink: w.deeplink, color: w.color, enabled: !!w.enabled, popular: !!w.popular,
}));
const walletList = () => ({ wallets: walletRows(), presets: WALLET_PRESETS.map(p => ({ id: p.id, name: p.name, logoUrl: p.logo, provider: p.provider, flag: p.flag, installUrl: p.install_url, deeplink: p.deeplink, color: p.color, cat: p.cat, hasProvider: !!p.provider })) });
function createWallet(b) {
  const w = cleanWalletInput(b);
  if (db.prepare('SELECT COUNT(*) c FROM wallet_options').get().c >= 300) throw new HttpError(400, 'That is a lot of wallets already (max 300). Remove one first.');
  let base = (cleanText(b.id, 30) || w.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'wallet';
  let id = base, n = 2;
  while (db.prepare('SELECT 1 FROM wallet_options WHERE id = ?').get(id)) id = `${base}-${n++}`;
  const sort = Number(db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 m FROM wallet_options').get().m);
  db.prepare(`INSERT INTO wallet_options(id, name, logo_url, provider, flag, install_url, deeplink, color, sort, enabled, popular) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, w.name, w.logo, w.provider, w.flag, w.install, w.deeplink, w.color, sort, w.enabled, w.popular);
  return id;
}

// Adds catalog wallets in one go. ids = list of preset ids, or 'all'. Skips ones already on the list. New ones are shown (enabled).
function addPresets(ids) {
  const wanted = ids === 'all' ? WALLET_PRESETS : WALLET_PRESETS.filter(p => Array.isArray(ids) && ids.includes(p.id));
  if (!wanted.length) throw new HttpError(400, 'No wallets selected.');
  const have = new Set(db.prepare('SELECT lower(name) n FROM wallet_options').all().map(r => r.n));
  const haveId = new Set(db.prepare('SELECT id FROM wallet_options').all().map(r => r.id));
  let sort = Number(db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 m FROM wallet_options').get().m), added = 0;
  const ins = db.prepare(`INSERT INTO wallet_options(id, name, logo_url, provider, flag, install_url, deeplink, color, sort, enabled, popular) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
  db.exec('BEGIN');
  try {
    for (const w of wanted) {
      if (have.has(w.name.toLowerCase()) || haveId.has(w.id)) continue;
      ins.run(w.id, w.name, w.logo, w.provider, w.flag, w.install_url, w.deeplink, w.color, sort++, POPULAR_DEFAULT.has(w.id) ? 1 : 0); added++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return added;
}
function updateWallet(id, b) {
  if (!db.prepare('SELECT 1 FROM wallet_options WHERE id = ?').get(id)) throw new HttpError(404, 'Wallet not found');
  const w = cleanWalletInput(b, db.prepare('SELECT popular FROM wallet_options WHERE id = ?').get(id));
  db.prepare(`UPDATE wallet_options SET name=?, logo_url=?, provider=?, flag=?, install_url=?, deeplink=?, color=?, enabled=?, popular=? WHERE id=?`)
    .run(w.name, w.logo, w.provider, w.flag, w.install, w.deeplink, w.color, w.enabled, w.popular, id);
}
function reorderWallets(ids) {
  const have = db.prepare('SELECT id FROM wallet_options').all().map(r => r.id);
  if (!Array.isArray(ids) || ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every(i => have.includes(i))) throw new HttpError(400, 'Bad order');
  db.exec('BEGIN');
  try { const up = db.prepare('UPDATE wallet_options SET sort = ? WHERE id = ?'); ids.forEach((i, n) => up.run(n, i)); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}


/* =====================================================================
   ADMIN APPEARANCE (admin → Appearance)
   The theme is a small JSON object kept in settings ('admin_theme'). Every value is checked against a fixed list
   here, so the browser can safely turn it into CSS variables (nothing typed by the admin is ever used as markup or CSS).
   Defaults and the preset themes live in public/admin-theme.js.
   ===================================================================== */
const THEME_ENUM = {
  mode: ['dark', 'light', 'auto'], bg: ['aurora', 'dots', 'plain'], font: ['system', 'rounded', 'serif', 'mono'],
  fontSize: ['small', 'normal', 'large'], radius: ['sharp', 'soft', 'round', 'pill'], density: ['compact', 'comfortable', 'spacious'],
  card: ['glass', 'solid', 'outline'], sidebar: ['glass', 'solid', 'accent'], width: ['narrow', 'normal', 'wide', 'full'],
  navStyle: ['soft', 'bar', 'pill'],
};
const THEME_BOOL = ['gradient', 'animations', 'collapsed', 'blur', 'zebra'];
const THEME_TEXT = { brandName: 30, brandTag: 40, preset: 24 };
function cleanTheme(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Bad theme');
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (k in THEME_ENUM) { if (!THEME_ENUM[k].includes(v)) throw new HttpError(400, `Bad value for ${k}`); out[k] = v; }
    else if (THEME_BOOL.includes(k)) { if (typeof v !== 'boolean') throw new HttpError(400, `Bad value for ${k}`); out[k] = v; }
    else if (k === 'accent' || k === 'accent2') { if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw new HttpError(400, 'Colors must look like #7c5cff'); out[k] = v.toLowerCase(); }
    else if (k in THEME_TEXT) { out[k] = cleanText(v, THEME_TEXT[k]); }
    else throw new HttpError(400, `Unknown theme option: ${String(k).slice(0, 30)}`);
  }
  return out;
}
const readTheme = () => { try { const t = JSON.parse(getSetting('admin_theme') || '{}'); return t && typeof t === 'object' ? t : {}; } catch { return {}; } };

/* =====================================================================
   SEASONAL THEMES + SPECIAL OFFER (admin → Themes & offers)
   One JSON object in settings ('site_promo'). Every value is validated here against fixed lists / patterns, and the public
   pages draw it with textContent + CSS variables only, so nothing the admin types can become markup or CSS.

   THEME  mode 'off' (normal look) | 'manual' (always show one theme) | 'schedule' (each theme has a yearly date window, in the
          reports timezone). Each theme has colours, emoji, a motion effect and an optional greeting banner; the admin can edit any
          of them. Edited themes are kept in theme.edits[id]; untouched ones use THEME_PRESETS.
   OFFER  a discount % that is applied HERE, to the prices in /fees-config.js, so the receipt, the Create button and the fee that is
          really sent in the transaction all agree. It only applies between start and end (reports timezone). The prices in
          Pricing & network are never changed. Revenue is still measured from the chain, so reports stay correct.
   ===================================================================== */
const HEX = /^#[0-9a-f]{6}$/i;
const PROMO_COLORS = ['bg', 'bg2', 'c1', 'c2', 'c3', 'c4', 'c5'];     // page, page 2, 3 accents + glow/grid colour + coin colour
const mkTheme = (label, note, colors, emojis, effect, banner, extra = {}) => ({
  label, note, colors: Object.fromEntries(PROMO_COLORS.map((k, i) => [k, colors[i]])), emojis, effect,
  density: 'normal', coins: false, lights: false, bannerOn: true, banner, ...extra,
});
const THEME_PRESETS = {
  christmas:   mkTheme('Christmas',      'Red, green and gold with falling snow', ['#07140f', '#0d2218', '#ff3b4e', '#1fa65a', '#bfe8ff', '#ffd447', '#ffe27a'], ['🎄', '❄️', '🎁', '⭐', '🔔', '🎅', '☃️'], 'fall', '🎄 Merry Christmas from MemeForge! Launch your token under the tree 🎁', { lights: true }),
  newyear:     mkTheme('New Year',       'Gold and midnight blue with fireworks', ['#070a1a', '#0f1433', '#ffcf40', '#6c63ff', '#4fe3ff', '#ffffff', '#ffe08a'], ['🎆', '🎇', '🥂', '✨', '🎉', '🍾'], 'rise', '🎆 Happy New Year! Make this the year of your token 🥂'),
  valentine:   mkTheme("Valentine's",    'Pinks and hearts floating up', ['#14060f', '#2a0a1c', '#ff4d8d', '#b02bff', '#ff9ecb', '#ff6b9a', '#ffd1e3'], ['💖', '💘', '💝', '🌹', '💌', '❤️'], 'rise', "💘 Happy Valentine's Day! Fall in love with your own token 💖"),
  easter:      mkTheme('Easter',         'Soft pastels, eggs and flowers', ['#0b1220', '#14213a', '#ff8fd1', '#9b7bff', '#6fe3ff', '#b6f55b', '#ffe36e'], ['🐣', '🥚', '🐰', '🌷', '🌸', '🐥'], 'fall', '🐣 Happy Easter! Hatch your token today 🥚'),
  summer:      mkTheme('Summer',         'Ocean blue and sunshine', ['#04141c', '#072a3a', '#ff5e7e', '#1aa6ff', '#27f0e0', '#ffe14a', '#ffcf33'], ['🌴', '☀️', '🍍', '🌊', '🏖️', '🍹', '🕶️'], 'rise', '🌴 Summer launch season! Create your token in the sun ☀️'),
  halloween:   mkTheme('Halloween',      'Orange and purple, ghosts and bats', ['#0d0612', '#1a0b22', '#ff7a1a', '#8a3ffc', '#3dff9a', '#b6ff3b', '#ffb347'], ['🎃', '👻', '🦇', '🕷️', '💀', '🕸️', '🍬'], 'rise', '🎃 Happy Halloween! Launch something spooky 👻'),
  blackfriday: mkTheme('Black Friday',   'Black and yellow deal mode', ['#060606', '#141414', '#ffd400', '#ff3b30', '#ffffff', '#ffd400', '#ffe066'], ['🏷️', '💸', '🔥', '💰', '🛒', '⚡'], 'fall', '🏷️ Black Friday is here! Grab the deal before it is gone 🔥', { coins: true }),
  custom:      mkTheme('Custom',         'Start from the MemeForge colours and make it yours', ['#0a0614', '#120a24', '#ff3df2', '#8b4dff', '#27e8ff', '#b6ff3b', '#ffd23f'], ['✨', '🚀', '💎'], 'rise', '', { coins: true, bannerOn: false }),
};
// yearly windows as MM-DD (reports timezone). A window may wrap over New Year (from > to). First match wins, in this order.
const THEME_SCHEDULE_DEFAULT = {
  christmas: { on: true, from: '12-01', to: '12-26' }, newyear: { on: true, from: '12-27', to: '01-05' },
  valentine: { on: true, from: '02-07', to: '02-15' }, easter: { on: false, from: '04-01', to: '04-20' },   // Easter moves every year: adjust it
  summer: { on: false, from: '06-01', to: '08-31' }, halloween: { on: true, from: '10-15', to: '11-01' },
  blackfriday: { on: true, from: '11-20', to: '11-30' }, custom: { on: false, from: '01-01', to: '01-31' },
};
const OFFER_DEFAULT = {
  on: false, title: 'Special launch offer', text: 'Create your token for less. For a limited time only.', badge: '', discount: 20, applies: 'all',
  start: '', end: '', countdown: true, landing: true, creator: true, cta: 'Create token', ctaUrl: '',
};
const defaultPromo = () => ({ theme: { mode: 'off', active: 'christmas', schedule: structuredClone(THEME_SCHEDULE_DEFAULT), edits: {} }, offer: { ...OFFER_DEFAULT } });

const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isMMDD = v => typeof v === 'string' && MMDD.test(v) && (+v.slice(3) <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][+v.slice(0, 2) - 1]);
const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const pickEnum = (v, list, name) => { if (!list.includes(v)) throw new HttpError(400, `Bad value for ${name}`); return v; };
const pickBool = (v, name) => { if (typeof v !== 'boolean') throw new HttpError(400, `Bad value for ${name}`); return v; };

// A theme spec = the preset's values with the admin's edits on top. Anything not valid is rejected, never "fixed" silently.
function cleanThemeSpec(b, id) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Bad theme');
  const base = THEME_PRESETS[id], out = { ...base, colors: { ...base.colors }, emojis: [...base.emojis] };
  if ('label' in b) { out.label = cleanText(b.label, 20); if (!out.label) throw new HttpError(400, 'The theme needs a name'); }
  if (b.colors != null) {
    if (typeof b.colors !== 'object' || Array.isArray(b.colors)) throw new HttpError(400, 'Bad colours');
    for (const [k, v] of Object.entries(b.colors)) {
      if (!PROMO_COLORS.includes(k)) throw new HttpError(400, 'Unknown colour: ' + String(k).slice(0, 20));
      if (typeof v !== 'string' || !HEX.test(v)) throw new HttpError(400, 'Colours must look like #ff3df2');
      out.colors[k] = v.toLowerCase();
    }
  }
  if ('emojis' in b) {
    if (!Array.isArray(b.emojis) || b.emojis.length > 14) throw new HttpError(400, 'Use up to 14 emoji');
    out.emojis = b.emojis.map(e => cleanText(e, 16)).filter(Boolean);
  }
  if ('effect' in b) out.effect = pickEnum(b.effect, ['rise', 'fall', 'none'], 'effect');
  if ('density' in b) out.density = pickEnum(b.density, ['low', 'normal', 'high'], 'density');
  for (const k of ['coins', 'lights', 'bannerOn']) if (k in b) out[k] = pickBool(b[k], k);
  if ('banner' in b) out.banner = cleanText(b.banner, 90);
  return out;
}
function cleanOffer(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Bad offer');
  const o = { ...OFFER_DEFAULT };
  for (const k of ['on', 'countdown', 'landing', 'creator']) if (k in b) o[k] = pickBool(b[k], k);
  const txt = { title: 60, text: 200, badge: 20, cta: 24 };
  for (const [k, max] of Object.entries(txt)) if (k in b) o[k] = cleanText(b[k], max);
  if ('discount' in b) {
    const n = Number(b.discount);
    if (!Number.isInteger(n) || n < 0 || n > 90) throw new HttpError(400, 'Discount must be a whole number from 0 to 90');
    o.discount = n;
  }
  if ('applies' in b) o.applies = pickEnum(b.applies, ['all', 'base', 'extras'], 'applies');
  if ('ctaUrl' in b) {
    const u = cleanText(b.ctaUrl, 200);
    if (u) {
      let ok = /^[\w./#-]{1,100}$/.test(u) && !u.startsWith('//');                       // a page of this site, like solana-token-creator.html#create
      if (!ok) { try { ok = new URL(u).protocol === 'https:'; } catch { ok = false; } }   // or a full https:// link
      if (!ok) throw new HttpError(400, 'The button link must be a page of this site (like solana-token-creator.html) or a full https:// address');
    }
    o.ctaUrl = u;
  }
  for (const k of ['start', 'end']) if (k in b) {
    const v = cleanText(b[k], 16);
    if (v && (!LOCAL_DT.test(v) || Number.isNaN(zonedToMs(v, 'UTC')))) throw new HttpError(400, `The ${k} date is not valid`);
    o[k] = v;
  }
  if (o.start && o.end && !(zonedToMs(o.end, 'UTC') > zonedToMs(o.start, 'UTC'))) throw new HttpError(400, 'The end of the offer must be after its start');
  if (o.on && !o.title) throw new HttpError(400, 'Give the offer a title');
  return o;
}
function cleanPromo(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Bad settings');
  const out = defaultPromo(), t = b.theme ?? {};
  if (typeof t !== 'object' || Array.isArray(t)) throw new HttpError(400, 'Bad theme settings');
  if ('mode' in t) out.theme.mode = pickEnum(t.mode, ['off', 'manual', 'schedule'], 'mode');
  if ('active' in t) out.theme.active = pickEnum(t.active, Object.keys(THEME_PRESETS), 'theme');
  for (const [id, s] of Object.entries(t.schedule ?? {})) {
    if (!(id in THEME_PRESETS)) throw new HttpError(400, 'Unknown theme in the schedule');
    if (!s || typeof s !== 'object') throw new HttpError(400, 'Bad schedule');
    if (!isMMDD(s.from) || !isMMDD(s.to)) throw new HttpError(400, `${THEME_PRESETS[id].label}: dates must be real days, month and day`);
    out.theme.schedule[id] = { on: pickBool(s.on, 'schedule'), from: s.from, to: s.to };
  }
  for (const [id, spec] of Object.entries(t.edits ?? {})) {
    if (!(id in THEME_PRESETS)) throw new HttpError(400, 'Unknown theme: ' + String(id).slice(0, 20));
    out.theme.edits[id] = cleanThemeSpec(spec, id);
  }
  out.offer = cleanOffer(b.offer ?? {});
  return out;
}
function readPromo() {
  try { const raw = getSetting('site_promo'); return raw ? cleanPromo(JSON.parse(raw)) : defaultPromo(); } catch { return defaultPromo(); }
}

// "2026-12-01T09:00" typed in the reports timezone → a real UTC time in ms.
function tzOffsetMs(tz, ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const g = t => +parts.find(p => p.type === t).value;
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000;
}
function zonedToMs(str, tz) {
  const m = LOCAL_DT.test(str) && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(str);
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (new Date(guess).getUTCMonth() !== +m[2] - 1 || +m[4] > 23 || +m[5] > 59) return NaN;   // 31 Feb, 25:00 …
  try { const first = guess - tzOffsetMs(tz, guess); return guess - tzOffsetMs(tz, first); } catch { return guess; }
}
const siteTz = () => getSetting('timezone') || 'UTC';

function activeThemeId(p, now = new Date()) {
  if (p.theme.mode === 'manual') return p.theme.active;
  if (p.theme.mode !== 'schedule') return null;
  const md = dayOf(now).slice(5);                                       // today as MM-DD in the reports timezone
  for (const [id, s] of Object.entries(p.theme.schedule)) {
    if (!s.on) continue;
    if (s.from <= s.to ? (md >= s.from && md <= s.to) : (md >= s.from || md <= s.to)) return id;
  }
  return null;
}
const themeSpec = (p, id) => p.theme.edits[id] ?? THEME_PRESETS[id];

// 'off' | 'scheduled' | 'live' | 'ended', plus the start/end as real times
function offerState(o, now = Date.now()) {
  const tz = siteTz(), startMs = o.start ? zonedToMs(o.start, tz) : null, endMs = o.end ? zonedToMs(o.end, tz) : null;
  let status = 'live';
  if (!o.on) status = 'off';
  else if (startMs != null && now < startMs) status = 'scheduled';
  else if (endMs != null && now >= endMs) status = 'ended';
  return { status, startMs, endMs };
}
const round6 = x => Math.round(x * 1e6) / 1e6;
function priceSet(fees, o) {                                            // fees = { creation, banner, … } in SOL; o = a LIVE offer
  if (!o || !o.discount) return { ...fees };
  const out = {};
  for (const [k, v] of Object.entries(fees)) {
    const hit = o.applies === 'all' || (o.applies === 'base' ? k === 'creation' : k !== 'creation');
    out[k] = hit ? round6(v * (100 - o.discount) / 100) : v;
  }
  return out;
}
const liveOffer = () => { const o = readPromo().offer; return offerState(o).status === 'live' ? o : null; };

// What the public pages receive inside /fees-config.js (window.MEMEFORGE_CONFIG.promo)
function publicPromo(fees) {
  const p = readPromo(), out = { theme: null, offer: null };
  const id = activeThemeId(p);
  if (id) { const s = themeSpec(p, id); out.theme = { id, ...s }; }
  const o = p.offer, st = offerState(o);
  if (st.status === 'live') {
    const now = priceSet(fees, o);
    out.offer = { title: o.title, text: o.text, badge: o.badge, discount: o.discount, applies: o.applies, countdown: o.countdown, landing: o.landing, creator: o.creator,
      cta: o.cta, ctaUrl: o.ctaUrl, endsAt: st.endMs, serverNow: Date.now() };
    if (o.discount) out.offer.original = { creationFee: fees.creation, featureFees: Object.fromEntries(Object.entries(fees).filter(([k]) => k !== 'creation')) };
    out.offer.pricesNow = { creationFee: now.creation };
  }
  return out;
}

function adminPromoView() {
  const p = readPromo(), st = offerState(p.offer), fees = getFees();
  const labels = Object.fromEntries(db.prepare('SELECT key, label FROM fees').all().map(r => [r.key, r.label]));
  return {
    promo: p, presets: THEME_PRESETS, scheduleDefault: THEME_SCHEDULE_DEFAULT, timezone: siteTz(), serverNow: Date.now(),
    status: { offer: st.status, startsAt: st.startMs, endsAt: st.endMs, theme: activeThemeId(p) },
    prices: Object.keys(fees).map(k => ({ key: k, label: labels[k] || k, original: fees[k] })),
  };
}

/* =====================================================================
   ROUTES
   ===================================================================== */
const BOT = /bot|crawl|spider|slurp|headless|curl|wget|python-requests|monitor/i;

async function handleApi(req, res, url) {
  const p = url.pathname, m = req.method;

  /* ---------- public: dynamic fees-config.js (same shape as the old file) ---------- */
  if (p === '/fees-config.js' && m === 'GET') {
    const all = getFees();
    const promo = publicPromo(all);                   // seasonal theme + special offer (admin → Themes & offers)
    const f = promo.offer ? priceSet(all, readPromo().offer) : all;   // an active offer lowers the prices the pages show AND charge
    const cfg = {
      network: getSetting('network'), rpcUrl: getSetting('rpc_url_' + netKey(getSetting('network'))), feeWallet: walletFor(getSetting('network')),
      creationFee: f.creation,
      featureFees: { banner: f.banner, social: f.social, creator: f.creator, mintRevoke: f.mintRevoke, freezeRevoke: f.freezeRevoke, metaRevoke: f.metaRevoke },
      wallets: publicWallets(),                       // the wallets shown in the "Connect a wallet" popup (admin → Wallets)
      promo,
    };
    return send(res, 200, 'window.MEMEFORGE_CONFIG = ' + JSON.stringify(cfg) + ';', { 'Content-Type': 'text/javascript; charset=utf-8' });
  }

  /* ---------- public: the uploaded logo ---------- */
  if (p === '/logo' && (m === 'GET' || m === 'HEAD')) {
    const a = db.prepare("SELECT mime, data FROM assets WHERE key = 'logo'").get();
    if (!a) throw new HttpError(404, 'No logo uploaded');
    const buf = Buffer.from(a.data);
    const etag = '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"';
    const h = { ETag: etag, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'none'; sandbox" };
    if (req.headers['if-none-match'] === etag) return send(res, 304, '', h);
    return send(res, 200, buf, { ...h, 'Content-Type': a.mime });
  }

  /* ---------- public: count a visitor (once per person per day) ---------- */
  if (p === '/api/visit' && m === 'POST') {
    if (BOT.test(req.headers['user-agent'] || '')) return send(res, 204);
    if (!rateLimit('visit:' + clientIp(req), 60, 3_600_000)) return send(res, 429, { error: 'Slow down' });
    const cookies = parseCookies(req);
    let vid = cookies.mf_vid;
    if (!/^[a-f0-9]{32}$/.test(vid || '')) {
      vid = crypto.randomBytes(16).toString('hex');
      setCookie(res, req, 'mf_vid', vid, { maxAge: 31_536_000 });   // random id, valid 1 year
    }
    db.prepare('INSERT OR IGNORE INTO visits(day, visitor) VALUES (?, ?)').run(dayOf(), vid);
    return send(res, 204);
  }

  /* ---------- public: a token was created → verify on-chain, then record ---------- */
  if (p === '/api/token-created' && m === 'POST') {
    if (!rateLimit('tok:' + clientIp(req), 20, 3_600_000)) throw new HttpError(429, 'Too many requests');
    const { signature, mint, wallet, features } = await readJson(req);
    if (!isSignature(signature) || !isAddress(mint)) throw new HttpError(400, 'Bad signature or mint');
    if (db.prepare('SELECT 1 FROM tokens WHERE signature = ?').get(signature)) return send(res, 200, { ok: true, duplicate: true });
    const v = await verifyCreationTx(signature, mint);
    const day = dayOf(v.blockTime ? new Date(v.blockTime * 1000) : new Date());
    // name/symbol/amounts come from the chain (v). Only the wallet app name and the ticked features come from the browser,
    // so they are cut down to known, short values.
    const known = new Set(Object.keys(getFees()).filter(k => k !== 'creation'));
    const feat = (Array.isArray(features) ? features : []).filter(k => known.has(k)).join(',');
    try { recordToken({ signature, mint, creator: v.creator, network: getSetting('network'), day, revenue: v.revenue,
                        paid: v.paid, networkCost: v.network, name: v.name, symbol: v.symbol, walletName: cleanText(wallet, 30), features: feat }); }
    catch (e) { if (/UNIQUE/i.test(String(e.message))) return send(res, 200, { ok: true, duplicate: true }); throw e; }
    return send(res, 200, { ok: true, revenue: v.revenue / LAMPORTS, paid: v.paid / LAMPORTS, network: v.network / LAMPORTS });
  }

  /* ---------- public: a wallet connected on the token creator page ---------- */
  if (p === '/api/wallet-connected' && m === 'POST') {
    if (!rateLimit('wal:' + clientIp(req), 40, 3_600_000)) throw new HttpError(429, 'Too many requests');
    const { address, wallet } = await readJson(req);
    if (!isAddress(address)) throw new HttpError(400, 'Bad wallet address');
    recordWallet(address, cleanText(wallet, 30));
    return send(res, 204);
  }

  /* ---------- admin: login / logout / session ---------- */
  if (p === '/api/admin/login' && m === 'POST') {
    const ip = clientIp(req);
    const f = fails.get(ip);
    if (f && f.until > Date.now()) throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 60_000)} min.`);
    const { password } = await readJson(req);
    if (typeof password !== 'string' || !checkPassword(password, getSetting('admin_pass_hash'))) {
      const n = (f?.n || 0) + 1;
      fails.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60_000 : 0 });   // 5 misses = 15 min lock
      await sleep(600);
      throw new HttpError(401, 'Wrong password');
    }
    fails.delete(ip);
    const t = crypto.randomBytes(32).toString('hex');
    sessions.set(t, Date.now() + SESSION_MS);
    setCookie(res, req, 'mf_admin', t, { maxAge: SESSION_MS / 1000, sameSite: 'Strict' });
    return send(res, 200, { ok: true, passwordIsDefault: getSetting('admin_pass_default') === '1' });
  }
  if (p === '/api/admin/logout' && m === 'POST') {
    const t = adminSession(req);
    if (t) sessions.delete(t);
    setCookie(res, req, 'mf_admin', '', { maxAge: 0, sameSite: 'Strict' });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/me' && m === 'GET') {
    return send(res, 200, { loggedIn: !!adminSession(req) });
  }

  /* ---------- admin: everything below needs a valid login ---------- */
  if (p.startsWith('/api/admin/')) {
    requireAdmin(req);

    if (p === '/api/admin/settings' && m === 'GET') return send(res, 200, readSettings());
    if (p === '/api/admin/settings' && m === 'PUT') { saveSettings(await readJson(req)); return send(res, 200, readSettings()); }

    if (p === '/api/admin/password' && m === 'POST') {
      const { current, next } = await readJson(req);
      if (!checkPassword(String(current ?? ''), getSetting('admin_pass_hash'))) throw new HttpError(403, 'Current password is wrong');
      if (typeof next !== 'string' || next.length < 6 || next.length > 200) throw new HttpError(400, 'New password must be at least 6 characters');
      setSetting('admin_pass_hash', hashPassword(next));
      setSetting('admin_pass_default', '0');
      const keep = adminSession(req);
      for (const t of sessions.keys()) if (t !== keep) sessions.delete(t);   // log out every other session
      return send(res, 200, { ok: true });
    }

    /* admin look & feel (Appearance page) */
    if (p === '/api/admin/theme' && m === 'GET') return send(res, 200, { theme: readTheme() });
    if (p === '/api/admin/theme' && m === 'PUT') { const t = cleanTheme(await readJson(req)); setSetting('admin_theme', JSON.stringify(t)); return send(res, 200, { theme: t }); }
    if (p === '/api/admin/theme' && m === 'DELETE') { setSetting('admin_theme', '{}'); return send(res, 200, { theme: {} }); }

    /* themes + special offer for the public pages */
    if (p === '/api/admin/promo' && m === 'GET') return send(res, 200, adminPromoView());
    if (p === '/api/admin/promo' && m === 'PUT') { const c = cleanPromo(await readJson(req, 128 * 1024)); setSetting('site_promo', JSON.stringify(c)); return send(res, 200, adminPromoView()); }
    if (p === '/api/admin/promo' && m === 'DELETE') { setSetting('site_promo', ''); return send(res, 200, adminPromoView()); }

    /* wallet list shown on the token creator */
    if (p === '/api/admin/wallet-options' && m === 'GET') return send(res, 200, walletList());
    if (p === '/api/admin/wallet-options' && m === 'POST') { createWallet(await readJson(req)); return send(res, 200, walletList()); }
    if (p === '/api/admin/wallet-options/add-presets' && m === 'POST') { const n = addPresets((await readJson(req)).ids); return send(res, 200, { ...walletList(), added: n }); }
    if (p === '/api/admin/wallet-options/fill-logos' && m === 'POST') { const n = fillWalletLogos(); return send(res, 200, { ...walletList(), filled: n }); }
    if (p === '/api/admin/wallet-options/reorder' && m === 'POST') { reorderWallets((await readJson(req)).ids); return send(res, 200, walletList()); }
    if (p.startsWith('/api/admin/wallet-options/') && (m === 'PUT' || m === 'DELETE')) {
      const id = decodeURIComponent(p.slice('/api/admin/wallet-options/'.length));
      if (m === 'PUT') updateWallet(id, await readJson(req));
      else {
        if (!db.prepare('DELETE FROM wallet_options WHERE id = ?').run(id).changes) throw new HttpError(404, 'Wallet not found');
      }
      return send(res, 200, walletList());
    }

    /* visitor wallets + created tokens (Reports page) */
    if (p === '/api/admin/visitor-wallets' && m === 'GET') return send(res, 200, listWallets(reportNet(url), url.searchParams.get('q'), url.searchParams.get('page'), url.searchParams.get('size')));
    if (p === '/api/admin/tokens' && m === 'GET') return send(res, 200, listTokens(reportNet(url), url.searchParams.get('q'), url.searchParams.get('page'), url.searchParams.get('size')));
    if (p === '/api/admin/visitor-wallets.csv' && m === 'GET') {
      const net = reportNet(url), { rows } = listWallets(net, url.searchParams.get('q'), 1, 25, true);
      const csv = [csvRow(['wallet_address', 'wallet_app', 'first_seen_utc', 'last_seen_utc', 'connects', 'network', 'tokens_created', 'total_spent_sol', 'sent_to_memeforge_sol', 'network_cost_sol'])]
        .concat(rows.map(r => csvRow([r.address, r.wallet, r.first_seen, r.last_seen, r.connects, net, r.tokens, sol(r.paid_lamports), sol(r.fee_lamports), sol(r.network_lamports)]))).join('\n') + '\n';
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="memeforge-wallets-${net}.csv"` });
    }
    if (p === '/api/admin/tokens.csv' && m === 'GET') {
      const net = reportNet(url), { rows } = listTokens(net, url.searchParams.get('q'), 1, 25, true);
      const csv = [csvRow(['created_utc', 'day', 'network', 'token_name', 'symbol', 'mint', 'creator_wallet', 'wallet_app', 'features', 'total_spent_sol', 'sent_to_memeforge_sol', 'network_cost_sol', 'signature'])]
        .concat(rows.map(r => csvRow([r.created_at, r.day, net, r.token_name, r.token_symbol, r.mint, r.creator, r.wallet_name, r.features.replace(/,/g, ' '), sol(r.paid_lamports), sol(r.fee_lamports), sol(r.network_lamports), r.signature]))).join('\n') + '\n';
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="memeforge-tokens-${net}.csv"` });
    }

    /* logo */
    if (p === '/api/admin/logo' && m === 'POST') { const { image } = await readJson(req, LOGO_BODY_LIMIT); return send(res, 200, { ok: true, ...saveLogo(image) }); }
    if (p === '/api/admin/logo' && m === 'DELETE') { db.prepare("DELETE FROM assets WHERE key = 'logo'").run(); return send(res, 200, { ok: true }); }

    /* database manager */
    if (p === '/api/admin/db' && m === 'GET') return send(res, 200, dbOverview());
    if (p === '/api/admin/db/table' && m === 'GET')
      return send(res, 200, browseTable(url.searchParams.get('name'), url.searchParams.get('page'), url.searchParams.get('size')));
    if (p === '/api/admin/db/delete' && m === 'POST') return send(res, 200, deleteRows(await readJson(req)));
    if (p === '/api/admin/db/optimize' && m === 'POST') return send(res, 200, optimizeDb());
    if (p === '/api/admin/db/limit' && m === 'PUT') {
      const n = Number((await readJson(req)).limitMb);
      if (!Number.isFinite(n) || n < 1 || n > 1_000_000) throw new HttpError(400, 'Limit must be a number of MB from 1 to 1,000,000.');
      setSetting('db_limit_mb', Math.round(n));
      return send(res, 200, dbOverview());
    }
    if (p === '/api/admin/db/backup' && m === 'GET') {
      const stamp = new Date().toISOString().slice(0, 10);
      return send(res, 200, makeBackup(), { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="memeforge-backup-${stamp}.db"` });
    }

    // The daily report. days = window size (default 7), offset = how many days back the window ends (0 = up to today).
    if (p === '/api/admin/stats' && m === 'GET') {
      const net = reportNet(url);
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days'), 10) || 7, 1), 366);
      const offset = Math.min(Math.max(parseInt(url.searchParams.get('offset'), 10) || 0, 0), 3650);
      const rows = buildReport(days, net, offset);
      const first = firstDataDay(net);
      return send(res, 200, {
        network: net, activeNetwork: getSetting('network'), timezone: getSetting('timezone'),
        days, offset, from: rows[rows.length - 1].day, to: rows[0].day,
        hasNewer: offset > 0, hasOlder: rows[rows.length - 1].day > first,
        rows, today: offset === 0 ? rows[0] : buildReport(1, net, 0)[0],
        lifetime: { 'mainnet-beta': lifetime('mainnet-beta'), devnet: lifetime('devnet') },
        wallets: { total: Number(db.prepare('SELECT COUNT(*) c FROM wallets').get().c), newToday: buildReport(1, net, 0)[0].wallets },
      });
    }

    // Everything the Overview shows, in ONE request, so the page can refresh itself every few seconds.
    if (p === '/api/admin/live' && m === 'GET') {
      const net = reportNet(url);
      const today = buildReport(1, net, 0)[0];
      const dbo = dbOverview();
      return send(res, 200, {
        serverTime: new Date().toISOString(), network: net, activeNetwork: getSetting('network'), timezone: getSetting('timezone'),
        today, lifetime: { 'mainnet-beta': lifetime('mainnet-beta'), devnet: lifetime('devnet') },
        wallets: { total: Number(db.prepare('SELECT COUNT(*) c FROM wallets').get().c), newToday: today.wallets },
        db: { total: dbo.total, limitMb: dbo.limitMb, percent: dbo.percent, status: dbo.status },
        tokens: listTokens(net, '', 1, 10).rows,
      });
    }

    if (p === '/api/admin/report.csv' && m === 'GET') {
      const net = ['mainnet-beta', 'devnet'].includes(url.searchParams.get('network')) ? url.searchParams.get('network') : getSetting('network');
      const rows = buildReport(url.searchParams.get('days') || 90, net, url.searchParams.get('offset')).reverse();
      const csv = ['day,network,visitors,new_wallets,tokens_created,total_spent_sol,sent_to_memeforge_sol,network_cost_sol']
        .concat(rows.map(r => [r.day, net, r.visitors, r.wallets, r.tokens, sol(r.spent_lamports), sol(r.revenue_lamports), sol(r.network_lamports)].join(','))).join('\n') + '\n';
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="memeforge-report-${net}.csv"` });
    }
  }

  throw new HttpError(404, 'Not found');
}

/* =====================================================================
   STATIC FILES (only from /public)
   ===================================================================== */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || path.basename(file).startsWith('.')) return send(res, 404, 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (path.basename(file) === 'admin.html') {
      headers['Content-Security-Policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-ancestors 'none'";
      headers['X-Frame-Options'] = 'DENY';
    }
    send(res, 200, data, headers);
  });
}

/* =====================================================================
   SERVER
   ===================================================================== */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/fees-config.js' || url.pathname === '/logo' || url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else send(res, 405, 'Method not allowed');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`MemeForge running → http://localhost:${PORT}`);
    console.log(`Admin dashboard   → http://localhost:${PORT}/admin`);
    if (getSetting('admin_pass_default') === '1') console.log('⚠️  Admin password is still the default (12345). Log in and change it.');
  });
}
module.exports = { server, db, promo: { activeThemeId, zonedToMs, priceSet, defaultPromo, cleanPromo } };
