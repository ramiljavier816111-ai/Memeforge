/* =====================================================================
   MemeForge — payment.js
   All the PAYMENT logic lives here. The HTML page only calls these functions.
   Keep this file in the SAME folder as solana-token-creator.html and
   fees-config.js. Load order in the HTML:
       <script src="fees-config.js"></script>
       <script src="payment.js"></script>

   HOW THE MONEY FLOWS (read this first)
   ---------------------------------------------------------------------
   1. The user pays ONE total amount, shown in the receipt before they sign:
         features = creationFee + every premium feature they switched on
         network  = real Solana cost (rent for mint + metadata + token account
                    + signature fee). This goes to Solana itself, not to you.
         toOwner  = features - network   (never below 0)
         total    = network + toOwner    (= the larger of features / network)
   2. `toOwner` is the REMAINING SOL. It is transferred to YOUR feeWallet
      (from fees-config.js) inside the same transaction that creates the token.
   3. After the transaction is confirmed, verifyFeeDelivered() reads the
      confirmed transaction from the chain and checks that your wallet really
      received `toOwner`, and the page logs the result. (If the RPC is slow and
      this double-check cannot run, the page still shows the token, because the
      transfer is part of the same transaction and therefore atomic: either the
      token is created AND you are paid, or nothing happens.)
   ===================================================================== */
