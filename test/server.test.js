/* End-to-end tests for server.js: payment verification, admin login, logo upload, database manager.
   Solana's RPC is faked, so no internet is needed.   Run:  npm test */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-test-'));
process.env.DB_FILE = path.join(tmp, 'test.db');       // must be set BEFORE server.js is loaded
const { server, db } = require('../server.js');

const WALLET = 'JLqXStBQFBRQnKfnGrGDFuBX8uKDJeZCGhLUqqttg3m';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const rnd = n => Array.from(crypto.randomBytes(n), b => B58[b % 58]).join('');
const day = off => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - off * 86_400_000));

let base, cookie = '';
const realFetch = global.fetch;
let rpcTx = null;                                       // what the fake Solana RPC returns
global.fetch = (url, opts) => String(url).startsWith('http://127.0.0.1')
  ? realFetch(url, opts)
  : Promise.resolve({ json: async () => ({ jsonrpc: '2.0', id: 1, result: rpcTx }) });

async function call(method, p, body, extra = {}) {
  const r = await realFetch(base + p, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: r.status, json, buf, headers: r.headers };
}

test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  db.prepare("UPDATE settings SET value = 'https://rpc.fake' WHERE key = 'rpc_url_devnet'").run();
  db.prepare("UPDATE settings SET value = 'devnet' WHERE key = 'network'").run();
});
test.after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

/* ---------------------------------------------------------------- login */
test('admin API is locked until you log in', async () => {
  assert.equal((await call('GET', '/api/admin/settings')).status, 401);
  assert.equal((await call('GET', '/api/admin/db')).status, 401);
  assert.equal((await call('POST', '/api/admin/logo', { image: 'x' })).status, 401);
});
test('wrong password is refused, the default one works and is flagged', async () => {
  assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  const r = await call('POST', '/api/admin/login', { password: '12345' });
  assert.equal(r.status, 200);
  assert.equal(r.json.passwordIsDefault, true);
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/admin/me')).json.loggedIn, true);
});

/* ---------------------------------------------------------------- payments (server side) */
const b58 = buf => {                                    // tiny base58 encoder, only for building the fake transaction
  let n = BigInt('0x' + (buf.toString('hex') || '0')), out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of buf) { if (byte === 0) out = '1' + out; else break; }
  return out;
};
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = s => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
// payerPaid = lamports the creator's wallet lost (rent + network fee + the fee sent to the fee wallet)
function fakeTx({ creator = rnd(44), mint, feeDelta = 690_872_400, err = null, age = 10, programs = [TOKEN_PROGRAM, METADATA_PROGRAM], feeAsCreator = false,
                  payerPaid = 700_000_000, name = 'Doge Moon', symbol = 'DMOON' }) {
  const payer = feeAsCreator ? WALLET : creator;
  const keys = feeAsCreator ? [WALLET, mint, ...programs] : [payer, mint, ...programs, WALLET];
  const pre = keys.map(() => 1_000_000_000), post = [...pre];
  const wi = keys.indexOf(WALLET);
  post[wi] = pre[wi] + (feeAsCreator ? -50_000 : feeDelta);
  if (!feeAsCreator) post[0] = pre[0] - payerPaid;
  const mi = keys.indexOf(METADATA_PROGRAM);
  const instructions = mi < 0 ? [] : [{ programIdIndex: mi, accounts: [], data: b58(Buffer.concat([Buffer.from([33]), str(name), str(symbol), str('https://x.test/m.json')])) }];
  return { blockTime: Math.floor(Date.now() / 1000) - age, meta: { err, fee: 5000, preBalances: pre, postBalances: post }, transaction: { message: { accountKeys: keys, instructions } } };
}
async function report(net = 'devnet') { return (await call('GET', `/api/admin/stats?days=7&network=${net}`)).json; }

