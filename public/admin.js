/* MemeForge admin dashboard — talks to /api/admin/* (see server.js).
   Everything is drawn with textContent / DOM nodes, never innerHTML with data. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const LAMPORTS = 1e9;
  const sol = l => (l / LAMPORTS).toFixed(4).replace(/\.?0+$/, '') || '0';
  const bytesTxt = n => {
    if (n == null) return '–';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i];
  };
  const num = n => Number(n).toLocaleString();

  async function api(path, opts = {}) {
    const stop = busyStart();
    try {
      let res;
      try {
        res = await fetch(path, {
          credentials: 'same-origin',
          ...opts,
          headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
      } catch { throw new Error('Cannot reach the server. Check your connection.'); }
      let data = null;
      try { data = await res.json(); } catch { /* csv / empty */ }
      if (res.status === 401 && path !== '/api/admin/login') { showLogin(); throw new Error('Please log in again.'); }
      if (!res.ok) throw new Error(data?.error || 'Request failed');
      return data;
    } finally { stop(); }
  }
  function say(el, text, ok) { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); }

  /* ---------- toasts (success / error / info) ---------- */
  const ICON = { ok: '#ic-check', err: '#ic-alert', info: '#ic-info' };
  function toast(title, type = 'ok', detail = '', ms) {
    const box = $('toasts'); if (!box) return;
    ms = ms || (type === 'err' ? 7000 : 4200);
    const t = document.createElement('div'); t.className = 'toast ' + type; t.setAttribute('role', type === 'err' ? 'alert' : 'status');
    const ic = document.createElement('div'); ic.className = 'ti';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'i');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', ICON[type]); svg.appendChild(use); ic.appendChild(svg);
    const tb = document.createElement('div'); tb.className = 'tb';
    const b = document.createElement('b'); b.textContent = title; tb.appendChild(b);
    if (detail) { const d = document.createElement('span'); d.textContent = detail; tb.appendChild(d); }
    const x = document.createElement('button'); x.type = 'button'; x.className = 'tx'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×';
    const bar = document.createElement('div'); bar.className = 'tt'; bar.style.animationDuration = ms + 'ms';
    t.append(ic, tb, x, bar);
    let timer;
    const close = () => { clearTimeout(timer); t.classList.add('out'); setTimeout(() => t.remove(), 220); };
    x.addEventListener('click', close);
    t.addEventListener('mouseenter', () => { clearTimeout(timer); bar.style.animationPlayState = 'paused'; });
    t.addEventListener('mouseleave', () => { bar.style.animationPlayState = 'running'; timer = setTimeout(close, 1800); });
    box.appendChild(t);
    while (box.children.length > 4) box.firstChild.remove();
    timer = setTimeout(close, ms);
  }
  // inline message + toast together
  const done = (el, text, detail) => { if (el) say(el, text, true); toast(text.replace(/^✅\s*/, ''), 'ok', detail); };
  const fail = (el, err) => { const m = err?.message || String(err); if (el) say(el, m, false); toast(m, 'err'); };

  /* ---------- thin bar at the very top while the server is busy (only if it takes longer than 0.35 s) ---------- */
  let busyN = 0, busyTimer = null;
  function busyStart() {
    if (busyN++ === 0) busyTimer = setTimeout(() => $('topProg').classList.add('on'), 350);
    let ended = false;
    return () => { if (ended) return; ended = true; if (--busyN === 0) { clearTimeout(busyTimer); $('topProg').classList.remove('on'); } };
  }

  /* ---------- progress panel: real percent, or an animated bar when the size is unknown ---------- */
  function progress(ids) {
    const box = $(ids.box), fill = $(ids.fill), txt = $(ids.txt), pct = $(ids.pct);
    let hideT;
    const api = {
      start(text) { clearTimeout(hideT); box.hidden = false; box.className = 'prog ind'; fill.style.width = ''; txt.textContent = text; pct.textContent = ''; },
      set(frac, text) {
        box.className = 'prog'; fill.style.width = Math.round(frac * 100) + '%'; pct.textContent = Math.round(frac * 100) + '%'; if (text) txt.textContent = text;
      },
      wait(text) { box.className = 'prog ind'; fill.style.width = ''; pct.textContent = ''; txt.textContent = text; },
      finish(text) { box.className = 'prog done'; fill.style.width = '100%'; pct.textContent = '100%'; txt.textContent = text; hideT = setTimeout(() => { box.hidden = true; }, 2500); },
      error(text) { box.className = 'prog fail'; fill.style.width = '100%'; pct.textContent = ''; txt.textContent = text; hideT = setTimeout(() => { box.hidden = true; }, 6000); },
      hide() { clearTimeout(hideT); box.hidden = true; },
    };
    return api;
  }
  const logoProg = progress({ box: 'logoProg', fill: 'logoProgFill', txt: 'logoProgTxt', pct: 'logoProgPct' });
  const dbProg = progress({ box: 'dbProg', fill: 'dbProgFill', txt: 'dbProgTxt', pct: 'dbProgPct' });

  // POST JSON with real upload progress (fetch cannot report that, XMLHttpRequest can).
  function uploadJson(path, body, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', path); x.withCredentials = true; x.setRequestHeader('Content-Type', 'application/json');
      x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      x.upload.onload = () => onProgress(-1, -1);                    // all bytes sent, the server is now working
      x.onerror = () => reject(new Error('Network error. Check your connection and try again.'));
      x.onabort = () => reject(new Error('Upload cancelled.'));
      x.onload = () => {
        let d = null; try { d = JSON.parse(x.responseText); } catch { /* empty */ }
        if (x.status === 401) { showLogin(); return reject(new Error('Please log in again.')); }
        if (x.status >= 200 && x.status < 300) resolve(d); else reject(new Error(d?.error || 'Upload failed'));
      };
      x.send(JSON.stringify(body));
    });
  }

  /* ---------- logo (uploaded image or the default rocket) ---------- */
  let hasLogo = false;
  function applyLogo() {
    const probe = new Image();
    probe.onload = () => setLogo(true);
    probe.onerror = () => setLogo(false);
    probe.src = '/logo?v=' + Date.now();             // server ignores the query; it just defeats the browser cache
  }
  function setLogo(on) {
    hasLogo = on;
    document.querySelectorAll('[data-logo]').forEach(box => {
      const img = box.querySelector('img'), svg = box.querySelector('svg');
      if (on) img.src = '/logo?v=' + Date.now();
      img.hidden = !on; svg.style.display = on ? 'none' : '';
      box.classList.toggle('has-img', on);
    });
    $('logoRemove').hidden = !on;
    let fav = document.querySelector('link[rel="icon"]');
    if (on) { if (!fav) { fav = document.createElement('link'); fav.rel = 'icon'; document.head.appendChild(fav); } fav.href = '/logo?v=' + Date.now(); }
    else if (fav) fav.remove();
  }

  /* ---------- views ---------- */
  function showLogin() { liveStop(); $('dashView').hidden = true; $('loginView').hidden = false; $('pw').value = ''; $('pw').focus(); }
  async function showDash() {
    $('loginView').hidden = true; $('dashView').hidden = false;
    await loadTheme().catch(() => {});
    await loadSettings(); await loadStats(); await loadDb();
    const page = location.hash.slice(1);
    liveStart();
    if (page === 'reports') loadReportLists(); else if (page === 'wallets') loadWalletOptions().catch(() => {});
    else if (page === 'promo') loadPromo().catch(e => toast('Could not load themes & offers', 'err', e.message));   // refreshing on this page must show the saved settings
  }

  /* ---------- login / logout ---------- */
  const pw = $('pw');
  $('pwReveal').addEventListener('click', () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    $('pwReveal').setAttribute('aria-pressed', String(show));
    $('pwReveal').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    $('pwEye').setAttribute('href', show ? '#ic-eyeoff' : '#ic-eye');
    pw.focus();
  });
  const caps = e => { if (e.getModifierState) $('capsHint').hidden = !e.getModifierState('CapsLock'); };
  pw.addEventListener('keydown', caps); pw.addEventListener('keyup', caps);
  pw.addEventListener('blur', () => { $('capsHint').hidden = true; });

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('loginBtn');
    btn.disabled = true; btn.classList.add('loading'); $('loginBtnTxt').textContent = 'Signing in…'; $('loginMsg').textContent = '';
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: { password: pw.value } });
      if (r.passwordIsDefault) location.hash = '#security';          // first run: go straight to "change password"
      await showDash();
    } catch (err) {
      say($('loginMsg'), err.message, false);
      const card = $('loginCard'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      pw.select();
    } finally {
      btn.disabled = false; btn.classList.remove('loading'); $('loginBtnTxt').textContent = 'Sign in';
    }
  });
  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
    showLogin();
  });

  /* ---------- settings ---------- */
  let feeKeys = [];
  let saved = { net: '', wallets: {}, state: '' };            // what is stored on the server right now
  const NETN = { 'mainnet-beta': 'Mainnet', devnet: 'Devnet' };
  const PUBLIC_RPC = { 'mainnet-beta': 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com' };
  const GENESIS = { 'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' };   // how we tell the two networks apart
  const FIELDS = { 'mainnet-beta': { rpc: 'sRpcMain', wallet: 'sWalletMain', stRpc: 'stRpcMain', stWallet: 'stWalletMain', test: 'testMain' },
                   devnet:         { rpc: 'sRpcDev',  wallet: 'sWalletDev',  stRpc: 'stRpcDev',  stWallet: 'stWalletDev',  test: 'testDev' } };
  const looksLikeAddress = a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  const FEE_META = {
    creation:     { g: 'base',  t: 'Token creation',                        h: 'Charged on every token a visitor creates. This is your base price.' },
    banner:       { g: 'extra', t: 'Token banner',                          h: 'Added only if the visitor adds a banner image to their token.' },
    social:       { g: 'extra', t: 'Social links',                          h: 'Added only if the visitor adds website, X or Telegram links.' },
    creator:      { g: 'extra', t: 'Creator info',                          h: 'Added only if the visitor adds creator details.' },
    mintRevoke:   { g: 'lock',  t: 'Lock the supply (revoke mint)',         h: 'Added only if the visitor makes it impossible to ever create more of the token.' },
    freezeRevoke: { g: 'lock',  t: 'Remove freeze power (revoke freeze)',   h: 'Added only if the visitor gives up the power to freeze other people’s tokens.' },
    metaRevoke:   { g: 'lock',  t: 'Make details permanent (revoke update)', h: 'Added only if the visitor makes the name, logo and links impossible to change later.' },
  };
  const FEE_GROUPS = [['base', 'Base price', 'Every token pays this.'], ['extra', 'Optional extras', 'Added to the price only when the visitor turns that extra on.'], ['lock', 'Safety locks', 'Added when the visitor makes their token safer for buyers.']];
  const sol4 = n => String(Number((Number(n) || 0).toFixed(4)));

  function buildFees(fees) {
    const box = $('feeGroups'); box.textContent = ''; feeKeys = [];
    const by = { base: [], extra: [], lock: [] };
    for (const f of fees) { feeKeys.push(f.key); (by[FEE_META[f.key]?.g] || by.extra).push(f); }
    for (const [g, title, desc] of FEE_GROUPS) {
      if (!by[g].length) continue;
      const wrap = document.createElement('div'); wrap.className = 'feegroup';
      const h = document.createElement('div'); h.className = 'fg-head'; const hb = document.createElement('b'); hb.textContent = title; const hs = document.createElement('span'); hs.textContent = desc; h.append(hb, hs);
      const grid = document.createElement('div'); grid.className = 'feegrid';
      for (const f of by[g]) {
        const m = FEE_META[f.key] || { t: f.label, h: '' };
        const item = document.createElement('div'); item.className = 'feeitem';
        const lab = document.createElement('label'); lab.htmlFor = 'fee_' + f.key; lab.textContent = m.t;
        const help = document.createElement('p'); help.className = 'help'; help.textContent = m.h;
        const row = document.createElement('div'); row.className = 'sufx';
        const inp = document.createElement('input'); inp.id = 'fee_' + f.key; inp.type = 'number'; inp.min = '0'; inp.max = '1000'; inp.step = '0.001'; inp.inputMode = 'decimal'; inp.value = f.amount;
        const unit = document.createElement('span'); unit.className = 'unit'; unit.textContent = 'SOL';
        const free = document.createElement('span'); free.className = 'freepill'; free.textContent = 'Free'; free.id = 'free_' + f.key;
        row.append(inp, unit, free); item.append(lab, help, row); grid.appendChild(item);
      }
      wrap.append(h, grid); box.appendChild(wrap);
    }
  }
  const settingsState = () => JSON.stringify([$('sNet').value, $('sTz').value.trim(), $('sRpcMain').value.trim(), $('sWalletMain').value.trim(), $('sRpcDev').value.trim(), $('sWalletDev').value.trim(), feeKeys.map(k => $('fee_' + k).value)]);
  function statusLine(el, kind, text) { el.className = 'status' + (kind ? ' ' + kind : ''); el.textContent = text; }
  function refreshSettingsUI() {
    const net = $('sNet').value;
    // field hints
    for (const n of Object.keys(FIELDS)) {
      const f = FIELDS[n], rpc = $(f.rpc).value.trim(), w = $(f.wallet).value.trim();
      if (!rpc) statusLine($(f.stRpc), 'info', `Using Solana’s free public ${NETN[n]} connection.`);
      else if (!/^https?:\/\/\S+$/i.test(rpc)) statusLine($(f.stRpc), 'bad', 'This should start with https:// (or leave it empty).');
      else statusLine($(f.stRpc), 'ok', 'Custom connection. Use “Test connection” to check it.');
      if (!w) statusLine($(f.stWallet), 'bad', 'Required. Paste your Solana wallet address.');
      else if (!looksLikeAddress(w)) statusLine($(f.stWallet), 'bad', 'This does not look like a Solana wallet address (32 to 44 letters and numbers).');
      else statusLine($(f.stWallet), 'ok', 'Looks valid: ' + shortAddr(w));
      $(f.rpc).classList.toggle('invalid', !!rpc && !/^https?:\/\/\S+$/i.test(rpc));
      $(f.wallet).classList.toggle('invalid', !w || !looksLikeAddress(w));
    }
    // summary tiles (they follow what is typed; the bar below says if it is saved)
    const f = FIELDS[net], w = $(f.wallet).value.trim();
    $('sumNet').textContent = NETN[net]; $('sumNet').className = net === 'devnet' ? 'sdev' : 'smain';
    $('sumNetSub').textContent = (net === 'devnet' ? 'Test SOL, no real money' : 'Real SOL, real revenue') + (saved.net && net !== saved.net ? ' · not saved yet' : '');
    $('sumWallet').textContent = looksLikeAddress(w) ? shortAddr(w) : 'Not set'; $('sumWalletSub').textContent = `on ${NETN[net]}` + (looksLikeAddress(w) && w !== saved.wallets[net] ? ' · not saved yet' : '');
    const vals = feeKeys.map(k => Number($('fee_' + k).value) || 0), base = Number($('fee_creation')?.value) || 0, all = vals.reduce((a, b) => a + b, 0);
    $('sumPrice').textContent = sol4(base) + ' SOL'; $('sumPriceSub').textContent = all > base ? `up to ${sol4(all)} SOL with every extra` : 'no paid extras set';
    feeKeys.forEach(k => { const v = $('fee_' + k).value; $('free_' + k).hidden = !(v !== '' && Number(v) === 0); $('fee_' + k).classList.toggle('invalid', v === '' || !(Number(v) >= 0) || Number(v) > 1000); });
    // save bar
    const dirty = settingsState() !== saved.state, bar = $('saveBar');
    bar.classList.toggle('dirty', dirty); $('setSave').disabled = !dirty; $('setDiscard').disabled = !dirty;
    $('saveTxt').lastChild.textContent = dirty ? 'You have unsaved changes' : 'All changes saved';
    paintNetPicks();
  }
  async function loadSettings() {
    const s = await api('/api/admin/settings');
    $('sNet').value = s.network; $('sTz').value = s.timezone;
    $('sRpcMain').value = s.rpcUrls['mainnet-beta']; $('sRpcDev').value = s.rpcUrls.devnet;
    $('sWalletMain').value = s.feeWallets['mainnet-beta']; $('sWalletDev').value = s.feeWallets.devnet;
    $('pwWarn').hidden = !s.passwordIsDefault;
    buildFees(s.fees);
    saved = { net: s.network, wallets: { ...s.feeWallets }, state: '' };
    saved.state = settingsState();
    ['testMain', 'testDev'].forEach(id => { $(id).textContent = ''; $(id).className = 'testout'; });
    refreshSettingsUI();
    badge(s.network);
    $('repNet').value = s.network;
  }
  // Active-network cards (the hidden <select id="sNet"> stays the single source of truth)
  function paintNetPicks() {
    const cur = $('sNet').value;
    document.querySelectorAll('#netPicks .netpick').forEach(b => {
      const on = b.dataset.net === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
      const tag = b.querySelector('[data-tag]');
      tag.textContent = b.dataset.net === saved.net ? (on ? '● Live now' : '● Live now (you are changing this)') : (on ? 'Will go live when you save' : '');
      tag.className = 'np-tag' + (b.dataset.net === saved.net ? ' live' : on ? ' pending' : '');
    });
    document.querySelectorAll('.netcard').forEach(c => c.classList.toggle('active', c.dataset.net === cur));
    document.querySelectorAll('[data-active-pill]').forEach(p => {
      const on = p.dataset.activePill === cur;
      p.textContent = on ? 'Used now' : (p.dataset.activePill === 'devnet' ? 'Test SOL' : 'Real SOL'); p.classList.toggle('ok', on);
    });
  }
  document.querySelectorAll('#netPicks .netpick').forEach(b => b.addEventListener('click', () => { $('sNet').value = b.dataset.net; refreshSettingsUI(); }));
  $('setForm').addEventListener('input', refreshSettingsUI);
  document.querySelectorAll('[data-clear]').forEach(b => b.addEventListener('click', () => { $(b.dataset.clear).value = ''; refreshSettingsUI(); $(b.dataset.clear).focus(); }));
  $('sameWallet').addEventListener('click', () => { $('sWalletDev').value = $('sWalletMain').value; refreshSettingsUI(); });
  $('feeAll001').addEventListener('click', () => { feeKeys.forEach(k => { $('fee_' + k).value = '0.1'; }); refreshSettingsUI(); toast('All prices set to 0.1 SOL', 'info', 'Press “Save changes” to apply them.'); });
  $('setDiscard').addEventListener('click', () => loadSettings().catch(e => fail($('setMsg'), e)));

  // "Test connection": asks the RPC which network it is (so a mainnet address in the devnet box is caught) and reads the wallet balance.
  async function rpcAsk(url, method, params) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(9000) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message || 'RPC error'); return j.result;
  }
  document.querySelectorAll('[data-test]').forEach(btn => btn.addEventListener('click', async () => {
    const net = btn.dataset.test, f = FIELDS[net], out = $(f.test), url = $(f.rpc).value.trim() || PUBLIC_RPC[net], w = $(f.wallet).value.trim();
    out.className = 'testout busy'; out.textContent = 'Testing…'; btn.disabled = true;
    try {
      if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('The connection address must start with https://');
      const genesis = await rpcAsk(url, 'getGenesisHash', []);
      const other = net === 'devnet' ? 'mainnet-beta' : 'devnet';
      if (genesis === GENESIS[other]) { out.className = 'testout bad'; out.textContent = `✕ This connection is ${NETN[other]}, not ${NETN[net]}. Use a ${NETN[net]} address.`; return; }
      if (genesis !== GENESIS[net]) { out.className = 'testout warn'; out.textContent = `⚠ Connected, but it is not the standard ${NETN[net]} (could be a test or custom network).`; return; }
      let bal = '';
      if (looksLikeAddress(w)) { try { const r = await rpcAsk(url, 'getBalance', [w]); bal = ` Wallet balance: ${sol4((r?.value ?? 0) / 1e9)} SOL.`; } catch { /* balance is a bonus */ } }
      out.className = 'testout ok'; out.textContent = `✓ Connected to ${NETN[net]}.${bal}`;
    } catch (e) {
      out.className = 'testout bad';
      out.textContent = e.name === 'TimeoutError' ? '✕ No answer after 9 seconds. Check the address.' : `✕ Could not connect from this browser (${e.message || 'network error'}). The server may still reach it, but double-check the address.`;
    } finally { btn.disabled = false; }
  }));

  function badge(net) {
    const b = $('netBadge');
    b.textContent = net === 'devnet' ? 'DEVNET' : 'MAINNET';
    b.dataset.long = net === 'devnet' ? ' · test SOL' : ' · real SOL';          // the long part is hidden on small screens (CSS)
    b.className = 'badge ' + (net === 'devnet' ? 'dev' : 'main');
  }
  $('setForm').addEventListener('submit', async e => {
    e.preventDefault();
    const net = $('sNet').value, f = FIELDS[net];
    for (const n of Object.keys(FIELDS)) {
      if (!looksLikeAddress($(FIELDS[n].wallet).value.trim())) { fail($('setMsg'), new Error(`Please enter a valid ${NETN[n]} revenue wallet address.`)); $(FIELDS[n].wallet).focus(); return; }
    }
    const asks = [];
    if (net === 'mainnet-beta' && saved.net !== 'mainnet-beta') asks.push('Switch the whole site to MAINNET?\n\nVisitors will pay REAL SOL.');
    const w = $(f.wallet).value.trim();
    if (saved.wallets[net] && w !== saved.wallets[net]) asks.push(`Fees on ${NETN[net]} will now be sent to:\n\n${w}\n\nCheck every character. Payments cannot be undone.`);
    if (asks.length && !confirm(asks.join('\n\n———\n\n'))) return;
    const fees = {}; feeKeys.forEach(k => { fees[k] = $('fee_' + k).value; });
    const btn = $('setSave'); btn.disabled = true;
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { network: net, timezone: $('sTz').value, fees,
        rpcUrls: { 'mainnet-beta': $('sRpcMain').value, devnet: $('sRpcDev').value },
        feeWallets: { 'mainnet-beta': $('sWalletMain').value, devnet: $('sWalletDev').value } } });
      done($('setMsg'), 'Settings saved', 'The site now uses these settings.');
      await loadSettings(); await loadStats();
    } catch (err) { fail($('setMsg'), err); refreshSettingsUI(); }
  });

  /* ---------- logo upload ---------- */
  let pendingLogo = null;                               // data URL waiting to be uploaded
  const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  function pickLogo(file) {
    pendingLogo = null; $('logoSave').disabled = true;
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) return fail($('logoMsg'), new Error('Use a PNG, JPG, GIF or WebP image (SVG is not allowed).'));
    if (file.size > 1024 * 1024) return fail($('logoMsg'), new Error('That file is ' + bytesTxt(file.size) + '. The limit is 1 MB.'));
    const rd = new FileReader();
    rd.onload = () => {
      pendingLogo = rd.result;
      const box = $('brandPreview'), img = box.querySelector('img');
      img.src = pendingLogo; img.hidden = false; box.querySelector('svg').style.display = 'none'; box.classList.add('has-img');
      $('logoSave').disabled = false;
      say($('logoMsg'), 'Preview only. Click "Upload logo" to save it.', true);
    };
    rd.onerror = () => fail($('logoMsg'), new Error('Could not read that file.'));
    rd.readAsDataURL(file);
  }
  $('logoFile').addEventListener('change', e => pickLogo(e.target.files[0]));
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => pickLogo(e.dataTransfer.files[0]));
  $('logoSave').addEventListener('click', async () => {
    if (!pendingLogo) return;
    const btn = $('logoSave'); btn.disabled = true; $('logoMsg').textContent = '';
    logoProg.start('Uploading logo…');
    try {
      await uploadJson('/api/admin/logo', { image: pendingLogo }, (sent, total) => {
        if (sent < 0) logoProg.wait('Saving on the server…');
        else logoProg.set(sent / total, `Uploading logo… ${bytesTxt(sent)} of ${bytesTxt(total)}`);
      });
      pendingLogo = null; $('logoFile').value = '';
      logoProg.finish('Logo uploaded');
      done($('logoMsg'), 'Logo uploaded', 'It now shows on the admin pages and at /logo.'); setLogo(true);
    } catch (err) { btn.disabled = false; logoProg.error('Upload failed'); fail($('logoMsg'), err); }
  });
  $('logoRemove').addEventListener('click', async () => {
    if (!confirm('Remove the logo and go back to the default rocket?')) return;
    try { await api('/api/admin/logo', { method: 'DELETE' }); done($('logoMsg'), 'Logo removed', 'Back to the default rocket.'); setLogo(false); }
    catch (err) { fail($('logoMsg'), err); }
  });

  /* ---------- password ---------- */
  $('pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/api/admin/password', { method: 'POST', body: { current: $('pwCur').value, next: $('pwNew').value } });
      $('pwCur').value = ''; $('pwNew').value = '';
      done($('pwMsg'), 'Password changed', 'Other logged-in sessions were signed out.');
      $('pwWarn').hidden = true;
    } catch (err) { fail($('pwMsg'), err); }
  });

  /* ---------- report ---------- */
  const FEATURE_LABEL = { banner: 'Banner', social: 'Social', creator: 'Creator', mintRevoke: 'Mint revoked', freezeRevoke: 'Freeze revoked', metaRevoke: 'Metadata locked' };
  const shortAddr = a => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '');
  const when = t => { const d = new Date(String(t).replace(' ', 'T') + 'Z'); return isNaN(d) ? String(t) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
  let repLoaded = null;                                  // the network the lists below were loaded for
  const explorer = (kind, v, net) => `https://explorer.solana.com/${kind}/${encodeURIComponent(v)}${net === 'devnet' ? '?cluster=devnet' : ''}`;
  function td(text, cls) { const c = document.createElement('td'); c.textContent = text; if (cls) c.className = cls; return c; }
  async function copyText(v, what) {
    try { await navigator.clipboard.writeText(v); toast(what + ' copied', 'ok', shortAddr(v)); }
    catch { toast('Could not copy. Select the text and copy it manually.', 'err'); }
  }
  // address with an explorer link + a copy button (built with DOM nodes, never innerHTML)
  function addrCell(addr, net, kind = 'address') {
    const c = document.createElement('td'), w = document.createElement('span'); w.className = 'addr';
    const a = document.createElement('a'); a.href = explorer(kind, addr, net); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = shortAddr(addr); a.title = addr;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'mini'; b.title = 'Copy'; b.setAttribute('aria-label', 'Copy ' + addr);
    b.innerHTML = '<svg class="i" aria-hidden="true"><use href="#ic-copy"/></svg>';        // fixed markup, no data inside
    b.addEventListener('click', () => copyText(addr, kind === 'tx' ? 'Signature' : 'Address'));
    w.append(a, b); c.appendChild(w); return c;
  }
  /* ----- daily report: default 7 days, Previous / Next move one window at a time ----- */
  const rep = { offset: 0, sig: '' };
  const dayTxt = (d, withYear) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString([], { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }); };
  function syncNetSeg() { document.querySelectorAll('.seg [data-net]').forEach(b => b.classList.toggle('on', b.dataset.net === $('repNet').value)); }
  async function loadStats(silent) {
    syncNetSeg();
    const net = $('repNet').value, days = $('repDays').value;
    const s = await api(`/api/admin/stats?days=${encodeURIComponent(days)}&offset=${rep.offset}&network=${encodeURIComponent(net)}`);
    const sig = JSON.stringify([s.rows, s.wallets, s.hasOlder, s.hasNewer]);
    if (silent && sig === rep.sig) return;                 // nothing changed: don't repaint (keeps hover/scroll steady)
    rep.sig = sig;
    $('repLabel').textContent = s.from === s.to ? dayTxt(s.to, true) : `${dayTxt(s.from)} – ${dayTxt(s.to, true)}`;
    $('repPrev').disabled = !s.hasOlder; $('repNext').disabled = !s.hasNewer; $('repLatest').disabled = !s.hasNewer;
    $('tzNote').textContent = `Days follow the ${s.timezone} timezone. Visitors are unique people per day (cookie based). Money columns come from the verified transactions: "Spent" is what creators paid in total, "To MemeForge" is your fee, "Network" is rent and fees that stay with Solana. Figures for tokens created before this update only have the fee.`;
    $('csvBtn').href = `/api/admin/report.csv?days=${encodeURIComponent(days)}&offset=${rep.offset}&network=${encodeURIComponent(net)}`;

    const todayDay = s.today.day, max = Math.max(1, ...s.rows.map(r => r.revenue_lamports));
    const body = $('repBody'); body.textContent = '';
    let tv = 0, tw = 0, tt = 0, ts = 0, tr = 0, tn = 0;
    s.rows.forEach(r => {
      tv += r.visitors; tw += r.wallets; tt += r.tokens; ts += r.spent_lamports; tr += r.revenue_lamports; tn += r.network_lamports;
      const trow = document.createElement('tr'); if (r.day === todayDay) trow.className = 'today';
      trow.append(td(r.day + (r.day === todayDay ? ' (today)' : '')), td(r.visitors, 'num'), td(r.wallets, 'num'), td(r.tokens, 'num'),
        td(sol(r.spent_lamports), 'num'), td(sol(r.revenue_lamports), 'num'), td(sol(r.network_lamports), 'num'));
      const bc = document.createElement('td'); bc.className = 'barcell';
      const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = (r.revenue_lamports / max * 100) + '%';
      bc.appendChild(bar); trow.appendChild(bc); body.appendChild(trow);
    });
    $('tfV').textContent = tv; $('tfW').textContent = tw; $('tfT').textContent = tt; $('tfS').textContent = sol(ts); $('tfR').textContent = sol(tr); $('tfN').textContent = sol(tn);
    $('rsWallets').textContent = num(s.wallets.total); $('rsWalletsSub').textContent = `${num(s.wallets.newToday)} new today`;
    $('rsSpent').textContent = sol(ts); $('rsFee').textContent = sol(tr); $('rsNet').textContent = sol(tn);
  }
  const repReload = () => loadStats().catch(e => fail(null, e));
  $('repNet').addEventListener('change', () => { rep.offset = 0; wl.page = 1; tk.page = 1; repReload(); loadReportLists(); live.sig = ''; pollLive(true); });
  $('repDays').addEventListener('change', () => { rep.offset = 0; repReload(); });
  $('repPrev').addEventListener('click', () => { rep.offset += Number($('repDays').value); repReload(); });
  $('repNext').addEventListener('click', () => { rep.offset = Math.max(0, rep.offset - Number($('repDays').value)); repReload(); });
  $('repLatest').addEventListener('click', () => { rep.offset = 0; repReload(); });
  document.querySelectorAll('.seg [data-net]').forEach(b => b.addEventListener('click', () => { $('repNet').value = b.dataset.net; $('repNet').dispatchEvent(new Event('change')); }));
  // Reports tabs: Daily report | Visitor wallets | Tokens created
  document.querySelectorAll('#repTabs [data-rtab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#repTabs [data-rtab]').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('[data-rtab-panel]').forEach(p => { p.hidden = p.dataset.rtabPanel !== b.dataset.rtab; });
  }));

  // --- visitor wallets + created tokens (paged lists with search) ---
  const wl = { page: 1, q: '', pages: 1 }, tk = { page: 1, q: '', pages: 1 };
  function pager(st, d, infoEl, prev, next, noun) {
    st.page = d.page; st.pages = d.pages;
    infoEl.textContent = d.total ? `${num(d.total)} ${noun}${d.total === 1 ? '' : 's'} · page ${d.page} of ${d.pages}` : '';
    prev.disabled = d.page <= 1; next.disabled = d.page >= d.pages;
  }
  function emptyRow(body, cols, text) {
    const tr = document.createElement('tr'), c = document.createElement('td'); c.colSpan = cols; c.className = 'empty'; c.textContent = text; tr.appendChild(c); body.appendChild(tr);
  }
  async function loadVisitorWallets() {
    const net = $('repNet').value;
    const d = await api(`/api/admin/visitor-wallets?network=${encodeURIComponent(net)}&page=${wl.page}&q=${encodeURIComponent(wl.q)}`);
    $('wlCsv').href = `/api/admin/visitor-wallets.csv?network=${encodeURIComponent(net)}&q=${encodeURIComponent(wl.q)}`;
    const body = $('wlBody'); body.textContent = '';
    if (!d.rows.length) emptyRow(body, 8, wl.q ? 'No wallet matches your search.' : 'No wallets yet. They appear here when someone connects a wallet on the token creator.');
    for (const r of d.rows) {
      const tr = document.createElement('tr');
      tr.append(addrCell(r.address, net), td(r.wallet || '–'), td(when(r.last_seen)), td(when(r.first_seen)), td(r.connects, 'num'), td(r.tokens, 'num'),
        td(r.tokens ? sol(r.paid_lamports) : '–', 'num'), td(r.tokens ? sol(r.fee_lamports) : '–', 'num'));
      body.appendChild(tr);
    }
    pager(wl, d, $('wlInfo'), $('wlPrev'), $('wlNext'), 'wallet');
  }
  async function loadTokenList() {
    const net = $('repNet').value;
    const d = await api(`/api/admin/tokens?network=${encodeURIComponent(net)}&page=${tk.page}&q=${encodeURIComponent(tk.q)}`);
    $('tkCsv').href = `/api/admin/tokens.csv?network=${encodeURIComponent(net)}&q=${encodeURIComponent(tk.q)}`;
    const body = $('tkBody'); body.textContent = '';
    if (!d.rows.length) emptyRow(body, 10, tk.q ? 'No token matches your search.' : 'No tokens created on this network yet.');
    for (const r of d.rows) {
      const tr = document.createElement('tr');
      const tc = document.createElement('td'), t = document.createElement('div'); t.className = 'tok';
      const nm = document.createElement('b'); nm.textContent = r.token_name || 'Unnamed token';
      const sy = document.createElement('small'); sy.textContent = r.token_symbol ? '$' + r.token_symbol : '';
      t.append(nm, sy); tc.appendChild(t);
      const fc = document.createElement('td');
      for (const k of String(r.features || '').split(',').filter(Boolean)) { const g = document.createElement('span'); g.className = 'tag f'; g.textContent = FEATURE_LABEL[k] || k; fc.appendChild(g); }
      if (!fc.firstChild) fc.textContent = '–';
      const old = !r.paid_lamports;                        // created before spent/network were tracked
      tr.append(td(when(r.created_at)), tc, addrCell(r.mint, net), addrCell(r.creator, net), td(r.wallet_name || '–'), fc,
        td(old ? '–' : sol(r.paid_lamports), 'num'), td(sol(r.fee_lamports), 'num'), td(old ? '–' : sol(r.network_lamports), 'num'), addrCell(r.signature, net, 'tx'));
      body.appendChild(tr);
    }
    pager(tk, d, $('tkInfo'), $('tkPrev'), $('tkNext'), 'token');
  }
  function loadReportLists() { return Promise.all([loadVisitorWallets(), loadTokenList()]).catch(e => fail(null, e)); }
  $('wlPrev').addEventListener('click', () => { wl.page--; loadVisitorWallets().catch(e => fail(null, e)); });
  $('wlNext').addEventListener('click', () => { wl.page++; loadVisitorWallets().catch(e => fail(null, e)); });
  $('tkPrev').addEventListener('click', () => { tk.page--; loadTokenList().catch(e => fail(null, e)); });
  $('tkNext').addEventListener('click', () => { tk.page++; loadTokenList().catch(e => fail(null, e)); });
  function debounced(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  $('wlSearch').addEventListener('input', debounced(() => { wl.q = $('wlSearch').value.trim(); wl.page = 1; loadVisitorWallets().catch(e => fail(null, e)); }, 300));
  $('tkSearch').addEventListener('input', debounced(() => { tk.q = $('tkSearch').value.trim(); tk.page = 1; loadTokenList().catch(e => fail(null, e)); }, 300));

  /* ---------- LIVE: the whole Overview refreshes itself (one request every few seconds) ---------- */
  const live = { timer: null, seen: null, rows: [], busy: false, sig: '', net: null, fresh: new Set() };
  const LIVE_MS = 4000;
  const ago = t => {
    const sec = Math.max(0, Math.round((Date.now() - new Date(String(t).replace(' ', 'T') + 'Z')) / 1000));
    if (sec < 10) return 'just now'; if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + ' min ago'; if (sec < 86400) return Math.floor(sec / 3600) + ' h ago';
    return Math.floor(sec / 86400) + ' d ago';
  };
  function paintLive(net) {
    const body = $('liveBody'); body.textContent = '';
    if (!live.rows.length) emptyRow(body, 7, 'No tokens created on this network yet. New ones appear here the moment they are confirmed.');
    for (const r of live.rows) {
      const tr = document.createElement('tr'); if (live.fresh.has(r.id)) tr.className = 'flash';
      const tc = document.createElement('td'), t = document.createElement('div'); t.className = 'tok';
      const nm = document.createElement('b'); nm.textContent = r.token_name || 'Unnamed token';
      const sy = document.createElement('small'); sy.textContent = r.token_symbol ? '$' + r.token_symbol : '';
      t.append(nm, sy); tc.appendChild(t);
      const when_ = td(ago(r.created_at)); when_.title = when(r.created_at);
      const old = !r.paid_lamports;
      tr.append(when_, addrCell(r.creator, net), tc, td(r.wallet_name || '–'), td(old ? '–' : sol(r.paid_lamports), 'num'), td(sol(r.fee_lamports), 'num'), addrCell(r.signature, net, 'tx'));
      body.appendChild(tr);
    }
  }
  function paintOverview(d) {
    const label = d.network === 'devnet' ? 'devnet (test)' : 'mainnet', life = d.lifetime[d.network], t = d.today;
    $('stVisitors').textContent = num(t.visitors);
    $('stTokens').textContent = num(t.tokens); $('stTokensNet').textContent = label;
    $('stRevenue').textContent = sol(t.revenue_lamports);
    $('stWallets').textContent = num(d.wallets.total); $('stWalletsNew').textContent = `${num(d.wallets.newToday)} new today`;
    $('stSpent').textContent = sol(t.spent_lamports); $('stNet').textContent = sol(t.network_lamports);
    $('stLife').textContent = sol(life.revenue_lamports); $('stLifeSub').textContent = `${num(life.tokens)} tokens · ${label}`;
    $('stLifeSpent').textContent = sol(life.spent_lamports);
    // database meter + warning dot (the full Database page still has its own detail)
    const o = d.db; if (o) {
      const f = $('ovFill'); f.style.width = Math.min(o.percent, 100) + '%'; f.className = 'meter-fill' + (o.status === 'ok' ? '' : ' ' + o.status);
      $('ovUsed').textContent = bytesTxt(o.total); $('ovOf').textContent = ' of ' + o.limitMb + ' MB limit';
      const pl = $('ovPill'); pl.textContent = STATUS_TXT[o.status] + ' · ' + o.percent + '%'; pl.className = 'pill ' + o.status;
      const dot = $('dbDot'); dot.hidden = o.status === 'ok'; dot.className = 'dot' + (o.status === 'over' ? ' over' : '');
    }
  }
  function liveState(ok) {
    const txt = ok ? 'Live · ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Reconnecting…';
    $('topLiveTxt').textContent = txt; $('liveStatus').textContent = ok ? 'Updated ' + new Date().toLocaleTimeString() : 'Connection lost, retrying…';
    document.querySelectorAll('.live-dot').forEach(d => d.classList.toggle('off', !ok));
  }
  async function pollLive(force) {
    if (live.busy || document.hidden || $('dashView').hidden) return;
    live.busy = true;
    const net = $('repNet').value;
    try {
      const d = await api(`/api/admin/live?network=${encodeURIComponent(net)}`);
      const ids = new Set(d.tokens.map(r => r.id));
      live.fresh = live.seen && live.net === net ? new Set([...ids].filter(i => !live.seen.has(i))) : new Set();
      const sig = JSON.stringify([d.today, d.lifetime, d.wallets, d.db, d.tokens.map(r => r.id)]);
      const changed = sig !== live.sig || force;
      live.sig = sig; live.rows = d.tokens; live.seen = ids; live.net = net;
      if (changed) {
        paintOverview(d); paintLive(net);
        if (live.fresh.size) { const n = live.fresh.size; toast(n === 1 ? 'New token created' : `${n} new tokens created`, 'info', d.tokens[0].token_name || shortAddr(d.tokens[0].creator)); }
        // the Reports page is live too while it shows the latest days
        if (location.hash === '#reports' && rep.offset === 0) loadStats(true).catch(() => {});
      } else document.querySelectorAll('#liveBody tr').forEach((tr, i) => { if (tr.firstChild && live.rows[i]) tr.firstChild.textContent = ago(live.rows[i].created_at); });
      liveState(true);
    } catch { liveState(false); }
    finally { live.busy = false; }
  }
  function liveStart() { liveStop(); pollLive(true); live.timer = setInterval(pollLive, LIVE_MS); }
  function liveStop() { clearInterval(live.timer); live.timer = null; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && live.timer) pollLive(); });

  /* ---------- wallets shown on the token creator ---------- */
  let wOpts = [], wPresets = [], wEditing = null;
  const letterOf = n => (String(n || '?').trim()[0] || '?').toUpperCase();
  const colorOf = c => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#444444');
  // round logo: the image if there is a link (falls back to the letter if it fails to load), otherwise a colored letter
  function logoBadge(name, url, color) {
    const b = document.createElement('div'); b.className = 'wlogo'; b.style.background = colorOf(color);
    const letter = () => { b.textContent = letterOf(name); };
    if (url && /^https:\/\//i.test(url)) {
      const img = document.createElement('img'); img.alt = ''; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; img.src = url;
      img.addEventListener('error', () => { img.remove(); letter(); });
      b.appendChild(img);
    } else letter();
    return b;
  }
  async function loadWalletOptions() { const d = await api('/api/admin/wallet-options'); wOpts = d.wallets; wPresets = d.presets; renderWallets(); }
  let wFilter = 'all';                                  // all | popular | hidden
  document.querySelectorAll('#wFilter button').forEach(b => b.addEventListener('click', () => {
    wFilter = b.dataset.f; document.querySelectorAll('#wFilter button').forEach(x => x.classList.toggle('on', x === b)); renderWallets();
  }));
  function renderWallets() {
    const list = $('wList'); list.textContent = '';
    if (!wOpts.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No wallets yet. Visitors will see the built-in Phantom, Solflare and Backpack until you add some below.'; list.appendChild(e); }
    const lq = ($('wListSearch').value || '').trim().toLowerCase();
    $('wCount').textContent = wOpts.length ? `${wOpts.filter(w => w.enabled).length} shown · ${wOpts.filter(w => w.popular).length} popular · ${wOpts.length} total` : '';
    let listed = 0;
    const filtering = !!lq || wFilter !== 'all';
    wOpts.forEach((w, i) => {
      if (lq && !(w.name.toLowerCase().includes(lq) || (w.provider || '').toLowerCase().includes(lq))) return;
      if (wFilter === 'popular' && !w.popular) return;
      if (wFilter === 'hidden' && w.enabled) return;
      listed++;
      const row = document.createElement('div'); row.className = 'witem' + (w.enabled ? '' : ' off') + (w.popular ? ' pop' : '');
      const meta = document.createElement('div'); meta.className = 'wmeta';
      const nm = document.createElement('b'); nm.textContent = w.name;
      if (w.popular) { const pb = document.createElement('span'); pb.className = 'popbadge'; pb.textContent = '★ Popular'; nm.appendChild(pb); }
      const sub = document.createElement('span'); sub.textContent = (w.provider ? 'window.' + w.provider : 'no provider · install link only') + (w.enabled ? '' : ' · hidden');
      meta.append(nm, sub);
      const sw = document.createElement('label'); sw.className = 'sw'; sw.title = w.enabled ? 'Shown. Click to hide' : 'Hidden. Click to show';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = w.enabled; cb.setAttribute('aria-label', 'Show ' + w.name + ' on the token creator');
      cb.addEventListener('change', async () => {
        try { await walletCall('PUT', w.id, { ...w, enabled: cb.checked }); toast(`${w.name} ${cb.checked ? 'is now shown' : 'is now hidden'}`, 'ok', 'Visitors see it after a page refresh.'); }
        catch (e) { cb.checked = !cb.checked; fail($('wMsg'), e); }
      });
      const knob = document.createElement('i'); sw.append(cb, knob);
      const act = document.createElement('div'); act.className = 'wact';
      const mk = (icon, title, fn, disabled) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'mini'; b.title = title; b.setAttribute('aria-label', title + ' ' + w.name); b.disabled = !!disabled;
        b.innerHTML = `<svg class="i" aria-hidden="true"><use href="#${icon}"/></svg>`; b.addEventListener('click', fn); return b;
      };
      const star = mk('ic-star', w.popular ? 'Remove Popular badge from' : 'Mark as Popular:', async () => {
        try { await walletCall('PUT', w.id, { ...w, popular: !w.popular }); toast(w.popular ? `${w.name} is no longer Popular` : `${w.name} marked Popular`, 'ok', 'Visitors see it after a page refresh.'); }
        catch (e) { fail($('wMsg'), e); }
      });
      star.classList.toggle('on', !!w.popular); star.setAttribute('aria-pressed', String(!!w.popular));
      act.append(sw, star, mk('ic-arrowup', 'Move up', () => moveWallet(i, -1), filtering || i === 0), mk('ic-arrowdown', 'Move down', () => moveWallet(i, 1), filtering || i === wOpts.length - 1),
        mk('ic-edit', 'Edit', () => editWallet(w)), mk('ic-trash', 'Delete', () => deleteWallet(w)));
      row.append(logoBadge(w.name, w.logoUrl, w.color), meta, act); list.appendChild(row);
    });
    if (filtering && wOpts.length && !listed) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = lq ? 'None of your wallets match that search.' : wFilter === 'popular' ? 'No wallet is marked Popular yet. Tap the ★ on a wallet to add the badge.' : 'No hidden wallets.'; list.appendChild(e); }
    renderCatalog();
  }
  // The popular-wallet catalog: search + category filter + one-click add (and "add all shown")
  const cat = { q: '', cat: 'All' };
  const notAdded = () => { const have = new Set(wOpts.map(w => w.name.toLowerCase())); return wPresets.filter(p => !have.has(p.name.toLowerCase())); };
  function renderCatalog() {
    const avail = notAdded(), q = cat.q.trim().toLowerCase();
    const matches = avail.filter(p => (cat.cat === 'All' || p.cat === cat.cat) && (!q || p.name.toLowerCase().includes(q) || (p.cat || '').toLowerCase().includes(q)));
    $('wCatCount').textContent = `${avail.length} available · ${wPresets.length} in the catalog`;
    // category buttons (counts are of wallets you have not added yet)
    const bar = $('wCats'); bar.textContent = '';
    const counts = {}; avail.forEach(p => { counts[p.cat] = (counts[p.cat] || 0) + 1; });
    for (const c of ['All', ...Object.keys(counts)]) {
      const b = document.createElement('button'); b.type = 'button'; b.className = c === cat.cat ? 'on' : '';
      b.textContent = `${c} ${c === 'All' ? avail.length : counts[c]}`;
      b.addEventListener('click', () => { cat.cat = c; renderCatalog(); }); bar.appendChild(b);
    }
    const box = $('wPresets'); box.textContent = '';
    for (const p of matches) {
      const c = document.createElement('button'); c.type = 'button'; c.className = 'chip' + (p.hasProvider ? '' : ' linkonly');
      c.title = p.hasProvider ? 'Can connect when the visitor has it installed' : 'Install link only (add a Provider later to let it connect)';
      const tag = document.createElement('small'); tag.textContent = p.hasProvider ? 'connect' : 'link';
      const plus = document.createElement('span'); plus.className = 'plus'; plus.textContent = '+';
      c.append(logoBadge(p.name, p.logoUrl, p.color), document.createTextNode(p.name), tag, plus);
      c.addEventListener('click', async () => {
        c.disabled = true;
        try { await walletCall('POST', '', { ...p, enabled: true, popular: p.id === 'phantom' || p.id === 'solflare' }); toast(`${p.name} added`, 'ok', 'Visitors see it after a page refresh.'); }
        catch (e) { c.disabled = false; fail($('wMsg'), e); }
      });
      box.appendChild(c);
    }
    if (!box.firstChild) { const n = document.createElement('span'); n.className = 'note'; n.style.margin = '0'; n.textContent = avail.length ? 'No wallet matches your search.' : 'Every wallet in the catalog is already on your list.'; box.appendChild(n); }
    $('wAddShown').hidden = !matches.length; $('wAddShown').dataset.ids = JSON.stringify(matches.map(p => p.id));
    $('wAddShownTxt').textContent = (q || cat.cat !== 'All') ? `Add ${matches.length} shown` : `Add all ${matches.length}`;
  }
  $('wCatSearch').addEventListener('input', debounced(() => { cat.q = $('wCatSearch').value; renderCatalog(); }, 150));
  $('wFillLogos').addEventListener('click', async () => {
    const b = $('wFillLogos'); b.disabled = true;
    try { const d = await api('/api/admin/wallet-options/fill-logos', { method: 'POST' }); wOpts = d.wallets; wPresets = d.presets; renderWallets(); renderCatalog();
      toast(d.filled ? `Logos added to ${d.filled} wallet${d.filled === 1 ? '' : 's'}` : 'Every wallet already has a logo link', 'ok', 'Visitors see them after a page refresh.'); }
    catch (e) { fail($('wMsg'), e); } finally { b.disabled = false; }
  });
  $('wListSearch').addEventListener('input', debounced(() => renderWallets(), 150));
  $('wAddShown').addEventListener('click', async () => {
    const ids = JSON.parse($('wAddShown').dataset.ids || '[]'); if (!ids.length) return;
    if (ids.length > 25 && !confirm(`Add ${ids.length} wallets to the token creator?\n\nThey are all shown to visitors at once (the popup has a search box). You can hide or delete any of them later.`)) return;
    try {
      const d = await api('/api/admin/wallet-options/add-presets', { method: 'POST', body: { ids } });
      wOpts = d.wallets; wPresets = d.presets; renderWallets();
      toast(`${d.added} wallet${d.added === 1 ? '' : 's'} added`, 'ok', 'Visitors see them after a page refresh.');
    } catch (e) { fail($('wMsg'), e); }
  });
  async function walletCall(method, id, body) {
    const d = await api('/api/admin/wallet-options' + (id ? '/' + encodeURIComponent(id) : ''), { method, body });
    wOpts = d.wallets; wPresets = d.presets; renderWallets(); return d;
  }
  async function moveWallet(i, dir) {
    const ids = wOpts.map(w => w.id), j = i + dir; if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { const d = await api('/api/admin/wallet-options/reorder', { method: 'POST', body: { ids } }); wOpts = d.wallets; wPresets = d.presets; renderWallets(); toast('Order saved', 'ok'); }
    catch (e) { fail($('wMsg'), e); }
  }
  async function deleteWallet(w) {
    if (!confirm(`Remove ${w.name} from the token creator?\n\nYou can add it again later.`)) return;
    try { await walletCall('DELETE', w.id); if (wEditing === w.id) resetWalletForm(); toast(`${w.name} removed`, 'ok'); }
    catch (e) { fail($('wMsg'), e); }
  }

  // --- add / edit form ---
  let colorTouched = false;
  const f = id => $(id);
  function paintPrev() {
    const old = $('wfPrev'), nu = logoBadge(f('wfName').value || '?', f('wfLogo').value.trim(), colorTouched ? f('wfColorTxt').value : '');
    nu.id = 'wfPrev'; old.replaceWith(nu);
    const url = f('wfLogo').value.trim(), note = $('wfPrevNote');
    if (!url) note.textContent = 'Paste a link to a PNG, JPG, WebP or SVG image. Without one, a colored letter badge is used.';
    else if (!/^https:\/\//i.test(url)) note.textContent = 'The logo link must start with https://';
    else { note.textContent = 'Loading preview…'; const im = nu.querySelector('img'); if (im) { im.addEventListener('load', () => { note.textContent = 'Logo looks good.'; }); im.addEventListener('error', () => { note.textContent = 'This image could not be loaded. Check the link, or leave it empty to use a letter badge.'; }); } }
  }
  const paintPrevSoon = debounced(paintPrev, 350);
  ['wfName', 'wfLogo'].forEach(id => f(id).addEventListener('input', paintPrevSoon));
  f('wfColor').addEventListener('input', () => { colorTouched = true; f('wfColorTxt').value = f('wfColor').value; paintPrev(); });
  f('wfColorTxt').addEventListener('input', () => { colorTouched = true; const v = f('wfColorTxt').value.trim(); if (/^#[0-9a-f]{6}$/i.test(v)) f('wfColor').value = v; paintPrevSoon(); });
  function resetWalletForm() {
    wEditing = null; colorTouched = false; $('wForm').reset(); f('wfColor').value = '#6b5cf0'; f('wfColorTxt').value = '';
    $('wFormTitle').textContent = 'Add a custom wallet'; $('wfSaveTxt').textContent = 'Add wallet'; $('wfCancel').hidden = true; $('wfMsg').textContent = ''; paintPrev();
  }
  function editWallet(w) {
    wEditing = w.id; $('wFormTitle').textContent = 'Edit ' + w.name; $('wfSaveTxt').textContent = 'Save changes'; $('wfCancel').hidden = false;
    f('wfName').value = w.name; f('wfLogo').value = w.logoUrl; f('wfProvider').value = w.provider; f('wfFlag').value = w.flag;
    f('wfInstall').value = w.installUrl; f('wfDeep').value = w.deeplink; f('wfEnabled').checked = w.enabled; f('wfPopular').checked = !!w.popular;
    colorTouched = !!w.color; f('wfColorTxt').value = w.color; f('wfColor').value = w.color || '#6b5cf0';
    paintPrev(); $('wFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' }); f('wfName').focus({ preventScroll: true });
  }
  $('wfCancel').addEventListener('click', resetWalletForm);
  $('wForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { name: f('wfName').value, logoUrl: f('wfLogo').value, provider: f('wfProvider').value, flag: f('wfFlag').value,
      installUrl: f('wfInstall').value, deeplink: f('wfDeep').value, color: f('wfColorTxt').value.trim(), enabled: f('wfEnabled').checked, popular: f('wfPopular').checked };
    const btn = $('wfSave'); btn.disabled = true;
    try {
      const editing = wEditing;
      await walletCall(editing ? 'PUT' : 'POST', editing || '', body);
      toast(editing ? `${body.name} updated` : `${body.name} added`, 'ok', 'Visitors see it after a page refresh.');
      resetWalletForm();
    } catch (err) { fail($('wfMsg'), err); } finally { btn.disabled = false; }
  });

  /* ---------- database manager ---------- */
  let dbInfo = null;
  const STATUS_TXT = { ok: 'Healthy', warn: 'Getting full', over: 'Over limit' };
  function paintMeter(fill, pill, o) {
    fill.style.width = Math.min(o.percent, 100) + '%';
    fill.className = 'meter-fill' + (o.status === 'ok' ? '' : ' ' + o.status);
    pill.textContent = STATUS_TXT[o.status] + ' · ' + o.percent + '%';
    pill.className = 'pill ' + o.status;
  }
  async function loadDb() {
    const o = dbInfo = await api('/api/admin/db');
    paintMeter($('dbFill'), $('dbPill'), o); paintMeter($('ovFill'), $('ovPill'), o);
    $('dbUsed').textContent = $('ovUsed').textContent = bytesTxt(o.total);
    const of = ' of ' + o.limitMb + ' MB limit' + (o.wal ? ` (includes ${bytesTxt(o.wal)} write-ahead log)` : '');
    $('dbOf').textContent = $('ovOf').textContent = of;
    $('dbLimit').value = o.limitMb;

    const dot = $('dbDot'); dot.hidden = o.status === 'ok'; dot.className = 'dot' + (o.status === 'over' ? ' over' : '');
    const w = $('dbWarn');
    if (o.status === 'ok') w.hidden = true;
    else {
      w.hidden = false; w.className = 'warn' + (o.status === 'warn' ? ' amber' : '');
      w.textContent = '';
      w.append(o.status === 'over' ? `🚨 The database is over its ${o.limitMb} MB limit (${bytesTxt(o.total)}). ` : `⚠️ The database is at ${o.percent}% of its ${o.limitMb} MB limit. `);
      const a = document.createElement('a'); a.href = '#database'; a.textContent = 'Free up space'; w.appendChild(a);
    }

    const body = $('dbTables'); body.textContent = '';
    for (const t of o.tables) {
      const tr = document.createElement('tr');
      const n = document.createElement('td'); n.className = 'tbl-name'; n.textContent = t.name;
      const r = document.createElement('td'); r.textContent = num(t.rows);
      const b = document.createElement('td'); b.textContent = bytesTxt(t.bytes);
      const act = document.createElement('td');
      const btn = document.createElement('button'); btn.className = 'btn ghost sm'; btn.type = 'button';
      btn.textContent = t.deletable ? 'Browse / clean' : 'View';
      btn.addEventListener('click', () => openTable(t.name, 1));
      act.appendChild(btn); tr.append(n, r, b, act); body.appendChild(tr);
    }
    if (curTable) $('browseCard').hidden = false;
  }
  $('dbRefreshBtn').addEventListener('click', () => loadDb().then(() => { if (curTable) openTable(curTable, curPage); toast('Database info refreshed', 'info'); }).catch(e => fail($('dbMsg'), e)));
  $('dbLimitBtn').addEventListener('click', async () => {
    try { await api('/api/admin/db/limit', { method: 'PUT', body: { limitMb: Number($('dbLimit').value) } }); done($('dbMsg'), 'Size limit saved'); await loadDb(); }
    catch (e) { fail($('dbMsg'), e); }
  });
  $('dbOptBtn').addEventListener('click', async () => {
    const btn = $('dbOptBtn'); btn.disabled = true; $('dbMsg').textContent = '';
    dbProg.start('Optimizing the database… large files can take a few seconds');
    try {
      const r = await api('/api/admin/db/optimize', { method: 'POST' });
      dbProg.finish('Optimized');
      done($('dbMsg'), 'Database optimized', `File size went from ${bytesTxt(r.before)} to ${bytesTxt(r.after)}.`); await loadDb();
    } catch (e) { dbProg.error('Optimize failed'); fail($('dbMsg'), e); } finally { btn.disabled = false; }
  });

  // Backup download with a real progress bar (the server sends the file size).
  $('dbBackupBtn').addEventListener('click', async e => {
    e.preventDefault();
    const link = $('dbBackupBtn'); if (link.dataset.busy) return; link.dataset.busy = '1';
    dbProg.start('Preparing the backup…'); $('dbMsg').textContent = '';
    try {
      const res = await fetch('/api/admin/db/backup', { credentials: 'same-origin' });
      if (res.status === 401) { showLogin(); throw new Error('Please log in again.'); }
      if (!res.ok) throw new Error('Backup failed');
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader(), chunks = []; let got = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        chunks.push(value); got += value.length;
        if (total) dbProg.set(got / total, `Downloading backup… ${bytesTxt(got)} of ${bytesTxt(total)}`); else dbProg.wait(`Downloading backup… ${bytesTxt(got)}`);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'memeforge-backup.db';
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(chunks)); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      dbProg.finish('Backup downloaded');
      toast('Backup downloaded', 'ok', `${name} · ${bytesTxt(got)}`);
    } catch (err) { dbProg.error('Backup failed'); fail($('dbMsg'), err); } finally { delete link.dataset.busy; }
  });

  // --- table browser ---
  let curTable = null, curPage = 1, curMeta = null;
  const selected = new Set();
  const NOTES = {
    visits: 'One row per visitor per day. Deleting old rows is safe: each day\'s visitor total is saved first, so the report keeps its history. Today is never touched.',
    tokens: 'One row per token created. Deleting rows does NOT change revenue totals in the daily report (those are stored separately).',
    daily_stats: 'The revenue/tokens report itself. Deleting rows removes that history from the report and the CSV. Download a backup first.',
    daily_visitors: 'Saved visitor totals of purged days. Deleting rows removes that history from the report.',
    wallets: 'Every wallet address that connected on the token creator. Deleting rows only removes them from this list; the tokens they created stay in the report. A wallet that connects again is added again.',
    wallet_options: 'Read-only here. Manage the wallet list on the Wallets page.',
    fees: 'Read-only here. Edit prices in Settings.',
    settings: 'Read-only here (the password hash is hidden). Edit these in Settings and Security.',
  };
  async function openTable(name, page) {
    selected.clear(); updateSel();
    const d = await api(`/api/admin/db/table?name=${encodeURIComponent(name)}&page=${page}&size=25`).catch(e => { fail($('dbMsg'), e); return null; });
    if (!d) return;
    curTable = name; curPage = d.page; curMeta = d;
    $('browseCard').hidden = false;
    $('browseTitle').textContent = `Table · ${name} (${num(d.total)} rows)`;
    $('browseNote').textContent = NOTES[name] || '';
    $('delZone').hidden = !d.deletable;
    $('delSelBtn').hidden = !d.byIds;
    document.querySelectorAll('#delZone [data-age]').forEach(el => { el.hidden = !d.byAge; });
    $('delNote').textContent = d.byAge ? 'Use 0 days to delete everything before today.' : 'Tick the rows you want to remove, then use the red button.';
    $('delMsg').textContent = '';

    const head = $('dt').tHead; head.textContent = '';
    const hr = document.createElement('tr');
    if (d.byIds) {
      const th = document.createElement('th'); th.className = 'sel';
      const all = document.createElement('input'); all.type = 'checkbox'; all.setAttribute('aria-label', 'Select all rows on this page');
      all.addEventListener('change', () => {
        document.querySelectorAll('#dt tbody input[type=checkbox]').forEach(c => { c.checked = all.checked; all.checked ? selected.add(+c.dataset.id) : selected.delete(+c.dataset.id); });
        updateSel();
      });
      th.appendChild(all); hr.appendChild(th);
    }
    for (const c of d.columns) { const th = document.createElement('th'); th.textContent = c; hr.appendChild(th); }
    head.appendChild(hr);

    const body = $('dt').tBodies[0]; body.textContent = '';
    if (!d.rows.length) {
      const tr = document.createElement('tr'), td = document.createElement('td');
      td.colSpan = d.columns.length + (d.byIds ? 1 : 0); td.className = 'empty'; td.textContent = 'This table is empty.';
      tr.appendChild(td); body.appendChild(tr);
    }
    for (const r of d.rows) {
      const tr = document.createElement('tr');
      if (d.byIds) {
        const td = document.createElement('td'); td.className = 'sel';
        const c = document.createElement('input'); c.type = 'checkbox'; c.dataset.id = r._id;
        c.addEventListener('change', () => { c.checked ? selected.add(r._id) : selected.delete(r._id); updateSel(); });
        td.appendChild(c); tr.appendChild(td);
      }
      for (const col of d.columns) {
        const td = document.createElement('td'); const v = r[col];
        td.textContent = v == null ? '' : String(v); td.title = td.textContent; tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    $('pgInfo').textContent = `Page ${d.page} of ${d.pages}`;
    $('pgPrev').disabled = d.page <= 1; $('pgNext').disabled = d.page >= d.pages;
    $('browseCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function updateSel() {
    $('delSelTxt').textContent = selected.size ? `Delete ${selected.size} selected` : 'Delete selected';
    $('delSelBtn').disabled = selected.size === 0;
  }
  $('pgPrev').addEventListener('click', () => openTable(curTable, curPage - 1));
  $('pgNext').addEventListener('click', () => openTable(curTable, curPage + 1));

  // Asks the server how many rows would go (dryRun), then asks YOU to confirm with the exact number.
  async function runDelete(body, what) {
    const msg = $('delMsg');
    try {
      const probe = await api('/api/admin/db/delete', { method: 'POST', body: { ...body, dryRun: true } });
      if (!probe.count) { say(msg, 'Nothing matches. No rows were deleted.', true); return toast('Nothing matches', 'info', 'No rows were deleted.'); }
      const warn = { wallets: '\n\nTokens these wallets created stay in the report.', daily_stats: '\n\nThis removes revenue history from the report.', daily_visitors: '\n\nThis removes visitor history from the report.',
        tokens: '\n\nRevenue totals in the daily report are kept.', visits: '\n\nDaily visitor totals are saved first.' }[body.table] || '';
      if (!confirm(`Delete ${num(probe.count)} row${probe.count === 1 ? '' : 's'} from "${body.table}" (${what})?\n\nThis cannot be undone. Download a backup first if unsure.${warn}`)) return;
      const r = await api('/api/admin/db/delete', { method: 'POST', body: { ...body, optimize: $('delShrink').checked } });
      const text = `Deleted ${num(r.deleted)} row${r.deleted === 1 ? '' : 's'}`;
      const more = r.shrink ? `File size: ${bytesTxt(r.shrink.before)} → ${bytesTxt(r.shrink.after)}.` : 'Click "Optimize" to shrink the file.';
      await loadDb(); await openTable(curTable, 1); await loadStats();
      done($('delMsg'), text, more);              // openTable() clears the message, so show it after the reload
    } catch (e) { fail(msg, e); }
  }
  $('delOlderBtn').addEventListener('click', () => {
    const days = parseInt($('delDays').value, 10);
    if (!Number.isInteger(days) || days < 0) return say($('delMsg'), 'Enter a number of days (0 or more).', false);
    runDelete({ table: curTable, mode: 'older', days }, days === 0 ? 'everything before today' : `older than ${days} days`);
  });
  $('delSelBtn').addEventListener('click', () => {
    if (!selected.size) return;
    runDelete({ table: curTable, mode: 'ids', ids: [...selected] }, 'selected rows');
  });

  /* ---------- appearance (admin → Appearance) ---------- */
  // Every change is applied live (MFTheme.apply) but only stored when "Save look" is pressed.
  const MT = window.MFTheme;
  const AP_KEYS = Object.keys(MT.DEFAULTS);
  const SEG = (k, label, help, opts) => ({ k, t: 'seg', label, help, opts });
  const AP_GROUPS = [
    { title: 'Colours', desc: 'Pick light or dark, and the colours used for buttons, the active menu item and highlights.', fields: [
      SEG('mode', 'Mode', 'Dark, light, or follow the device setting.', [['dark', 'Dark'], ['light', 'Light'], ['auto', 'Auto']]),
      { k: 'accent', t: 'color', label: 'Main colour', help: 'Buttons, the active menu item, focus rings.', swatches: true },
      { k: 'accent2', t: 'color', label: 'Second colour', help: 'The other end of the gradient and small highlights.' },
      { k: 'gradient', t: 'switch', label: 'Gradient style', help: 'Blend the two colours on buttons and highlights. Off = one solid colour.' }] },
    { title: 'Text, shape and spacing', desc: 'How big, round and roomy everything feels.', fields: [
      SEG('font', 'Font', 'Uses fonts already on the device, so nothing is downloaded.', [['system', 'Standard'], ['rounded', 'Rounded'], ['serif', 'Serif'], ['mono', 'Mono']]),
      SEG('fontSize', 'Text size', 'Makes labels, tables and buttons smaller or larger.', [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']]),
      SEG('radius', 'Corners', 'From square corners to very round ones.', [['sharp', 'Sharp'], ['soft', 'Soft'], ['round', 'Round'], ['pill', 'Extra round']]),
      SEG('density', 'Spacing', 'Compact fits more on screen; spacious is easier to tap.', [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['spacious', 'Spacious']])] },
    { title: 'Layout and menu', desc: 'The side menu and how wide the pages are.', fields: [
      SEG('sidebar', 'Menu background', 'Frosted glass, a solid panel, or tinted with your main colour.', [['glass', 'Glass'], ['solid', 'Solid'], ['accent', 'Tinted']]),
      SEG('navStyle', 'Active menu item', 'How the page you are on is marked in the menu.', [['soft', 'Soft glow'], ['bar', 'Side bar'], ['pill', 'Filled pill']]),
      { k: 'collapsed', t: 'switch', label: 'Start with the slim menu', help: 'Shows only icons on desktop. You can still open it with the menu button (or the [ key).' },
      SEG('width', 'Page width', 'How wide the content area can grow on big screens.', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide'], ['full', 'Full']])] },
    { title: 'Surfaces and effects', desc: 'Cards, background and motion.', fields: [
      SEG('card', 'Cards', 'Frosted glass, solid colour, or just an outline.', [['glass', 'Glass'], ['solid', 'Solid'], ['outline', 'Outline']]),
      SEG('bg', 'Background', 'Soft glowing colours, quiet dots, or plain.', [['aurora', 'Glow'], ['dots', 'Dots'], ['plain', 'Plain']]),
      { k: 'blur', t: 'switch', label: 'Frosted blur', help: 'The see-through blur behind cards and menus. Turn off on slow devices.' },
      { k: 'zebra', t: 'switch', label: 'Striped table rows', help: 'Every second row gets a light shade, which helps reading long lists.' },
      { k: 'animations', t: 'switch', label: 'Animations', help: 'Page fades, hover lifts and the live pulse. Turn off for a calmer, faster feel.' }] },
    { title: 'Name', desc: 'The name and tagline shown in the menu, on the sign-in page and in the browser tab.', fields: [
      { k: 'brandName', t: 'text', label: 'Dashboard name', help: 'Up to 30 characters.', max: 30, ph: 'MemeForge' },
      { k: 'brandTag', t: 'text', label: 'Tagline', help: 'Small text under the name. Can be empty.', max: 40, ph: 'Admin panel' }] },
  ];
  const AP_BY_KEY = {}; AP_GROUPS.forEach(g => g.fields.forEach(f => { AP_BY_KEY[f.k] = f; }));
  const pickTheme = t => { const o = {}; if (t && typeof t === 'object') for (const k of AP_KEYS) if (k in t) o[k] = t[k]; return o; };
  const apState = t => JSON.stringify(AP_KEYS.map(k => t[k]));
  let apSaved = { ...MT.DEFAULTS }, apDraft = { ...MT.DEFAULTS }, apBuilt = false;
  const apCtl = {};                                                   // key -> function that shows a value in its control
  function apDirty() { return apState(apDraft) !== apState(apSaved); }
  function apValid(k, v) {                                            // a value from pasted code is only accepted if it fits that option
    const f = AP_BY_KEY[k], d = MT.DEFAULTS[k];
    if (k === 'preset') return typeof v === 'string';
    if (!f || typeof v !== typeof d) return false;
    if (f.t === 'seg') return f.opts.some(o => o[0] === v);
    if (f.t === 'color') return /^#[0-9a-f]{6}$/i.test(v);
    if (f.t === 'text') return v.length <= f.max;
    return true;
  }
  function apSet(k, v, fromCode) {
    apDraft[k] = v; if (k !== 'preset' && !fromCode) apDraft.preset = 'custom';
    if (k === 'collapsed') setSide(!!v, true);
    MT.apply(apDraft); apSync();
  }
  function apSync() {
    for (const k of AP_KEYS) if (apCtl[k]) apCtl[k](apDraft[k]);
    document.querySelectorAll('#apPresets .preset').forEach(b => b.classList.toggle('on', b.dataset.id === apDraft.preset));
    const code = $('apCode'); if (document.activeElement !== code) code.value = JSON.stringify(Object.fromEntries(AP_KEYS.map(k => [k, apDraft[k]])));
    const dirty = apDirty(); $('apBar').classList.toggle('dirty', dirty); $('apSave').disabled = !dirty; $('apDiscard').disabled = !dirty;
    $('apTxt').lastChild.textContent = dirty ? 'You have unsaved changes (previewing live)' : 'All changes saved';
  }
  function apRevert() { apDraft = { ...apSaved }; MT.apply(apDraft); apSync(); }
  function mkEl(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function apBuild() {
    apBuilt = true;
    // presets
    const pbox = $('apPresets'); pbox.textContent = '';
    for (const [id, p] of Object.entries(MT.PRESETS)) {
      const t = { ...MT.DEFAULTS, ...p.t }, light = t.mode === 'light';
      const b = mkEl('button', 'preset'); b.type = 'button'; b.dataset.id = id;
      const pv = mkEl('div', 'pv'); const a = mkEl('i', 'pa'); a.style.background = light ? '#e8ecf5' : '#0e1424';
      const m = mkEl('i'); m.style.background = t.gradient ? `linear-gradient(135deg,${t.accent},${t.accent2})` : t.accent;
      const c = mkEl('i'); c.style.background = light ? '#ffffff' : '#1b2438';
      pv.append(a, m, c);
      b.append(pv, mkEl('b', '', p.label), mkEl('small', '', p.note));
      b.addEventListener('click', () => {
        apDraft = { ...MT.DEFAULTS, ...p.t, preset: id, brandName: apDraft.brandName, brandTag: apDraft.brandTag, collapsed: apDraft.collapsed };
        MT.apply(apDraft); apSync();
      });
      pbox.appendChild(b);
    }
    // option cards
    const form = $('apForm'); form.textContent = '';
    AP_GROUPS.forEach((g, gi) => {
      const card = mkEl('div', 'card step');
      const head = mkEl('div', 'stephead'); head.append(mkEl('span', 'stepno', String(gi + 2)));
      const hd = mkEl('div'); hd.append(mkEl('h2', '', g.title), mkEl('p', '', g.desc)); head.appendChild(hd); card.appendChild(head);
      const grp = mkEl('div', 'apgroup');
      for (const f of g.fields) {
        const row = mkEl('div', 'apfield'), lab = mkEl('div', 'lab'), ctl = mkEl('div', 'ctl');
        lab.append(mkEl('b', '', f.label), mkEl('span', '', f.help));
        if (f.t === 'seg') {
          const seg = mkEl('div', 'seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', f.label);
          const btns = f.opts.map(([val, txt]) => { const b = mkEl('button', '', txt); b.type = 'button'; b.addEventListener('click', () => apSet(f.k, val)); seg.appendChild(b); return [val, b]; });
          apCtl[f.k] = v => btns.forEach(([val, b]) => { b.classList.toggle('on', val === v); b.setAttribute('aria-pressed', String(val === v)); });
          ctl.appendChild(seg);
        } else if (f.t === 'switch') {
          const sw = mkEl('label', 'sw'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.setAttribute('aria-label', f.label);
          cb.addEventListener('change', () => apSet(f.k, cb.checked)); sw.append(cb, document.createElement('i'));
          apCtl[f.k] = v => { cb.checked = !!v; }; ctl.appendChild(sw);
        } else if (f.t === 'color') {
          const sws = [];
          if (f.swatches) {
            const box = mkEl('div', 'swatches');
            for (const c of MT.ACCENTS) { const s = mkEl('button', 'swatch'); s.type = 'button'; s.style.background = c; s.title = c; s.setAttribute('aria-label', 'Use colour ' + c); s.addEventListener('click', () => apSet(f.k, c)); box.appendChild(s); sws.push([c, s]); }
            ctl.appendChild(box);
          }
          const hx = mkEl('div', 'ap-hex'), pick = document.createElement('input'), txt = document.createElement('input');
          pick.type = 'color'; pick.setAttribute('aria-label', f.label); txt.type = 'text'; txt.maxLength = 7; txt.spellcheck = false; txt.autocapitalize = 'off'; txt.setAttribute('aria-label', f.label + ' (hex code)');
          pick.addEventListener('input', () => apSet(f.k, pick.value.toLowerCase()));
          txt.addEventListener('input', () => { const v = txt.value.trim(); if (/^#[0-9a-f]{6}$/i.test(v)) apSet(f.k, v.toLowerCase()); });
          hx.append(pick, txt); ctl.appendChild(hx);
          apCtl[f.k] = v => { pick.value = v; if (document.activeElement !== txt) txt.value = v; sws.forEach(([c, s]) => s.classList.toggle('on', c === v)); };
        } else {
          const inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = f.max; inp.placeholder = f.ph || ''; inp.autocomplete = 'off'; inp.setAttribute('aria-label', f.label);
          inp.addEventListener('input', () => apSet(f.k, inp.value));
          apCtl[f.k] = v => { if (inp.value !== v) inp.value = v; }; ctl.appendChild(inp);
        }
        row.append(lab, ctl); grp.appendChild(row);
      }
      card.appendChild(grp); form.appendChild(card);
    });
    $('apBackupNo').textContent = String(AP_GROUPS.length + 2);
  }
  async function loadTheme() {
    const d = await api('/api/admin/theme');
    apSaved = { ...MT.DEFAULTS, ...pickTheme(d.theme) }; apDraft = { ...apSaved };
    MT.apply(apSaved); MT.cache(apSaved);
    try { if (localStorage.getItem(SIDE_KEY) === null) setSide(apSaved.collapsed || innerWidth < 1100, false); } catch { /* private mode */ }
    if (!apBuilt) apBuild();
    apSync();
  }
  $('apSave').addEventListener('click', async () => {
    const btn = $('apSave'); btn.disabled = true;
    try {
      const d = await api('/api/admin/theme', { method: 'PUT', body: pickTheme(apDraft) });
      apSaved = { ...MT.DEFAULTS, ...pickTheme(d.theme) }; apDraft = { ...apSaved }; MT.cache(apSaved); MT.apply(apSaved); apSync();
      toast('Look saved', 'ok', 'It is used on every device you sign in from.'); $('apMsg').textContent = '';
    } catch (e) { fail($('apMsg'), e); apSync(); }
  });
  $('apDiscard').addEventListener('click', () => { apRevert(); toast('Changes discarded', 'info'); });
  $('apReset').addEventListener('click', () => { apDraft = { ...MT.DEFAULTS }; MT.apply(apDraft); apSync(); say($('apMsg'), 'The default look is loaded. Press “Save look” to keep it.', true); });
  $('apCopy').addEventListener('click', async () => {
    const t = $('apCode').value;
    try { await navigator.clipboard.writeText(t); toast('Theme code copied', 'ok'); } catch { $('apCode').select(); toast('Press Ctrl+C to copy the selected code', 'info'); }
  });
  $('apLoad').addEventListener('click', () => {
    let o; try { o = JSON.parse($('apCode').value); } catch { return say($('apMsg'), 'That is not a valid theme code.', false); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return say($('apMsg'), 'That is not a valid theme code.', false);
    const next = { ...MT.DEFAULTS }; let used = 0;
    for (const k of AP_KEYS) if (k in o && apValid(k, o[k])) { next[k] = o[k]; used++; }
    if (!used) return say($('apMsg'), 'No theme options were found in that code.', false);
    apDraft = next; MT.apply(apDraft); apSync(); $('apCode').blur(); apSync();
    say($('apMsg'), `Loaded ${used} option${used === 1 ? '' : 's'}. Press “Save look” to keep them.`, true);
  });

  /* ---------- themes & offers (admin → Themes & offers) ---------- */
  // Everything is edited in a draft and only stored when "Save" is pressed. The server validates every value again.
  const PM_COLORS = [['bg', 'Page background', 'Main dark colour behind everything'], ['bg2', 'Page background 2', 'Where the page fades to at the bottom'], ['c1', 'Accent 1', 'Headline gradient, pink buttons, glow'],
    ['c2', 'Accent 2', 'Second colour of gradients and buttons'], ['c3', 'Accent 3', 'Third gradient colour, soft glow'], ['c4', 'Highlight', 'Main button colour and the floor grid'], ['c5', 'Coin colour', 'Small details and $ coins']];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const PM = { saved: null, draft: null, presets: null, editId: 'christmas', status: null, prices: [], tz: '', built: false };
  const pmClone = o => JSON.parse(JSON.stringify(o));
  const pmDirty = () => !!PM.draft && JSON.stringify(PM.draft) !== JSON.stringify(PM.saved);
  const pmSpec = id => PM.draft.theme.edits[id] || PM.presets[id];
  function pmEditSpec(id) {                                            // the editable copy of a theme (created on first change)
    if (!PM.draft.theme.edits[id]) PM.draft.theme.edits[id] = pmClone(PM.presets[id]);
    return PM.draft.theme.edits[id];
  }
  function pmTidy(id) { const e = PM.draft.theme.edits[id]; if (e && JSON.stringify(e) === JSON.stringify(PM.presets[id])) delete PM.draft.theme.edits[id]; }

  function pmStatusText() {
    const st = PM.status?.offer || 'off', pill = $('pmStatus');
    const map = { off: 'Off', live: 'Live now', scheduled: 'Scheduled', ended: 'Ended' };
    pill.className = 'pm-pill ' + st; pill.textContent = map[st] || 'Off';
    if (pmDirty()) pill.textContent += ' (saved version)';
  }
  function pmPrices() {
    const o = PM.draft.offer, body = $('pmPrices'); body.textContent = '';
    let baseNew = null;
    for (const r of PM.prices) {
      const isBase = r.key === 'creation', hit = o.applies === 'all' || (o.applies === 'base' ? isBase : !isBase);
      const now = hit ? Math.round(r.original * (100 - (+o.discount || 0)) / 100 * 1e6) / 1e6 : r.original;
      if (isBase) baseNew = now;
      const tr = document.createElement('tr'), a = document.createElement('td'), b = document.createElement('td'), c = document.createElement('td');
      a.textContent = r.label; a.style.fontFamily = 'inherit'; b.textContent = r.original + ' SOL'; c.textContent = now + ' SOL'; c.className = 'new' + (now < r.original ? ' cut' : '');
      tr.append(a, b, c); body.appendChild(tr);
    }
    const net = 0.0091;
    $('pmPriceNote').textContent = (baseNew != null && baseNew < net)
      ? `Careful: the Solana network cost of a token is about ${net} SOL. A creation fee below that means you earn nothing on that token (visitors then pay only the network cost).`
      : `The network cost of a token (about ${net} SOL) is never discounted. It is taken out of the fees, and the rest goes to your revenue wallet.`;
  }
  function pmPreview() {
    const id = PM.editId, t = pmSpec(id), c = t.colors, rgbOf = h => parseInt(h.slice(1, 3), 16) + ',' + parseInt(h.slice(3, 5), 16) + ',' + parseInt(h.slice(5, 7), 16);
    const el = $('pmPrev').style;
    el.setProperty('--pv-bg', c.bg); el.setProperty('--pv-bg2', c.bg2); el.setProperty('--pv1', c.c1); el.setProperty('--pv2', c.c2); el.setProperty('--pv3', c.c3); el.setProperty('--pv4', c.c4);
    el.setProperty('--pv1-a', `rgba(${rgbOf(c.c1)},.3)`); el.setProperty('--pv3-a', `rgba(${rgbOf(c.c3)},.2)`);
    const strip = $('pmPrevStrip'); strip.hidden = !(t.bannerOn && t.banner); strip.textContent = t.banner || '';
    $('pmPrevEmo').textContent = (t.lights ? '💡 ' : '') + t.emojis.slice(0, 8).join(' ');
  }
  function pmGrid() {
    const grid = $('pmGrid'); grid.textContent = '';
    for (const id of Object.keys(PM.presets)) {
      const t = pmSpec(id), c = t.colors, b = document.createElement('button'); b.type = 'button'; b.className = 'preset' + (id === PM.editId ? ' on' : '');
      const pv = document.createElement('div'); pv.className = 'pv';
      for (const k of ['bg2', 'c1', 'c2', 'c3', 'c4']) { const i = document.createElement('i'); i.style.background = c[k]; pv.appendChild(i); }
      const nm = document.createElement('b'); nm.textContent = (t.emojis[0] || '') + ' ' + t.label;
      const note = document.createElement('small'); note.textContent = PM.presets[id].note;
      b.append(pv, nm, note);
      const showing = PM.status?.theme === id;
      if (showing) { const g = document.createElement('span'); g.className = 'tag'; g.textContent = 'Showing now'; b.appendChild(g); }
      else if (PM.draft.theme.edits[id]) { const g = document.createElement('span'); g.className = 'tag edited'; g.textContent = 'Edited'; b.appendChild(g); }
      b.addEventListener('click', () => { PM.editId = id; pmEditorFill(); pmGrid(); });
      grid.appendChild(b);
    }
  }
  function pmEditorFill() {
    const id = PM.editId, t = pmSpec(id);
    $('pmEdTitle').textContent = 'Edit theme: ' + t.label;
    $('pmLabelRow').hidden = id !== 'custom'; $('pmLabel').value = t.label;
    for (const [k] of PM_COLORS) { $('pmC_' + k).value = t.colors[k]; $('pmH_' + k).value = t.colors[k]; }
    $('pmEmojis').value = t.emojis.join(' '); $('pmEffect').value = t.effect; $('pmDensity').value = t.density;
    $('pmCoins').checked = t.coins; $('pmLights').checked = t.lights; $('pmBannerOn').checked = t.bannerOn; $('pmBanner').value = t.banner;
    $('pmResetTheme').disabled = !PM.draft.theme.edits[id];
    pmPreview();
  }
  function pmSched() {
    const body = $('pmSched'); body.textContent = '';
    for (const id of Object.keys(PM.presets)) {
      const sc = PM.draft.theme.schedule[id], tr = document.createElement('tr');
      const c0 = document.createElement('td'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sc.on; cb.setAttribute('aria-label', 'Turn on ' + PM.presets[id].label);
      cb.addEventListener('change', () => { sc.on = cb.checked; pmSync(); }); c0.appendChild(cb);
      const c1 = document.createElement('td'); c1.textContent = (pmSpec(id).emojis[0] || '') + ' ' + pmSpec(id).label;
      const mk = key => {
        const td = document.createElement('td'), box = document.createElement('div'); box.className = 'dm';
        const sel = document.createElement('select'), day = document.createElement('input'); sel.setAttribute('aria-label', key + ' month'); day.setAttribute('aria-label', key + ' day');
        MONTHS.forEach((m, i) => { const o = document.createElement('option'); o.value = String(i + 1).padStart(2, '0'); o.textContent = m.slice(0, 3); sel.appendChild(o); });
        day.type = 'number'; day.min = 1; day.max = 31; day.inputMode = 'numeric';
        sel.value = sc[key].slice(0, 2); day.value = +sc[key].slice(3);
        const upd = () => { const d = Math.min(31, Math.max(1, parseInt(day.value, 10) || 1)); sc[key] = sel.value + '-' + String(d).padStart(2, '0'); pmSync(); };
        sel.addEventListener('change', upd); day.addEventListener('change', () => { upd(); day.value = +sc[key].slice(3); });
        box.append(sel, day); td.appendChild(box); return td;
      };
      tr.append(c0, c1, mk('from'), mk('to')); body.appendChild(tr);
    }
  }
  function pmActiveSelect() {
    const sel = $('pmActive'); sel.textContent = '';
    for (const id of Object.keys(PM.presets)) { const o = document.createElement('option'); o.value = id; o.textContent = pmSpec(id).label; sel.appendChild(o); }
    sel.value = PM.draft.theme.active;
  }
  // push the draft into every control (used after load / discard / reset)
  function pmFill() {
    const o = PM.draft.offer;
    $('pmOn').checked = o.on; $('pmTitle').value = o.title; $('pmBadge').value = o.badge; $('pmText').value = o.text; $('pmDiscount').value = o.discount; $('pmApplies').value = o.applies;
    $('pmStart').value = o.start; $('pmEnd').value = o.end; $('pmCountdown').checked = o.countdown; $('pmLanding').checked = o.landing; $('pmCreator').checked = o.creator;
    $('pmCta').value = o.cta; $('pmCtaUrl').value = o.ctaUrl;
    $('pmTzNote').textContent = `Times are in the reports timezone (${PM.tz}), set under Pricing & network.`;
    $('pmMode').value = PM.draft.theme.mode; pmActiveSelect(); pmGrid(); pmEditorFill(); pmSched(); pmPrices(); pmSync();
  }
  function pmSync() {
    const d = pmDirty(), bar = $('pmBar');
    bar.classList.toggle('dirty', d); $('pmSave').disabled = !d; $('pmDiscard').disabled = !d;
    $('pmTxt').lastChild.textContent = d ? 'You have unsaved changes' : 'All changes saved';
    $('pmActiveBox').style.opacity = PM.draft.theme.mode === 'manual' ? '1' : '.45'; $('pmActive').disabled = PM.draft.theme.mode !== 'manual';
    pmStatusText();
  }
  function pmBuild() {
    if (PM.built) return; PM.built = true;
    const wrap = $('pmColors');
    for (const [k, label, help] of PM_COLORS) {
      const cw = document.createElement('div'); cw.className = 'cw';
      const lb = document.createElement('label'); lb.textContent = label; lb.setAttribute('for', 'pmH_' + k);
      const row = document.createElement('div'); row.className = 'ap-hex';
      const col = document.createElement('input'); col.type = 'color'; col.id = 'pmC_' + k; col.setAttribute('aria-label', label + ' colour picker');
      const hex = document.createElement('input'); hex.type = 'text'; hex.id = 'pmH_' + k; hex.maxLength = 7; hex.spellcheck = false; hex.autocomplete = 'off';
      const set = v => { pmEditSpec(PM.editId).colors[k] = v.toLowerCase(); col.value = v; hex.value = v; pmTidy(PM.editId); pmPreview(); pmGrid(); pmSync(); $('pmResetTheme').disabled = !PM.draft.theme.edits[PM.editId]; };
      col.addEventListener('input', () => set(col.value));
      hex.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(hex.value.trim())) set(hex.value.trim()); });
      hex.addEventListener('blur', () => { hex.value = pmSpec(PM.editId).colors[k]; });
      row.append(col, hex); const sm = document.createElement('small'); sm.textContent = help; cw.append(lb, row, sm); wrap.appendChild(cw);
    }
    const edit = fn => () => { fn(pmEditSpec(PM.editId)); pmTidy(PM.editId); pmPreview(); pmGrid(); pmSched(); pmSync(); $('pmResetTheme').disabled = !PM.draft.theme.edits[PM.editId]; };
    $('pmLabel').addEventListener('input', edit(t => { t.label = $('pmLabel').value; }));
    $('pmEmojis').addEventListener('input', edit(t => { t.emojis = [...new Set($('pmEmojis').value.split(/\s+/).filter(Boolean))].slice(0, 14); }));
    $('pmEffect').addEventListener('change', edit(t => { t.effect = $('pmEffect').value; }));
    $('pmDensity').addEventListener('change', edit(t => { t.density = $('pmDensity').value; }));
    $('pmCoins').addEventListener('change', edit(t => { t.coins = $('pmCoins').checked; }));
    $('pmLights').addEventListener('change', edit(t => { t.lights = $('pmLights').checked; }));
    $('pmBannerOn').addEventListener('change', edit(t => { t.bannerOn = $('pmBannerOn').checked; }));
    $('pmBanner').addEventListener('input', edit(t => { t.banner = $('pmBanner').value; }));
    $('pmResetTheme').addEventListener('click', () => { delete PM.draft.theme.edits[PM.editId]; pmFill(); });
    $('pmUse').addEventListener('click', () => { PM.draft.theme.mode = 'manual'; PM.draft.theme.active = PM.editId; pmFill(); toast('Theme will show after you press Save', 'info', pmSpec(PM.editId).label); });
    const off = (id, key, ev = 'input', get = el => el.value) => $(id).addEventListener(ev, () => { PM.draft.offer[key] = get($(id)); if (key === 'discount' || key === 'applies') pmPrices(); pmSync(); });
    const chk = el => el.checked;
    off('pmOn', 'on', 'change', chk); off('pmTitle', 'title'); off('pmBadge', 'badge'); off('pmText', 'text'); off('pmApplies', 'applies', 'change');
    off('pmDiscount', 'discount', 'input', el => el.value === '' ? '' : Number(el.value));
    off('pmStart', 'start', 'change'); off('pmEnd', 'end', 'change'); off('pmCountdown', 'countdown', 'change', chk); off('pmLanding', 'landing', 'change', chk); off('pmCreator', 'creator', 'change', chk);
    off('pmCta', 'cta'); off('pmCtaUrl', 'ctaUrl');
    $('pmMode').addEventListener('change', () => { PM.draft.theme.mode = $('pmMode').value; pmSync(); });
    $('pmActive').addEventListener('change', () => { PM.draft.theme.active = $('pmActive').value; pmSync(); });
    $('pmDiscard').addEventListener('click', () => { PM.draft = pmClone(PM.saved); pmFill(); say($('pmMsg'), 'Changes discarded.', true); });
    $('pmSave').addEventListener('click', pmSave);
    $('pmReset').addEventListener('click', async () => {
      if (!confirm('Switch off the offer and the theme, and reset every theme to its original colours and text?')) return;
      try { pmApply(await api('/api/admin/promo', { method: 'DELETE' })); toast('Everything reset', 'ok', 'The site is back to its normal look.'); } catch (e) { toast(e.message, 'err'); }
    });
  }
  function pmApply(d) {
    PM.saved = d.promo; PM.draft = pmClone(d.promo); PM.presets = d.presets; PM.status = d.status; PM.prices = d.prices; PM.tz = d.timezone;
    pmBuild(); pmFill();
  }
  async function pmSave() {
    const o = PM.draft.offer;
    if (o.discount === '' || !Number.isInteger(Number(o.discount))) return say($('pmMsg'), 'Discount must be a whole number from 0 to 90.', false);
    try {
      const d = await api('/api/admin/promo', { method: 'PUT', body: PM.draft });
      pmApply(d); say($('pmMsg'), '', true);
      toast('Saved', 'ok', 'Visitors see the change when they refresh the page.');
    } catch (e) { say($('pmMsg'), e.message, false); toast('Could not save', 'err', e.message); }
  }
  async function loadPromo() { if (pmDirty()) return; pmApply(await api('/api/admin/promo')); }

  /* ---------- sidebar navigation ---------- */
  const TITLES = { overview: 'Overview', reports: 'Reports', wallets: 'Wallets', database: 'Database', settings: 'Pricing & network', branding: 'Branding', appearance: 'Appearance', promo: 'Themes & offers', security: 'Security' };
  function route() {
    const page = TITLES[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
    if (page !== 'appearance' && apDirty()) { apRevert(); toast('Appearance changes were not saved', 'info', 'The look went back to your saved theme.'); }
    document.querySelectorAll('section.page').forEach(s => { s.hidden = s.dataset.page !== page; });
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
    $('pageTitle').textContent = TITLES[page];
    document.body.classList.remove('nav-open');
    window.scrollTo(0, 0);
    if (!$('dashView').hidden && !live.timer) liveStart();
    if (!$('dashView').hidden) {
      if (page === 'database') loadDb().catch(() => {});
      if (page === 'reports') { loadStats().catch(() => {}); loadReportLists(); }
      if (page === 'wallets') loadWalletOptions().catch(e => fail($('wMsg'), e));
      if (page === 'promo') loadPromo().catch(e => toast('Could not load themes & offers', 'err', e.message));
    }
  }
  // desktop: collapse the sidebar to an icon rail (remembered). "[" is the keyboard shortcut.
  const SIDE_KEY = 'mf_side_collapsed';
  document.querySelectorAll('#nav a').forEach(a => { a.dataset.tip = a.querySelector('.lbl')?.textContent.trim() || ''; });
  document.querySelectorAll('.side-foot .btn').forEach(b => { b.dataset.tip = b.querySelector('.lbl')?.textContent.trim() || ''; b.title = b.dataset.tip; });
  function setSide(collapsed, save) {
    document.body.classList.toggle('side-collapsed', collapsed);
    $('sideToggle').setAttribute('aria-expanded', String(!collapsed)); $('sideToggle').setAttribute('aria-label', collapsed ? 'Expand menu' : 'Collapse menu');
    if (save) { try { localStorage.setItem(SIDE_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ } }
  }
  try { const v = localStorage.getItem(SIDE_KEY); setSide(v === null ? innerWidth < 1100 : v === '1', false); } catch { setSide(innerWidth < 1100, false); }   // tablets start with the slim menu
  $('sideToggle').addEventListener('click', () => setSide(!document.body.classList.contains('side-collapsed'), true));
  document.addEventListener('keydown', e => { if (e.key === '[' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && !$('dashView').hidden && innerWidth > 900) setSide(!document.body.classList.contains('side-collapsed'), true); });
  window.addEventListener('hashchange', route);
  $('menuBtn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
  route();

  /* ---------- start ---------- */
  applyLogo();
  (async () => {
    try { const me = await api('/api/admin/me'); if (me.loggedIn) await showDash(); else showLogin(); }
    catch { showLogin(); }
  })();
})();
