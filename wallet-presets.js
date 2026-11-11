/* =====================================================================
   MemeForge — wallet catalog (admin → Wallets → "Popular wallets")

   Each line:  name | website/install link | category | provider | detection flag | color
   - provider = where the wallet's browser extension / in-app browser puts itself on `window`
     (e.g. phantom.solana). Wallets WITH a provider can connect on the token creator when
     detected. Wallets WITHOUT one still show in the popup, but only as an "Install" link.
   - The first block (phantom … magiceden) comes from the original project and is the
     "top" set offered by default. Providers on the other lines are best-known values and
     have NOT been tested against every wallet version: if a wallet is installed but not
     shown as "Detected", fix its Provider in admin → Wallets → Edit.
   ===================================================================== */
'use strict';

const TOP = [
  { id: 'phantom',  name: 'Phantom',         provider: 'phantom.solana',     flag: 'isPhantom',     color: '#6b5cf0', install_url: 'https://phantom.app/download', deeplink: 'https://phantom.app/ul/browse/{url}?ref={ref}', cat: 'Popular' },
  { id: 'solflare', name: 'Solflare',        provider: 'solflare',           flag: 'isSolflare',    color: '#fc8c1a', install_url: 'https://solflare.com/download', deeplink: 'https://solflare.com/ul/v1/browse/{url}?ref={ref}', cat: 'Popular' },
  { id: 'backpack', name: 'Backpack',        provider: 'backpack',           flag: 'isBackpack',    color: '#e33e3f', install_url: 'https://backpack.app/downloads', deeplink: 'https://backpack.app/ul/v1/browse/{url}?ref={ref}', cat: 'Popular' },
  { id: 'coinbase', name: 'Coinbase Wallet', provider: 'coinbaseSolana',     flag: '',              color: '#0052ff', install_url: 'https://www.coinbase.com/wallet/downloads', deeplink: 'https://go.cb-w.com/dapp?cb_url={url}', cat: 'Popular' },
  { id: 'trust',    name: 'Trust Wallet',    provider: 'trustwallet.solana', flag: '',              color: '#3375bb', install_url: 'https://trustwallet.com/download', deeplink: 'https://link.trustwallet.com/open_url?coin_id=501&url={url}', cat: 'Popular' },
  { id: 'okx',      name: 'OKX Wallet',      provider: 'okxwallet.solana',   flag: '',              color: '#222222', install_url: 'https://www.okx.com/web3', deeplink: '', cat: 'Popular' },
  { id: 'exodus',   name: 'Exodus',          provider: 'exodus.solana',      flag: '',              color: '#7b61ff', install_url: 'https://www.exodus.com/download/', deeplink: '', cat: 'Popular' },
  { id: 'brave',    name: 'Brave Wallet',    provider: 'braveSolana',        flag: 'isBraveWallet', color: '#fb542b', install_url: 'https://brave.com/wallet/', deeplink: '', cat: 'Popular' },
  { id: 'coin98',   name: 'Coin98',          provider: 'coin98.sol',         flag: '',              color: '#d9b432', install_url: 'https://coin98.com/wallet', deeplink: '', cat: 'Popular' },
  { id: 'nightly',  name: 'Nightly',         provider: 'nightly.solana',     flag: '',              color: '#6067f9', install_url: 'https://nightly.app/', deeplink: '', cat: 'Popular' },
  { id: 'magiceden',name: 'Magic Eden',      provider: 'magicEden.solana',   flag: '',              color: '#e42575', install_url: 'https://wallet.magiceden.io/', deeplink: '', cat: 'Popular' },
];