test('fees-config.js is generated from the database (what the public pages read)', async () => {
  const r = await call('GET', '/fees-config.js');
  assert.match(r.buf.toString(), /^window\.MEMEFORGE_CONFIG = \{/);
  const cfg = JSON.parse(r.buf.toString().replace(/^window\.MEMEFORGE_CONFIG = /, '').replace(/;$/, ''));
  assert.equal(cfg.feeWallet, WALLET);
  assert.equal(cfg.creationFee, 0.1);
  assert.equal(cfg.featureFees.banner, 0.2);
});

test('a real token creation is recorded with the revenue the fee wallet actually received', async () => {
  const mint = rnd(44), signature = rnd(88);
  rpcTx = fakeTx({ mint });
  const r = await call('POST', '/api/token-created', { signature, mint });
  assert.equal(r.status, 200);
  assert.equal(r.json.revenue, 0.6908724);
  const s = await report();
  assert.equal(s.today.tokens, 1);
  assert.equal(s.today.revenue_lamports, 690_872_400);
  assert.equal(s.lifetime.devnet.tokens, 1);
  assert.equal(s.lifetime['mainnet-beta'].tokens, 0);   // devnet and mainnet never mix

  const again = await call('POST', '/api/token-created', { signature, mint });   // same signature again
  assert.equal(again.json.duplicate, true);
  assert.equal((await report()).today.tokens, 1);       // not counted twice
});

test('fake or unrelated transactions are rejected and never counted', async () => {
  const mint = rnd(44);
  rpcTx = fakeTx({ mint, programs: [TOKEN_PROGRAM] });                                     // no Metaplex = not a token creation
  assert.equal((await call('POST', '/api/token-created', { signature: rnd(88), mint })).status, 400);
  rpcTx = fakeTx({ mint, err: { InstructionError: [0, 'Custom'] } });                       // failed on-chain
  assert.equal((await call('POST', '/api/token-created', { signature: rnd(88), mint })).status, 400);
  rpcTx = fakeTx({ mint, age: 3600 });                                                      // an hour old
  assert.equal((await call('POST', '/api/token-created', { signature: rnd(88), mint })).status, 400);
  assert.equal((await call('POST', '/api/token-created', { signature: 'bad', mint: 'bad' })).status, 400);
  assert.equal((await report()).today.tokens, 1);                                           // still just the one real token
});

test('revenue is 0 (not negative) when the creator IS the fee wallet, e.g. you testing', async () => {
  const mint = rnd(44);
  rpcTx = fakeTx({ mint, feeAsCreator: true });
  const r = await call('POST', '/api/token-created', { signature: rnd(88), mint });
  assert.equal(r.json.revenue, 0);
  const s = await report();
  assert.equal(s.today.tokens, 2);
  assert.equal(s.today.revenue_lamports, 690_872_400);
});

/* ---------------------------------------------------------------- spent / fee / network + token names */
test('each token records what the creator spent, what went to MemeForge, the network cost and the on-chain name', async () => {
  const mint = rnd(44), creator = rnd(44), signature = rnd(88);
  rpcTx = fakeTx({ mint, creator, payerPaid: 700_000_000, name: 'Doge Moon', symbol: 'DMOON' });
  const before = (await report()).today;
  const r = await call('POST', '/api/token-created', { signature, mint, wallet: 'Phantom', features: ['banner', 'mintRevoke', 'bogus'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.paid, 0.7);
  assert.equal(r.json.network, (700_000_000 - 690_872_400) / 1e9);
  const row = db.prepare('SELECT * FROM tokens WHERE signature = ?').get(signature);
  assert.equal(row.creator, creator);
  assert.equal(row.paid_lamports, 700_000_000);
  assert.equal(row.revenue_lamports, 690_872_400);
  assert.equal(row.network_lamports, 9_127_600);
  assert.equal(row.token_name, 'Doge Moon');                    // read from the chain
  assert.equal(row.token_symbol, 'DMOON');
  assert.equal(row.wallet_name, 'Phantom');
  assert.equal(row.features, 'banner,mintRevoke');              // unknown feature names are dropped
  const s = await report();
  assert.equal(s.today.spent_lamports - before.spent_lamports, 700_000_000);
  assert.equal(s.today.network_lamports - before.network_lamports, 9_127_600);
  assert.equal(s.today.revenue_lamports - before.revenue_lamports, 690_872_400);
  assert.ok(s.lifetime.devnet.spent_lamports >= 700_000_000);
});

test('the admin token list shows everything and the creator becomes a known wallet', async () => {
  const t = (await call('GET', '/api/admin/tokens?network=devnet')).json;
  const top = t.rows[0];
  assert.equal(top.token_name, 'Doge Moon');
  assert.equal(top.paid_lamports, 700_000_000);
  assert.equal(top.fee_lamports, 690_872_400);
  const w = (await call('GET', '/api/admin/visitor-wallets?network=devnet')).json;
  const me = w.rows.find(r => r.address === top.creator);
  assert.ok(me, 'creator is listed as a wallet');
  assert.equal(me.tokens, 1); assert.equal(me.paid_lamports, 700_000_000); assert.equal(me.wallet, 'Phantom');
  assert.equal((await call('GET', '/api/admin/tokens?network=devnet&q=' + top.creator.slice(0, 8))).json.total, 1);
  assert.equal((await call('GET', '/api/admin/tokens?network=devnet&q=zzzzzzzz')).json.total, 0);
});

test('wallet connect pings are recorded once per address and validated', async () => {
  const a = rnd(44);
  assert.equal((await call('POST', '/api/wallet-connected', { address: 'not-an-address' })).status, 400);
  assert.equal((await call('POST', '/api/wallet-connected', { address: a, wallet: 'Solflare' })).status, 204);
  assert.equal((await call('POST', '/api/wallet-connected', { address: a, wallet: '' })).status, 204);     // again: counts a connect, keeps the app name
  const row = db.prepare('SELECT * FROM wallets WHERE address = ?').get(a);
  assert.equal(row.connects, 2); assert.equal(row.wallet, 'Solflare');
  const s = await report();
  assert.ok(s.wallets.total >= 2); assert.ok(s.today.wallets >= 2);                                       // new wallets today
});

test('CSV exports defuse spreadsheet formulas in token names', async () => {
  const mint = rnd(44);
  rpcTx = fakeTx({ mint, name: '=HYPERLINK("http://evil","x")', symbol: '+SUM' });
  assert.equal((await call('POST', '/api/token-created', { signature: rnd(88), mint })).status, 200);
  const csv = (await call('GET', '/api/admin/tokens.csv?network=devnet')).buf.toString();
  assert.ok(csv.startsWith('created_utc,day,network,token_name'));
  assert.ok(!/(^|,)=HYPERLINK/.test(csv) && csv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), csv);
  assert.ok(csv.includes(",'+SUM,"));
  const w = (await call('GET', '/api/admin/visitor-wallets.csv?network=devnet')).buf.toString();
  assert.ok(w.startsWith('wallet_address,wallet_app'));
  const d = (await call('GET', '/api/admin/report.csv?days=3&network=devnet')).buf.toString();
  assert.ok(d.startsWith('day,network,visitors,new_wallets,tokens_created,total_spent_sol,sent_to_memeforge_sol,network_cost_sol'));
});

/* ---------------------------------------------------------------- wallet list (admin → Wallets) */
const walletCfg = async () => JSON.parse((await call('GET', '/fees-config.js')).buf.toString().replace(/^window\.MEMEFORGE_CONFIG = /, '').replace(/;$/, '')).wallets;

test('wallet list: starts with the 11 top wallets (Phantom, Solflare, Backpack first) and is served to the public page', async () => {
  const cfg = await walletCfg();
  assert.deepEqual(cfg.slice(0, 3).map(w => w.name), ['Phantom', 'Solflare', 'Backpack']);
  assert.equal(cfg.length, 11);
  assert.equal(cfg[0].provider, 'phantom.solana'); assert.equal(cfg[0].flag, 'isPhantom');
  const adm = (await call('GET', '/api/admin/wallet-options')).json;
  assert.equal(adm.wallets.length, 11); assert.ok(adm.presets.length >= 130, 'catalog has 130+ wallets');
  assert.ok(adm.presets.every(p => p.id && p.name && p.cat));
});
test('wallet catalog: add selected / add all, skipping ones already there', async () => {
  const before = (await call('GET', '/api/admin/wallet-options')).json.wallets.length;
  const one = await call('POST', '/api/admin/wallet-options/add-presets', { ids: ['glow', 'phantom'] });   // phantom already exists
  assert.equal(one.status, 200); assert.equal(one.json.added, 1); assert.equal(one.json.wallets.length, before + 1);
  assert.equal((await call('POST', '/api/admin/wallet-options/add-presets', { ids: ['nope'] })).status, 400);
  const all = await call('POST', '/api/admin/wallet-options/add-presets', { ids: 'all' });
  assert.equal(all.json.wallets.length, all.json.presets.length, 'every catalog wallet is now on the list');
  assert.ok(all.json.wallets.length >= 130);
  assert.ok((await walletCfg()).length >= 130, 'visitors get them all (the popup has a search box)');
  // put the list back to the 11 defaults for the next tests
  for (const w of all.json.wallets.slice(11)) await call('DELETE', '/api/admin/wallet-options/' + encodeURIComponent(w.id));
  assert.equal((await walletCfg()).length, 11);
});
test('wallet list: add with a logo link, edit, hide, reorder, delete', async () => {
  const add = await call('POST', '/api/admin/wallet-options', { name: 'Test Wallet', logoUrl: 'https://cdn.example.com/test.png', provider: 'okxwallet.solana', installUrl: 'https://www.okx.com/web3', color: '#222222' });
  assert.equal(add.status, 200);
  const okx = add.json.wallets.find(w => w.name === 'Test Wallet');
  assert.equal(okx.id, 'test-wallet'); assert.equal(okx.logoUrl, 'https://cdn.example.com/test.png'); assert.equal(okx.enabled, true);
  assert.equal((await walletCfg()).find(w => w.id === 'test-wallet').logo, 'https://cdn.example.com/test.png');

  assert.equal((await call('PUT', '/api/admin/wallet-options/test-wallet', { ...okx, name: 'OKX', enabled: false })).status, 200);
  assert.ok(!(await walletCfg()).some(w => w.id === 'test-wallet'), 'hidden wallets are not sent to the public page');

  const ids = (await call('GET', '/api/admin/wallet-options')).json.wallets.map(w => w.id);
  const reordered = ['test-wallet', ...ids.filter(i => i !== 'test-wallet')];
  assert.deepEqual((await call('POST', '/api/admin/wallet-options/reorder', { ids: reordered })).json.wallets.map(w => w.id), reordered);
  assert.equal((await call('POST', '/api/admin/wallet-options/reorder', { ids: ['phantom'] })).status, 400);

  assert.equal((await call('DELETE', '/api/admin/wallet-options/test-wallet')).status, 200);
  assert.equal((await call('DELETE', '/api/admin/wallet-options/test-wallet')).status, 404);
  assert.ok(!(await walletCfg()).some(w => w.id === 'test-wallet'));
});
test('wallet list: unsafe or malformed input is refused', async () => {
  const bad = b => call('POST', '/api/admin/wallet-options', { name: 'X', ...b });
  assert.equal((await bad({ name: '' })).status, 400);
  assert.equal((await bad({ logoUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await bad({ logoUrl: 'http://insecure.example/x.png' })).status, 400);
  assert.equal((await bad({ logoUrl: 'https://a.example/x y.png' })).status, 400);
  assert.equal((await bad({ installUrl: 'data:text/html,hi' })).status, 400);
  assert.equal((await bad({ provider: 'window.__proto__.x' })).status, 400);
  assert.equal((await bad({ provider: 'a.constructor' })).status, 400);
  assert.equal((await bad({ provider: 'alert(1)' })).status, 400);
  assert.equal((await bad({ flag: 'is Bad' })).status, 400);
  assert.equal((await bad({ deeplink: 'https://w.example/open?x=1' })).status, 400);       // must contain {url}
  assert.equal((await bad({ color: 'red' })).status, 400);
  assert.equal((await call('POST', '/api/admin/wallet-options', { name: 'Ok', deeplink: 'https://w.example/open?u={url}', provider: 'ok.solana' })).status, 200);
  assert.equal((await call('GET', '/api/admin/wallet-options')).json.wallets.at(-1).id, 'ok');
  await call('DELETE', '/api/admin/wallet-options/ok');
});
test('wallet list: the admin API is locked and logo links are allowed by the admin page policy', async () => {
  const saved = cookie; cookie = '';
  assert.equal((await call('GET', '/api/admin/wallet-options')).status, 401);
  assert.equal((await call('POST', '/api/wallet-connected', { address: rnd(44) })).status, 204);   // the public ping needs no login
  cookie = saved;
  const r = await realFetch(base + '/admin');
  assert.match(r.headers.get('content-security-policy'), /img-src [^;]*https:/);
});

/* ---------------------------------------------------------------- logo */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

test('no logo yet -> /logo is 404 (the page then shows the default rocket)', async () => {
  assert.equal((await call('GET', '/logo')).status, 404);
});
test('logo upload: a real PNG is stored and served with caching headers', async () => {
  const up = await call('POST', '/api/admin/logo', { image: dataUrl(PNG) });
  assert.equal(up.status, 200); assert.equal(up.json.mime, 'image/png');
  const g = await call('GET', '/logo');
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('content-type'), 'image/png');
  assert.deepEqual(g.buf, PNG);
  const etag = g.headers.get('etag');
  assert.equal((await call('GET', '/logo', undefined, { 'if-none-match': etag })).status, 304);
});
test('logo upload: SVG, fake images and oversized files are refused', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await call('POST', '/api/admin/logo', { image: dataUrl(svg, 'image/svg+xml') })).status, 400);
  assert.equal((await call('POST', '/api/admin/logo', { image: dataUrl(Buffer.from('<html>not an image</html>'), 'image/png') })).status, 400);   // lies about its type
  assert.equal((await call('POST', '/api/admin/logo', { image: 'hello' })).status, 400);
  const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
  assert.equal((await call('POST', '/api/admin/logo', { image: dataUrl(big) })).status, 413);
  assert.deepEqual((await call('GET', '/logo')).buf, PNG);     // the good logo is untouched
});
test('logo can be removed', async () => {
  assert.equal((await call('DELETE', '/api/admin/logo')).status, 200);
  assert.equal((await call('GET', '/logo')).status, 404);
});