(function () {
  'use strict';

  const LAMPORTS = 1_000_000_000;            // 1 SOL = 1,000,000,000 lamports
  const CFG = window.MEMEFORGE_CONFIG || null;

  /* ---------- small helpers ---------- */

  // Accept only finite, non-negative numbers; otherwise use the default value.
  const num = (v, d) => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : d;
  // SOL -> lamports (whole number, because the chain only knows lamports).
  const toL = x => Math.round(x * LAMPORTS);
  // Pretty SOL text: 0.1 -> "0.1 SOL"
  const money = x => (+x.toFixed(4)) + ' SOL';

  /* ---------- settings read from fees-config.js ---------- */

  const FEE_WALLET = String(CFG?.feeWallet ?? '').trim();   // your revenue wallet
  const BASE_FEE = num(CFG?.creationFee, 0.1);              // fee to create a token (SOL)
  const BASE_LAMPORTS = toL(BASE_FEE);

  // Premium features. `id` is the checkbox id in the HTML, `key` is the name in
  // fees-config.js -> featureFees. A fee of 0 means the feature is free.
  const FEATURES = [
    { id: 'tg_banner',    key: 'banner',       name: 'Token banner' },
    { id: 'tg_social',    key: 'social',       name: 'Social links' },
    { id: 'tg_creator',   key: 'creator',      name: 'Creator info' },
    { id: 'mintRevoke',   key: 'mintRevoke',   name: 'Revoke mint authority' },
    { id: 'freezeRevoke', key: 'freezeRevoke', name: 'Revoke freeze authority' },
    { id: 'metaRevoke',   key: 'metaRevoke',   name: 'Revoke metadata update authority' },
  ].map(f => ({ ...f, fee: num(CFG?.featureFees?.[f.key], 0.1) }));

  // Rent-exempt minimums in lamports (Solana's cost of storing accounts forever).
  // These are sensible defaults; refineRent() replaces them with live RPC values.
  const RENT = { mint: 1461600, metadata: 5616720, ata: 2039280, sigFees: 10000 };
  let rentRefined = false;

  // Ask the RPC for the exact rent numbers so the receipt is accurate.
  async function refineRent(conn) {
    if (rentRefined) return false;
    try {
      const [m, md, a] = await Promise.all([
        conn.getMinimumBalanceForRentExemption(82),    // mint account size
        conn.getMinimumBalanceForRentExemption(679),   // metadata account size
        conn.getMinimumBalanceForRentExemption(165),   // token account size
      ]);
      RENT.mint = m; RENT.metadata = md; RENT.ata = a;
      rentRefined = true;
      return true;                                      // true = values changed, redraw receipt
    } catch { return false; }
  }
  function resetRent() { rentRefined = false; }

  /* ---------- which features are switched on ---------- */

  // Features that are ticked AND cost something.
  function activeFeatures() {
    return FEATURES.filter(f => document.getElementById(f.id).checked && f.fee > 0);
  }

  // The fee wallet must look like a real Solana address (32–44 chars).
  function validFeeWallet() {
    return !!(FEE_WALLET && !/PASTE_/.test(FEE_WALLET) && FEE_WALLET.length >= 32 && FEE_WALLET.length <= 44);
  }

  /* ---------- the fee maths ---------- */

  // hasSupply = true when an initial supply > 0 (then a token account is needed too).
  function computeFees(hasSupply) {
    // Real cost paid to Solana.
    const network = RENT.mint + RENT.metadata + (hasSupply ? RENT.ata : 0) + RENT.sigFees;
    // Everything the user is charged for (creation + ticked premium features).
    const features = BASE_LAMPORTS + activeFeatures().reduce((n, f) => n + toL(f.fee), 0);
    // REMAINING SOL: what is left after the network cost. This goes to your wallet.
    const toOwner = Math.max(features - network, 0);
    // What the user pays in total.
    const total = network + toOwner;
    return { network, features, toOwner, total };
  }

  /* ---------- building the payment instruction ---------- */

  // Returns a SystemProgram.transfer instruction that sends the remaining SOL
  // to your feeWallet, or null when there is nothing to send.
  // `web3` is the @solana/web3.js module, `payer` is the user's PublicKey.
  // Add the returned instruction to the SAME transaction that creates the token.
  function buildFeeInstruction(web3, payer, fees) {
    if (fees.toOwner <= 0) return null;
    if (!validFeeWallet()) throw new Error('The fee wallet is not configured. Set feeWallet in fees-config.js first.');
    let feeTo;
    try { feeTo = new web3.PublicKey(FEE_WALLET); }
    catch { throw new Error('feeWallet in fees-config.js is not a valid Solana address.'); }
    return web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: feeTo, lamports: fees.toOwner });
  }

  /* ---------- checking the user can afford it ---------- */

  // Throws a friendly error if the wallet balance is too low.
  // `buffer` (lamports) is a safety margin for fluctuations.
  function assertCanAfford(balanceLamports, fees, isDev, buffer = 5_000_000) {
    if (balanceLamports < fees.total + buffer) {
      throw new Error(
        `Not enough ${isDev ? 'devnet ' : ''}SOL. You need about ${((fees.total + buffer) / LAMPORTS).toFixed(3)} SOL (incl. a small buffer for fees).` +
        (isDev ? ' Use the Get devnet SOL button or faucet.solana.com.' : ' Add SOL to your wallet and try again.')
      );
    }
  }

  /* ---------- confirming YOU were paid ---------- */

  // After the transaction is confirmed, read it back from the chain and compare
  // your fee wallet's balance before/after. Returns the lamports you received.
  // The page calls this BEFORE showing the token address.
  async function verifyFeeDelivered(conn, signature, fees) {
    if (fees.toOwner <= 0) return 0;                         // nothing was due
    // The RPC can lag a moment behind confirmation, so retry a few times.
    let tx = null;
    for (let i = 0; i < 6 && !tx; i++) {
      tx = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx) await new Promise(r => setTimeout(r, 1000));
    }
    if (!tx || !tx.meta) throw new Error('Could not read the confirmed transaction to verify the fee.');
    if (tx.meta.err) throw new Error('The transaction failed on-chain.');

    // Find your fee wallet in the list of accounts touched by the transaction.
    const keys = tx.transaction.message.accountKeys
      ? tx.transaction.message.accountKeys.map(k => k.toString())
      : tx.transaction.message.getAccountKeys().keySegments().flat().map(k => k.toString());
    const i = keys.indexOf(FEE_WALLET);
    if (i === -1) throw new Error('Fee wallet was not part of the transaction.');

    const received = tx.meta.postBalances[i] - tx.meta.preBalances[i];
    if (received < fees.toOwner) throw new Error('Fee wallet received less than expected.');
    return received;
  }

  /* ---------- everything the HTML needs ---------- */
  window.MemeForgePayment = {
    LAMPORTS, BASE_FEE, FEE_WALLET, FEATURES, RENT, CFG,
    money, toL,
    activeFeatures, validFeeWallet, computeFees,
    refineRent, resetRent,
    buildFeeInstruction, assertCanAfford, verifyFeeDelivered,
  };
})();
