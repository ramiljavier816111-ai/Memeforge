/* Tests for public/payment.js (the browser-side fee maths + fee transfer + on-chain check).
   Run:  npm test      (no internet needed: Solana is faked) */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'payment.js'), 'utf8');
const WALLET = 'JLqXStBQFBRQnKfnGrGDFuBX8uKDJeZCGhLUqqttg3m';
const ALL = ['tg_banner', 'tg_social', 'tg_creator', 'mintRevoke', 'freezeRevoke', 'metaRevoke'];

// Loads payment.js exactly like a browser would, with a fake window/document.
function load({ cfg, ticked = [] }) {
  const window = { MEMEFORGE_CONFIG: cfg };
  const document = { getElementById: id => ({ checked: ticked.includes(id) }) };
  vm.runInNewContext(SRC, { window, document, setTimeout: (f) => f(), console });
  return window.MemeForgePayment;
}
const CFG = {
  network: 'devnet', feeWallet: WALLET, creationFee: 0.1,
  featureFees: { banner: 0.2, social: 0.1, creator: 0, mintRevoke: 0.1, freezeRevoke: 0.1, metaRevoke: 0.1 },
};
const NETWORK_WITH_SUPPLY = 1461600 + 5616720 + 2039280 + 10000;   // mint + metadata + token account + signature

test('base fee only: user pays the fee, network cost is taken out of it, the rest is yours', () => {
  const P = load({ cfg: CFG });
  const f = P.computeFees(true);
  assert.equal(f.features, 100_000_000);
  assert.equal(f.network, NETWORK_WITH_SUPPLY);
  assert.equal(f.toOwner, 100_000_000 - NETWORK_WITH_SUPPLY);
  assert.equal(f.total, 100_000_000);                 // total = network + toOwner = the fee shown to the user
});

test('every premium feature ticked adds up exactly (no floating point drift)', () => {
  const P = load({ cfg: CFG, ticked: ALL });
  const f = P.computeFees(true);
  // 0.1 + 0.2 + 0.1 + (creator 0) + 0.1 + 0.1 + 0.1 = 0.7 SOL
  assert.equal(f.features, 700_000_000);
  assert.equal(f.toOwner, 700_000_000 - NETWORK_WITH_SUPPLY);
  assert.equal(f.total, 700_000_000);
  assert.equal(P.activeFeatures().length, 5);          // creator info is free, so it is not "active"
});

test('0.1 + 0.2 style prices are converted per item, so they never become 0.30000000000000004', () => {
  const P = load({ cfg: { ...CFG, creationFee: 0.1, featureFees: { ...CFG.featureFees, banner: 0.2 } }, ticked: ['tg_banner'] });
  assert.equal(P.computeFees(true).features, 300_000_000);
});

test('no initial supply means no token account rent', () => {
  const P = load({ cfg: CFG });
  assert.equal(P.computeFees(false).network, NETWORK_WITH_SUPPLY - 2039280);
});

test('if the network cost is bigger than the fees, you get 0 and the user pays only the network cost', () => {
  const P = load({ cfg: { ...CFG, creationFee: 0.001, featureFees: {} } });
  const f = P.computeFees(true);
  assert.equal(f.toOwner, 0);
  assert.equal(f.total, f.network);
  assert.equal(P.buildFeeInstruction({}, 'payer', f), null);   // nothing to send
});

test('fee instruction sends exactly toOwner lamports from the payer to the fee wallet', () => {
  const P = load({ cfg: CFG, ticked: ALL });
  const web3 = {
    PublicKey: class { constructor(k) { this.k = k; } },
    SystemProgram: { transfer: o => ({ transfer: o }) },
  };
  const f = P.computeFees(true);
  const ix = P.buildFeeInstruction(web3, 'PAYER', f);
  assert.equal(ix.transfer.fromPubkey, 'PAYER');
  assert.equal(ix.transfer.toPubkey.k, WALLET);
  assert.equal(ix.transfer.lamports, f.toOwner);
});

test('a missing / placeholder fee wallet is refused instead of silently losing the fee', () => {
  for (const feeWallet of ['', 'PASTE_YOUR_WALLET_HERE', 'short']) {
    const P = load({ cfg: { ...CFG, feeWallet } });
    assert.throws(() => P.buildFeeInstruction({ PublicKey: class {}, SystemProgram: {} }, 'p', P.computeFees(true)), /fee wallet/i);
  }
});

test('affordability check: needs total + buffer', () => {
  const P = load({ cfg: CFG });
  const f = P.computeFees(true);
  assert.doesNotThrow(() => P.assertCanAfford(f.total + 5_000_000, f, true));
  assert.throws(() => P.assertCanAfford(f.total + 4_999_999, f, true), /Not enough devnet SOL/);
  assert.throws(() => P.assertCanAfford(0, f, false), /Add SOL to your wallet/);
});

// A fake web3 connection that returns a confirmed transaction.
const conn = tx => ({ getTransaction: async () => tx });
const tx = (pre, post, err = null) => ({ meta: { err, preBalances: [5e9, pre], postBalances: [4e9, post] }, transaction: { message: { accountKeys: ['PAYER', WALLET] } } });

test('verifyFeeDelivered: passes when the fee wallet balance rose by at least toOwner', async () => {
  const P = load({ cfg: CFG });
  const f = P.computeFees(true);
  assert.equal(await P.verifyFeeDelivered(conn(tx(1e9, 1e9 + f.toOwner)), 'sig', f), f.toOwner);
});

test('verifyFeeDelivered: fails when the wallet got less, the tx failed, or the wallet was not in it', async () => {
  const P = load({ cfg: CFG });
  const f = P.computeFees(true);
  await assert.rejects(P.verifyFeeDelivered(conn(tx(1e9, 1e9 + f.toOwner - 1)), 's', f), /less than expected/);
  await assert.rejects(P.verifyFeeDelivered(conn(tx(1e9, 1e9 + f.toOwner, { InstructionError: 1 })), 's', f), /failed on-chain/);
  const other = { meta: { err: null, preBalances: [1], postBalances: [1] }, transaction: { message: { accountKeys: ['PAYER'] } } };
  await assert.rejects(P.verifyFeeDelivered(conn(other), 's', f), /not part of the transaction/);
});

test('verifyFeeDelivered: skips the check when nothing was due, and retries while the RPC lags', async () => {
  const P = load({ cfg: { ...CFG, creationFee: 0, featureFees: {} } });
  assert.equal(await P.verifyFeeDelivered(conn(null), 's', P.computeFees(true)), 0);

  const P2 = load({ cfg: CFG });
  const f = P2.computeFees(true);
  let calls = 0;
  const lagging = { getTransaction: async () => (++calls < 3 ? null : tx(0, f.toOwner)) };
  assert.equal(await P2.verifyFeeDelivered(lagging, 's', f), f.toOwner);
  assert.equal(calls, 3);
});