/* ---------------------------------------------------------------- database manager */
test('database overview: size, limit, status and every table', async () => {
  const o = (await call('GET', '/api/admin/db')).json;
  assert.ok(o.total > 0);
  assert.equal(o.limitMb, 100);
  assert.equal(o.status, 'ok');
  assert.deepEqual(o.tables.map(t => t.name), ['visits', 'tokens', 'wallets', 'daily_stats', 'daily_visitors', 'wallet_options', 'fees', 'settings']);
  assert.equal(o.tables.find(t => t.name === 'tokens').rows, db.prepare('SELECT COUNT(*) c FROM tokens').get().c);
  assert.equal(o.tables.find(t => t.name === 'settings').deletable, false);
});
test('browsing hides the admin password hash and rejects unknown tables', async () => {
  const s = (await call('GET', '/api/admin/db/table?name=settings')).json;
  const row = s.rows.find(r => r.key === 'admin_pass_hash');
  assert.ok(row); assert.equal(row.value, '••••••••');
  assert.equal((await call('GET', '/api/admin/db/table?name=sqlite_master')).status, 400);
  assert.equal((await call('GET', '/api/admin/db/table?name=visits";DROP TABLE fees;--')).status, 400);
});
test('limit setting is validated; a full database reports "warn" / "over"', async () => {
  assert.equal((await call('PUT', '/api/admin/db/limit', { limitMb: 0 })).status, 400);
  assert.equal((await call('PUT', '/api/admin/db/limit', { limitMb: 'x' })).status, 400);
  assert.equal((await call('PUT', '/api/admin/db/limit', { limitMb: 1 })).json.limitMb, 1);
  const ins = db.prepare('INSERT OR IGNORE INTO visits(day, visitor) VALUES (?, ?)');
  db.exec('BEGIN'); for (let i = 0; i < 40_000; i++) ins.run('2019-01-01', crypto.randomBytes(16).toString('hex')); db.exec('COMMIT');
  const o = (await call('GET', '/api/admin/db')).json;
  assert.ok(['warn', 'over'].includes(o.status), 'status was ' + o.status + ' at ' + o.percent + '%');
});