const RAW = `
Glow|https://glow.app|Solana|glow.solana
Bitget Wallet|https://web3.bitget.com|Popular|bitkeep.solana
TokenPocket|https://www.tokenpocket.pro|Popular|tokenpocket.solana
Math Wallet|https://mathwallet.org|Popular|solana|isMathWallet
SafePal|https://www.safepal.com|Popular
Clover|https://clv.org|Solana|clover_solana
Solong|https://solongwallet.com|Solana|solong
Salmon Wallet|https://salmonwallet.io|Solana|salmon
Spot|https://spot.so|Solana
Squads|https://squads.xyz|Solana
Avana Wallet|https://avanawallet.com|Solana
Carbon Wallet|https://carbon.website|Solana
NuFi|https://nu.fi|Solana
Saifu|https://saifuwallet.com|Solana
Jupiter Wallet|https://jup.ag|Solana
Solareum|https://solareum.app|Solana
Solana Seed Vault (Seeker)|https://solanamobile.com|Solana
Frontier|https://frontier.xyz|Multi-chain|frontier.solana
Ctrl Wallet (XDEFI)|https://ctrl.xyz|Multi-chain|xfi.solana
OneKey|https://onekey.so|Multi-chain|$onekey.solana
Enkrypt|https://www.enkrypt.com|Multi-chain|enkrypt.providers.solana
Talisman|https://talisman.xyz|Multi-chain
MetaMask|https://metamask.io|Multi-chain
Zerion|https://zerion.io|Multi-chain
Atomic Wallet|https://atomicwallet.io|Multi-chain
Guarda|https://guarda.com|Multi-chain
Coinomi|https://www.coinomi.com|Multi-chain
Edge|https://edge.app|Multi-chain
ZenGo|https://zengo.com|Multi-chain
Unstoppable Wallet|https://unstoppable.money|Multi-chain
Gem Wallet|https://gemwallet.com|Multi-chain
Cake Wallet|https://cakewallet.com|Multi-chain
imToken|https://token.im|Multi-chain
Best Wallet|https://bestwallet.com|Multi-chain
Klever Wallet|https://klever.io|Multi-chain
Ownbit|https://ownbit.io|Multi-chain
Infinity Wallet|https://infinitywallet.io|Multi-chain
Trustee Wallet|https://trustee.deals|Multi-chain
Blockchain.com Wallet|https://www.blockchain.com/wallet|Multi-chain
Slingshot|https://slingshot.finance|Multi-chain
AirGap|https://airgap.it|Multi-chain
Freewallet|https://freewallet.org|Multi-chain
Zelcore|https://zelcore.io|Multi-chain
Coin Wallet|https://coin.space|Multi-chain
Tomo Wallet|https://tomo.inc|Multi-chain
Echooo Wallet|https://echooo.xyz|Multi-chain
Cobo Wallet|https://cobo.com|Multi-chain
Wirex|https://wirex.com|Multi-chain
SwissBorg|https://swissborg.com|Multi-chain
Tokenary|https://tokenary.io|Multi-chain
Krystal|https://krystal.app|Multi-chain
ONTO|https://onto.app|Multi-chain
AlphaWallet|https://alphawallet.com|Multi-chain
Bitpie|https://bitpie.com|Multi-chain
HyperPay|https://hyperpay.io|Multi-chain
Opera Crypto Browser|https://www.opera.com/crypto|Browser
Puma Browser|https://www.pumabrowser.com|Browser
Binance Web3 Wallet|https://www.binance.com/en/web3wallet|Exchange
Bybit Wallet|https://www.bybit.com/web3|Exchange
Gate Wallet|https://www.gate.io/web3|Exchange
KuCoin Web3 Wallet|https://www.kucoin.com/web3|Exchange
MEXC Wallet|https://www.mexc.com|Exchange
HTX Wallet|https://www.htx.com|Exchange
Crypto.com DeFi Wallet|https://crypto.com/defi-wallet|Exchange
Kraken Wallet|https://www.kraken.com/wallet|Exchange
Robinhood Wallet|https://wallet.robinhood.com|Exchange
Bitpanda Wallet|https://www.bitpanda.com|Exchange
Uphold|https://uphold.com|Exchange
Phemex|https://phemex.com|Exchange
BingX|https://bingx.com|Exchange
WhiteBIT|https://whitebit.com|Exchange
LBank|https://www.lbank.com|Exchange
BitMart|https://www.bitmart.com|Exchange
Bitrue|https://www.bitrue.com|Exchange
CoinEx|https://www.coinex.com|Exchange
Bitvavo|https://bitvavo.com|Exchange
Bitstamp|https://www.bitstamp.net|Exchange
Gemini|https://www.gemini.com|Exchange
Bitfinex|https://www.bitfinex.com|Exchange
Upbit|https://upbit.com|Exchange
Bithumb|https://www.bithumb.com|Exchange
Bitkub|https://www.bitkub.com|Exchange
Coins.ph|https://coins.ph|Exchange
PDAX|https://pdax.ph|Exchange
Indodax|https://indodax.com|Exchange
Tokocrypto|https://www.tokocrypto.com|Exchange
Pintu|https://pintu.co.id|Exchange
Luno|https://www.luno.com|Exchange
WazirX|https://wazirx.com|Exchange
CoinDCX|https://coindcx.com|Exchange
CoinSwitch|https://coinswitch.co|Exchange
Mercado Bitcoin|https://www.mercadobitcoin.com.br|Exchange
Bitso|https://bitso.com|Exchange
Revolut|https://www.revolut.com|Exchange
Ledger|https://www.ledger.com|Hardware
Trezor|https://trezor.io|Hardware
Keystone|https://keyst.one|Hardware
Tangem|https://tangem.com|Hardware
D'CENT|https://dcentwallet.com|Hardware
Ellipal|https://www.ellipal.com|Hardware
CoolWallet|https://www.coolwallet.io|Hardware
Cypherock|https://cypherock.com|Hardware
Arculus|https://www.getarculus.com|Hardware
SecuX|https://secuxtech.com|Hardware
NGRAVE|https://www.ngrave.io|Hardware
Prokey|https://prokey.io|Hardware
Privy|https://www.privy.io|Embedded
Dynamic|https://www.dynamic.xyz|Embedded
Web3Auth (Torus)|https://web3auth.io|Embedded
Particle Network|https://particle.network|Embedded
Magic|https://magic.link|Embedded
Crossmint|https://www.crossmint.com|Embedded
Turnkey|https://www.turnkey.com|Embedded
Para|https://www.getpara.com|Embedded
Fordefi|https://fordefi.com|Embedded
WalletConnect (Reown)|https://reown.com|Embedded
Fireblocks|https://www.fireblocks.com|Embedded
BitGo|https://www.bitgo.com|Embedded
Rainbow|https://rainbow.me|Multi-chain
Nexo|https://nexo.com|Exchange
MoonPay|https://www.moonpay.com|Exchange
Pionex|https://www.pionex.com|Exchange
Mercuryo|https://mercuryo.io|Exchange
OKCoin|https://www.okcoin.com|Exchange
Coinhako|https://www.coinhako.com|Exchange
`;

// Stable pleasant color per name for entries that have no brand color.
function colorFor(name) {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360, s = 0.55, l = 0.45;
  const k = n => (n + hue / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

const rest = RAW.trim().split('\n').map(line => {
  const [name, install_url, cat, provider = '', flag = ''] = line.split('|');
  return { id: slug(name), name, provider, flag, color: colorFor(name), install_url, deeplink: '', cat: cat || 'Multi-chain' };
});

// Official logo link for a wallet = the icon its own website publishes (served over https by Google's favicon service,
// 128px). Used to fill the "Logo link" of every wallet in admin → Wallets. Returns '' when there is no usable website.
function logoFor(siteUrl) {
  try { const h = new URL(siteUrl).hostname; return h ? 'https://www.google.com/s2/favicons?sz=128&domain=' + encodeURIComponent(h) : ''; }
  catch { return ''; }
}

const PRESETS = [...TOP, ...rest].map(p => ({ ...p, logo: logoFor(p.install_url) }));
const seen = new Set();
for (const p of PRESETS) { if (seen.has(p.id)) throw new Error('duplicate wallet preset id: ' + p.id); seen.add(p.id); }

module.exports = { WALLET_PRESETS: PRESETS, TOP_COUNT: TOP.length, logoFor };
