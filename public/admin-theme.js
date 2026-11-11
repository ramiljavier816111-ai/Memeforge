/* MemeForge admin — theme engine.
   Loaded in <head> (before the page paints) so the last theme used on this browser is applied instantly, then
   admin.js loads the saved theme from the server (admin → Appearance) and calls MFTheme.apply() again.

   A theme is a plain object (see DEFAULTS). It is turned into CSS variables + data-attributes on <html>;
   admin.html reads them. The server checks every value against a fixed list (cleanTheme in server.js), so
   nothing the admin types is ever used as markup or CSS. */
(function () {
  'use strict';
  const KEY = 'mf_admin_theme';

  const DEFAULTS = {
    preset: 'midnight', mode: 'dark',
    accent: '#7c5cff', accent2: '#22d3ee', gradient: true,
    bg: 'aurora', card: 'glass', blur: true,
    font: 'system', fontSize: 'normal', radius: 'round', density: 'comfortable',
    sidebar: 'glass', navStyle: 'soft', collapsed: false,
    width: 'normal', animations: true, zebra: false,
    brandName: 'MemeForge', brandTag: 'Admin panel',
  };

  // One-click looks. Only what differs from DEFAULTS is listed.
  const PRESETS = {
    midnight: { label: 'Midnight',  note: 'The default: violet glow',   t: {} },
    ocean:    { label: 'Ocean',     note: 'Cool blue and indigo',       t: { accent: '#0ea5e9', accent2: '#6366f1' } },
    emerald:  { label: 'Emerald',   note: 'Fresh green',                t: { accent: '#10b981', accent2: '#84cc16' } },
    sunset:   { label: 'Sunset',    note: 'Orange to pink',             t: { accent: '#f97316', accent2: '#ec4899' } },
    rose:     { label: 'Rose',      note: 'Rose and purple',            t: { accent: '#f43f5e', accent2: '#a855f7', radius: 'pill' } },
    graphite: { label: 'Graphite',  note: 'Quiet, flat and serious',    t: { accent: '#6366f1', accent2: '#6366f1', gradient: false, bg: 'plain', card: 'solid', blur: false, radius: 'soft', density: 'compact', sidebar: 'solid', navStyle: 'bar', zebra: true } },
    daylight: { label: 'Daylight',  note: 'Clean light mode',           t: { mode: 'light', accent: '#4f46e5', accent2: '#06b6d4', bg: 'dots', card: 'solid', sidebar: 'solid' } },
    paper:    { label: 'Paper',     note: 'Warm light, serif text',     t: { mode: 'light', accent: '#c2410c', accent2: '#d97706', gradient: false, bg: 'plain', card: 'outline', font: 'serif', radius: 'soft', sidebar: 'solid', navStyle: 'bar' } },
  };

  const ACCENTS = ['#7c5cff', '#0ea5e9', '#10b981', '#f97316', '#f43f5e', '#eab308', '#ec4899', '#64748b'];

  const FONTS = {
    system:  'ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
    rounded: 'ui-rounded,"SF Pro Rounded","Hiragino Maru Gothic ProN","Nunito","Quicksand",ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif',
    serif:   'ui-serif,Georgia,"Iowan Old Style","Palatino Linotype","Times New Roman",serif',
    mono:    'ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace',
  };
  const RADIUS = { sharp: [4, 3, 2, 3], soft: [10, 8, 6, 8], round: [16, 11, 8, 11], pill: [24, 16, 12, 99] };   // card, control, small, button
  const DENSITY = { compact: [14, 36, 7, 7], comfortable: [20, 42, 9, 11], spacious: [26, 48, 12, 15] };          // card padding, control height, nav padding, table cell padding
  const SIZE = { small: 0.92, normal: 1, large: 1.1 };
  const WIDTH = { narrow: '980px', normal: '1240px', wide: '1480px', full: 'none' };

  const hex = h => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const toHex = a => '#' + a.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
  const rgb = h => hex(h).join(',');

  const merge = t => Object.assign({}, DEFAULTS, t && typeof t === 'object' ? t : {});
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  let current = merge(null);

  function apply(theme) {
    const t = current = merge(theme), root = document.documentElement, st = root.style;
    const light = t.mode === 'light' || (t.mode === 'auto' && media && media.matches);
    const a = /^#[0-9a-f]{6}$/i.test(t.accent) ? t.accent : DEFAULTS.accent, b = /^#[0-9a-f]{6}$/i.test(t.accent2) ? t.accent2 : DEFAULTS.accent2;
    // accent (buttons, active nav), soft accent (text highlights), second colour (gradient end, small highlights)
    const soft = light ? mix(a, '#000000', 0.12) : mix(a, '#ffffff', 0.4);
    st.setProperty('--accent', a); st.setProperty('--accent2', soft); st.setProperty('--cyan', light ? mix(b, '#000000', 0.15) : b); st.setProperty('--pink', soft);
    st.setProperty('--accent-rgb', rgb(a)); st.setProperty('--accent2-rgb', rgb(b));
    st.setProperty('--grad', t.gradient ? `linear-gradient(135deg,${a} 0%,${mix(a, b, 0.5)} 55%,${b} 100%)` : `linear-gradient(135deg,${a},${a})`);
    st.setProperty('--font', FONTS[t.font] || FONTS.system);
    const r = RADIUS[t.radius] || RADIUS.round, d = DENSITY[t.density] || DENSITY.comfortable;
    st.setProperty('--r', r[0] + 'px'); st.setProperty('--r-ctl', r[1] + 'px'); st.setProperty('--r-sm', r[2] + 'px'); st.setProperty('--r-btn', r[3] + 'px');
    st.setProperty('--pad', d[0] + 'px'); st.setProperty('--ctl', d[1] + 'px'); st.setProperty('--navpad', d[2] + 'px'); st.setProperty('--cellpad', d[3] + 'px');
    st.setProperty('--fs', String(SIZE[t.fontSize] || 1));
    st.setProperty('--cw', WIDTH[t.width] || WIDTH.normal);
    root.dataset.mode = light ? 'light' : 'dark';
    root.dataset.bg = t.bg; root.dataset.card = t.card; root.dataset.sidebar = t.sidebar; root.dataset.nav = t.navStyle;
    root.dataset.blur = t.blur ? 'on' : 'off'; root.dataset.anim = t.animations ? 'on' : 'off'; root.dataset.zebra = t.zebra ? 'on' : 'off'; root.dataset.grad = t.gradient ? 'on' : 'off';
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = light ? '#f4f6fb' : '#070a13';
    brand();
    return t;
  }
  function brand() {
    if (!document.body) return;
    const n = current.brandName || DEFAULTS.brandName, tag = current.brandTag === undefined ? DEFAULTS.brandTag : current.brandTag;
    document.querySelectorAll('[data-brand-name]').forEach(e => { e.textContent = n; });
    document.querySelectorAll('[data-brand-tag]').forEach(e => { e.textContent = tag; });
    document.title = n + ' Admin';
  }
  function cache(t) { try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* private mode: nothing to remember */ } }
  function cached() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }

  window.MFTheme = { DEFAULTS, PRESETS, ACCENTS, FONTS, merge, apply, cache, cached, brand, get current() { return current; } };

  apply(cached());                                                    // before first paint: no flash of the wrong theme
  document.addEventListener('DOMContentLoaded', brand);
  if (media && media.addEventListener) media.addEventListener('change', () => { if (current.mode === 'auto') apply(current); });
})();