test('deleting old visits keeps the report history (visitor totals are rolled up first) and never touches today', async () => {
  const ins = db.prepare('INSERT OR IGNORE INTO visits(day, visitor) VALUES (?, ?)');
  const old = day(40), today = day(0);
  for (let i = 0; i < 7; i++) ins.run(old, 'old' + i);
  for (let i = 0; i < 3; i++) ins.run(today, 'today' + i);
  const before = await call('GET', '/api/admin/stats?days=90&network=devnet');
  const oldBefore = before.json.rows.find(r => r.day === old).visitors;
  assert.equal(oldBefore, 7);

  const dry = await call('POST', '/api/admin/db/delete', { table: 'visits', mode: 'older', days: 30, dryRun: true });
  assert.equal(dry.json.count, 40_000 + 7);                 // shows the exact number before you confirm
  assert.equal(db.prepare('SELECT COUNT(*) c FROM visits').get().c, 40_010);   // dry run deleted nothing

  const del = await call('POST', '/api/admin/db/delete', { table: 'visits', mode: 'older', days: 30, optimize: true });
  assert.equal(del.json.deleted, 40_007);
  assert.ok(del.json.shrink.after < del.json.shrink.before, 'optimize should shrink the file');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM visits').get().c, 3);         // only today's rows are left

  const after = await call('GET', '/api/admin/stats?days=90&network=devnet');
  assert.equal(after.json.rows.find(r => r.day === old).visitors, 7);           // history survived the purge
  assert.equal(after.json.rows.find(r => r.day === today).visitors, 3 + 0);     // today untouched, not double counted
});

