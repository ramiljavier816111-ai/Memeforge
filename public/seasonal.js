/* MemeForge — seasonal theme + special offer (public pages).
   Reads window.MEMEFORGE_CONFIG.promo from /fees-config.js (set in admin → Themes & offers) and:
     • recolours the page (CSS variables) and swaps the floating background for the theme's emoji,
     • shows a thin greeting strip and optional string of lights,
     • shows the special-offer bar with a live countdown.
   Everything is drawn with textContent / DOM nodes and values already validated by the server.
   Load it after fees-config.js on every public page. With no theme and no offer it does nothing. */
(function () {
  'use strict';
  var promo = (window.MEMEFORGE_CONFIG || {}).promo;
  if (!promo || (!promo.theme && !promo.offer)) return;
  var isCreator = /solana-token-creator/.test(location.pathname);
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var HEX = /^#[0-9a-f]{6}$/i;

  function rgb(h) { h = HEX.test(h) ? h : '#ffffff'; return parseInt(h.slice(1, 3), 16) + ',' + parseInt(h.slice(3, 5), 16) + ',' + parseInt(h.slice(5, 7), 16); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function money(x) { return (+Number(x).toFixed(4)) + ' SOL'; }
  function ready(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }

  /* ---------------------------------------------------------------- theme */
  function applyTheme(t) {
    var c = t.colors || {}, bad = ['bg', 'bg2', 'c1', 'c2', 'c3', 'c4', 'c5'].some(function (k) { return !HEX.test(c[k]); });
    if (bad) return;
    var root = document.documentElement.style;
    root.setProperty('--bg', c.bg); root.setProperty('--bg-2', c.bg2);
    root.setProperty('--pink', c.c1); root.setProperty('--purple', c.c2); root.setProperty('--cyan', c.c3); root.setProperty('--lime', c.c4); root.setProperty('--yellow', c.c5);
    var css = [
      '.bg{background:radial-gradient(55vw 50vh at 85% 0%,rgba(' + rgb(c.c1) + ',.28),transparent 70%),radial-gradient(55vw 55vh at 0% 30%,rgba(' + rgb(c.c3) + ',.18),transparent 70%),radial-gradient(60vw 50vh at 70% 100%,rgba(' + rgb(c.c2) + ',.28),transparent 70%),linear-gradient(180deg,var(--bg),var(--bg-2)) !important}',
      '.bg::before{background-image:linear-gradient(rgba(' + rgb(c.c4) + ',.2) 1px,transparent 1px),linear-gradient(90deg,rgba(' + rgb(c.c4) + ',.2) 1px,transparent 1px) !important}',
      '.btn-lime{--glow:' + rgb(c.c4) + ' !important}.btn-pink,.btn-primary{--glow:' + rgb(c.c1) + ' !important}',
      '.bg > .float,.bg > .coin-bg{display:none !important}',                      // the page\'s own floaters are replaced by the theme\'s
      '.mf-fx{position:absolute;inset:0;overflow:hidden;pointer-events:none}',
      '.mf-p{position:absolute;top:0;left:0;user-select:none;will-change:transform;filter:drop-shadow(0 6px 14px rgba(0,0,0,.35))}',
      '.mf-p.rise{animation:mfRise linear infinite}.mf-p.fall{animation:mfFall linear infinite}',
      '@keyframes mfRise{0%{transform:translate3d(0,110vh,0) rotate(0)}100%{transform:translate3d(var(--dx,0),-20vh,0) rotate(var(--rot,360deg))}}',
      '@keyframes mfFall{0%{transform:translate3d(0,-12vh,0) rotate(0)}100%{transform:translate3d(var(--dx,0),112vh,0) rotate(var(--rot,360deg))}}',
      '.mf-coin{display:grid;place-items:center;border-radius:50%;font-family:var(--display,inherit);color:rgba(0,0,0,.55);background:radial-gradient(circle at 32% 28%,#fff,var(--yellow) 45%,rgba(0,0,0,.25));border:3px solid rgba(0,0,0,.25)}',
      '.mf-strip{position:relative;z-index:60;text-align:center;font:600 13.5px/1.35 var(--body,system-ui,sans-serif);padding:7px 14px;color:#fff;background:linear-gradient(100deg,' + c.c1 + ',' + c.c2 + ');text-shadow:0 1px 2px rgba(0,0,0,.35)}',
      '.mf-lights{position:relative;z-index:61;height:22px;overflow:hidden;display:flex;justify-content:space-between;padding:0 6px;pointer-events:none;border-bottom:1px solid rgba(255,255,255,.08)}',
      '.mf-lights i{flex:0 0 auto;width:9px;height:13px;margin-top:5px;border-radius:50% 50% 55% 55%;background:var(--lc);box-shadow:0 0 10px 2px var(--lc);animation:mfTwinkle 1.6s ease-in-out infinite}',
      '@keyframes mfTwinkle{0%,100%{opacity:1}50%{opacity:.28}}',
      '@media (min-width:1600px){.mf-strip{font-size:15.5px;padding:9px 18px}}@media (max-width:380px){.mf-strip{font-size:12.5px;padding:6px 10px}}',
    ];
    var st = el('style'); st.id = 'mf-theme'; st.textContent = css.join('\n'); document.head.appendChild(st);
    ready(function () { build(t); });
  }

  function build(t) {
    var c = t.colors, body = document.body, anchor = body.firstChild;
    // lights + greeting strip go at the very top of the page, before the nav
    var top = document.createDocumentFragment();
    if (t.lights) {
      var l = el('div', 'mf-lights'), cols = [c.c1, c.c4, c.c3, c.c2], n = Math.min(60, Math.ceil(innerWidth / 26));
      l.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < n; i++) { var b = el('i'); b.style.setProperty('--lc', cols[i % cols.length]); if (!reduce) b.style.animationDelay = (-(i % 5) * .3) + 's'; l.appendChild(b); }
      top.appendChild(l);
    }
    if (t.bannerOn && t.banner) { var s = el('div', 'mf-strip', t.banner); s.setAttribute('role', 'note'); top.appendChild(s); }
    var bg = document.getElementById('bg');
    if (top.childNodes.length) body.insertBefore(top, bg && bg.nextSibling ? bg.nextSibling : anchor);
    if (!bg || !t.emojis || !t.emojis.length || t.effect === 'none' && !t.coins) return;

    var fx = el('div', 'mf-fx'); bg.appendChild(fx);
    var small = innerWidth < 700, base = small ? 14 : 28, n2 = Math.round(base * ({ low: .5, normal: 1, high: 1.6 }[t.density] || 1));
    var rnd = function (a, b) { return a + Math.random() * (b - a); }, dir = t.effect === 'fall' ? 'fall' : 'rise';
    for (var j = 0; j < n2; j++) {
      var coin = t.coins && j % 4 === 0, p = el('div', 'mf-p ' + (t.effect === 'none' ? '' : dir));
      var size = coin ? rnd(26, 58) : rnd(20, 44);
      if (coin) { p.className += ' mf-coin'; p.style.width = p.style.height = size + 'px'; p.style.fontSize = size * .5 + 'px'; p.textContent = '$'; }
      else { p.style.fontSize = size + 'px'; p.textContent = t.emojis[j % t.emojis.length]; }
      p.style.left = rnd(0, 100) + 'vw'; p.style.opacity = rnd(.3, .75).toFixed(2);
      if (reduce || t.effect === 'none') { p.style.top = rnd(2, 90) + 'vh'; p.style.opacity = '.22'; }       // still pictures only
      else {
        p.style.animationDuration = rnd(dir === 'fall' ? 12 : 16, dir === 'fall' ? 28 : 38) + 's'; p.style.animationDelay = (-rnd(0, 38)) + 's';
        p.style.setProperty('--dx', rnd(-18, 18) + 'vw'); p.style.setProperty('--rot', (Math.random() < .5 ? -1 : 1) * rnd(120, 480) + 'deg');
      }
      fx.appendChild(p);
    }
  }

  /* ---------------------------------------------------------------- offer */
  function applyOffer(o) {
    if (isCreator ? !o.creator : !o.landing) return;
    try { if (sessionStorage.getItem('mf_offer_x') === o.title + '|' + o.discount) return; } catch (e) { /* private mode */ }
    ready(function () {
      var st = document.createElement('style'); st.id = 'mf-offer-css';
      st.textContent = [
        '.mf-offer{position:relative;z-index:59;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px 16px;padding:11px 44px 11px 16px;font:500 14px/1.4 var(--body,system-ui,sans-serif);color:var(--text,#fff);',
        'background:linear-gradient(100deg,rgba(' + rgb(cssVar('--pink', '#ff3df2')) + ',.22),rgba(' + rgb(cssVar('--purple', '#8b4dff')) + ',.22)),var(--bg,#0a0614);border-bottom:1px solid rgba(255,255,255,.16)}',
        '.mf-offer .mf-badge{font:800 13px/1 var(--display,inherit);letter-spacing:.4px;padding:7px 11px;border-radius:99px;color:#0a0614;background:var(--lime,#b6ff3b);white-space:nowrap}',
        '.mf-offer .mf-t{font-weight:700}.mf-offer .mf-d{opacity:.85}',
        '.mf-offer .mf-price{white-space:nowrap}.mf-offer .mf-price s{opacity:.6;margin-right:5px}.mf-offer .mf-price b{color:var(--lime,#b6ff3b)}',
        '.mf-offer .mf-time{display:inline-flex;gap:5px;font-family:var(--mono,ui-monospace,monospace);font-size:13px}',
        '.mf-offer .mf-time span{min-width:38px;text-align:center;padding:3px 5px;border-radius:7px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.14)}',
        '.mf-offer .mf-time small{display:block;font-size:9px;opacity:.7;text-transform:uppercase;letter-spacing:.4px}',
        '.mf-offer .mf-cta{padding:8px 15px;border-radius:99px;background:var(--text,#fff);color:var(--bg,#0a0614);font-weight:700;text-decoration:none;white-space:nowrap}',
        '.mf-offer .mf-x{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:inherit;font-size:20px;line-height:1;cursor:pointer;opacity:.7}',
        '.mf-offer .mf-x:hover{opacity:1;background:rgba(255,255,255,.12)}',
        '.mf-was{opacity:.55;margin-right:6px;font-weight:400}',
        '.mf-saved{color:var(--lime,#b6ff3b);font-weight:700}',
        '@media (max-width:640px){.mf-offer{font-size:13px;padding:10px 40px 10px 12px;gap:8px 12px}}',
        '@media (max-width:380px){.mf-offer .mf-time span{min-width:33px;padding:3px 3px}.mf-offer .mf-cta{padding:7px 13px}.mf-offer .mf-price{white-space:normal}}',
        '@media (min-width:1600px){.mf-offer{font-size:15.5px;padding-top:13px;padding-bottom:13px}.mf-offer .mf-time{font-size:14.5px}}',
      ].join('');
      document.head.appendChild(st);

      var bar = el('div', 'mf-offer'); bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Special offer');
      var badge = o.badge || (o.discount ? o.discount + '% OFF' : '');
      if (badge) bar.appendChild(el('span', 'mf-badge', badge));
      var msg = el('span'); msg.appendChild(el('span', 'mf-t', o.title));
      if (o.text) msg.appendChild(el('span', 'mf-d', ' — ' + o.text));
      bar.appendChild(msg);
      if (o.original && o.pricesNow && o.original.creationFee !== o.pricesNow.creationFee) {
        var pr = el('span', 'mf-price', 'Create a token: '); pr.appendChild(el('s', '', money(o.original.creationFee))); pr.appendChild(el('b', '', money(o.pricesNow.creationFee))); bar.appendChild(pr);
      }
      var timer = null;
      if (o.countdown && o.endsAt) {
        var box = el('span', 'mf-time'), cells = {};
        [['d', 'days'], ['h', 'hrs'], ['m', 'min'], ['s', 'sec']].forEach(function (u) { var s = el('span', '', '0'); s.appendChild(el('small', '', u[1])); box.appendChild(s); cells[u[0]] = s; });
        bar.appendChild(box);
        var offset = o.serverNow ? Date.now() - o.serverNow : 0;                    // so a wrong clock on the visitor's device does not matter
        var tick = function () {
          var left = Math.max(0, o.endsAt - (Date.now() - offset)), s = Math.floor(left / 1000);
          var v = { d: Math.floor(s / 86400), h: Math.floor(s % 86400 / 3600), m: Math.floor(s % 3600 / 60), s: s % 60 };
          Object.keys(cells).forEach(function (k) { var n = cells[k], small = n.querySelector('small'); n.textContent = String(v[k]).padStart(2, '0'); n.appendChild(small); });
          box.firstChild.style.display = v.d ? '' : 'none';
          if (!left) {
            clearInterval(timer); box.remove(); msg.textContent = 'This offer has ended. Refresh the page to see the current prices.';
            var gone = bar.querySelector('.mf-price, .mf-badge, .mf-cta'); while (gone) { gone.remove(); gone = bar.querySelector('.mf-price, .mf-badge, .mf-cta'); }
            setTimeout(function () { bar.remove(); }, 90000);
          }
        };
        tick(); timer = setInterval(tick, 1000);
      }
      var url = o.ctaUrl || (isCreator ? '' : 'solana-token-creator.html');
      if (o.cta && url) { var a = el('a', 'mf-cta', o.cta); a.href = url; if (/^https:/.test(url)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } bar.appendChild(a); }
      var x = el('button', 'mf-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Hide this offer');
      x.addEventListener('click', function () { clearInterval(timer); bar.remove(); try { sessionStorage.setItem('mf_offer_x', o.title + '|' + o.discount); } catch (e) { /* ignore */ } });
      bar.appendChild(x);

      var strip = document.querySelector('.mf-strip'), lights = document.querySelector('.mf-lights'), bg = document.getElementById('bg');
      var after = strip || lights || bg;
      document.body.insertBefore(bar, after ? after.nextSibling : document.body.firstChild);
    });
  }
  function cssVar(name, fallback) { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return HEX.test(v) ? v : fallback; }

  // The creator page calls this to show the old price next to the new one and how much the visitor saves.
  window.MF_OFFER = promo.offer ? {
    discount: promo.offer.discount, title: promo.offer.title,
    was: function (kind) { var o = promo.offer.original; if (!o) return null; return kind === 'creation' ? o.creationFee : (o.featureFees || {})[kind]; },
  } : null;

  if (promo.theme) applyTheme(promo.theme);
  if (promo.offer) applyOffer(promo.offer);
})();