test('safety rules: protected tables, bad input and per-row rules', async () => {
  const del = b => call('POST', '/api/admin/db/delete', b);
  assert.equal((await del({ table: 'settings', mode: 'older', days: 0 })).status, 403);
  assert.equal((await del({ table: 'fees', mode: 'ids', ids: [1] })).status, 403);
  assert.equal((await del({ table: 'sqlite_master', mode: 'older', days: 0 })).status, 403);
  assert.equal((await del({ table: 'visits', mode: 'ids', ids: [1] })).status, 400);       // visits: by age only
  assert.equal((await del({ table: 'visits', mode: 'older', days: -1 })).status, 400);
  assert.equal((await del({ table: 'visits', mode: 'older', days: '1; DROP TABLE x' })).status, 400);
  assert.equal((await del({ table: 'tokens', mode: 'ids', ids: ['1 OR 1=1'] })).status, 400);
  assert.equal((await del({ table: 'tokens', mode: 'ids', ids: [] })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM fees').get().c, 7);
});

test('visitor wallets can be removed by selection only (not by age); wallet_options are protected here', async () => {
  const del = b => call('POST', '/api/admin/db/delete', b);
  assert.equal((await del({ table: 'wallets', mode: 'older', days: 0 })).status, 400);
  assert.equal((await del({ table: 'wallet_options', mode: 'ids', ids: [1] })).status, 403);
  const list = (await call('GET', '/api/admin/db/table?name=wallets')).json;
  assert.equal(list.byIds, true); assert.equal(list.byAge, false);
  const before = db.prepare('SELECT COUNT(*) c FROM wallets').get().c;
  assert.equal((await del({ table: 'wallets', mode: 'ids', ids: [list.rows[0]._id] })).json.deleted, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM wallets').get().c, before - 1);
});

test('deleting selected tokens removes only those rows and leaves report revenue alone', async () => {
  const list = (await call('GET', '/api/admin/db/table?name=tokens')).json;
  assert.equal(list.byIds, true);
  const id = list.rows[0]._id;
  const count = () => db.prepare('SELECT COUNT(*) c FROM tokens').get().c;
  const n = count(), revenue = (await report()).today.revenue_lamports;
  const r = await call('POST', '/api/admin/db/delete', { table: 'tokens', mode: 'ids', ids: [id] });
  assert.equal(r.json.deleted, 1);
  assert.equal(count(), n - 1);
  assert.equal((await report()).today.revenue_lamports, revenue);          // revenue report unchanged
});

test('backup downloads a real, openable SQLite file', async () => {
  const b = await call('GET', '/api/admin/db/backup');
  assert.equal(b.status, 200);
  assert.match(b.headers.get('content-disposition'), /memeforge-backup-\d{4}-\d{2}-\d{2}\.db/);
  assert.equal(b.buf.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  const f = path.join(tmp, 'restored.db'); fs.writeFileSync(f, b.buf);
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(f);
  assert.equal(copy.prepare('SELECT COUNT(*) c FROM tokens').get().c, db.prepare('SELECT COUNT(*) c FROM tokens').get().c);
  copy.close();
});

test('password change works and clears the "default password" warning', async () => {
  assert.equal((await call('POST', '/api/admin/password', { current: 'wrong', next: 'abcdef' })).status, 403);
  assert.equal((await call('POST', '/api/admin/password', { current: '12345', next: 'abc' })).status, 400);
  assert.equal((await call('POST', '/api/admin/password', { current: '12345', next: 'abcdef' })).status, 200);
  assert.equal((await call('GET', '/api/admin/settings')).json.passwordIsDefault, false);
});

test('daily report: 7-day pages, Previous/Next via offset, and the live overview endpoint', async () => {
  const cur = (await call('GET', '/api/admin/stats?network=devnet')).json;           // default = 7 days
  assert.equal(cur.rows.length, 7); assert.equal(cur.offset, 0); assert.equal(cur.hasNewer, false);
  const prev = (await call('GET', '/api/admin/stats?days=7&offset=7&network=devnet')).json;
  assert.equal(prev.rows.length, 7); assert.equal(prev.hasNewer, true);
  assert.equal(prev.rows[0].day, day(7)); assert.equal(prev.rows[6].day, day(13));
  assert.equal(prev.today.day, day(0), 'today stays today when paging back');
  assert.equal(cur.rows[6].day, day(6));
  assert.equal((await call('GET', '/api/admin/report.csv?days=7&offset=7&network=devnet')).buf.toString().split('\n')[1].split(',')[0], day(13));
  const live = (await call('GET', '/api/admin/live?network=devnet')).json;
  assert.equal(live.today.day, day(0)); assert.ok(live.db.limitMb > 0); assert.ok(Array.isArray(live.tokens) && live.tokens.length <= 10);
  assert.ok(live.lifetime.devnet && live.wallets.total >= 0);
  assert.equal((await new Promise(r => { const rq = require('node:http').get(base + '/api/admin/live', x => r(x.statusCode)); })).valueOf(), 401);
});

test('RPC endpoint and revenue wallet are separate for mainnet and devnet', async () => {
  const s0 = (await call('GET', '/api/admin/settings')).json;
  assert.equal(s0.network, 'devnet'); assert.equal(s0.rpcUrls.devnet, 'https://rpc.fake'); assert.equal(s0.rpcUrls['mainnet-beta'], '');
  assert.equal(s0.feeWallets.devnet, WALLET); assert.equal(s0.feeWallets['mainnet-beta'], WALLET);
  const MAIN = 'So11111111111111111111111111111111111111112';
  const save = body => call('PUT', '/api/admin/settings', { network: 'devnet', timezone: s0.timezone, fees: {}, ...body });
  assert.equal((await save({ feeWallets: { 'mainnet-beta': 'nope', devnet: WALLET } })).status, 400);
  assert.equal((await save({ rpcUrls: { 'mainnet-beta': 'ftp://x', devnet: '' } })).status, 400);
  assert.equal((await save({ rpcUrls: { 'mainnet-beta': 'https://main.rpc', devnet: 'https://dev.rpc' }, feeWallets: { 'mainnet-beta': MAIN, devnet: WALLET } })).status, 200);
  const s1 = (await call('GET', '/api/admin/settings')).json;
  assert.deepEqual(s1.rpcUrls, { 'mainnet-beta': 'https://main.rpc', devnet: 'https://dev.rpc' });
  assert.deepEqual(s1.feeWallets, { 'mainnet-beta': MAIN, devnet: WALLET });
  const pub = async () => JSON.parse((await call('GET', '/fees-config.js')).buf.toString().replace(/^window\.MEMEFORGE_CONFIG = /, '').replace(/;$/, ''));
  let cfg = await pub(); assert.equal(cfg.rpcUrl, 'https://dev.rpc'); assert.equal(cfg.feeWallet, WALLET);   // devnet is active
  assert.equal((await save({ network: 'mainnet-beta' })).status, 200);
  cfg = await pub(); assert.equal(cfg.rpcUrl, 'https://main.rpc'); assert.equal(cfg.feeWallet, MAIN);       // switching network switches both
  // restore for the other tests
  assert.equal((await save({ network: 'devnet', rpcUrls: { 'mainnet-beta': '', devnet: 'https://rpc.fake' }, feeWallets: { 'mainnet-beta': WALLET, devnet: WALLET } })).status, 200);
});

test('every wallet gets its original logo link, and "fill missing logos" only touches empty ones', async () => {
  const list = (await call('GET', '/api/admin/wallet-options')).json;
  assert.ok(list.wallets.length > 0);
  assert.ok(list.wallets.every(w => /^https:\/\//.test(w.logoUrl)), 'seeded wallets have a logo link');
  assert.ok(list.presets.every(p => /^https:\/\//.test(p.logoUrl)), 'every catalog wallet has a logo link');
  const w = list.wallets[0];
  await call('PUT', '/api/admin/wallet-options/' + encodeURIComponent(w.id), { ...w, logoUrl: '' });
  const keep = list.wallets[1];
  await call('PUT', '/api/admin/wallet-options/' + encodeURIComponent(keep.id), { ...keep, logoUrl: 'https://example.com/mine.png' });
  const r = (await call('POST', '/api/admin/wallet-options/fill-logos', {})).json;
  assert.equal(r.filled, 1);
  assert.equal(r.wallets.find(x => x.id === w.id).logoUrl, list.wallets[0].logoUrl);
  assert.equal(r.wallets.find(x => x.id === keep.id).logoUrl, 'https://example.com/mine.png');
});
