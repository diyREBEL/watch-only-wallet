// Blockchain-Abfrage über eine Esplora-kompatible API (mempool.space, Blockstream, eigener Node).
import { parseInput, deriveAddress, derivationPaths } from './core.js';

export class ApiError extends Error {}

export class Api {
  constructor(base, { concurrency = 3, timeoutMs = 20000, fetchImpl } = {}) {
    this.base = String(base || '').trim().replace(/\/+$/, '');
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.active = 0;
    this.queue = [];
    this.requests = 0;
  }

  async _slot() {
    if (this.active < this.concurrency) { this.active++; return; }
    await new Promise((r) => this.queue.push(r));
    this.active++;
  }
  _release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async get(path, as = 'json') {
    await this._slot();
    try {
      for (let attempt = 0; ; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        let res;
        try {
          this.requests++;
          res = await this.fetch(this.base + path, { signal: ctrl.signal });
        } catch (e) {
          if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
          throw new ApiError(`Keine Verbindung zu ${this.base}. Ist die Adresse richtig und erlaubt der Server Anfragen aus dem Browser (CORS)?`);
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 429 && attempt < 5) { await sleep(2000 * 2 ** attempt); continue; }
        if (res.status >= 500 && attempt < 2) { await sleep(1500); continue; }
        if (!res.ok) throw new ApiError(`Server-Antwort ${res.status} für ${path}`);
        return as === 'text' ? (await res.text()).trim() : await res.json();
      }
    } finally {
      this._release();
    }
  }

  addressStats(addr) { return this.get(`/address/${addr}`); }
  tipHeight() { return this.get('/blocks/tip/height', 'text').then(Number); }
  prices() { return this.get('/v1/prices'); }

  // Alle Transaktionen einer Adresse (Mempool + bestätigt, mit Seitenabruf)
  async addressTxs(addr) {
    const first = await this.get(`/address/${addr}/txs`);
    const all = [...first];
    let confirmed = first.filter((t) => t.status && t.status.confirmed);
    while (confirmed.length === 25) {
      const last = confirmed[confirmed.length - 1].txid;
      const page = await this.get(`/address/${addr}/txs/chain/${last}`);
      all.push(...page);
      confirmed = page;
    }
    return all;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const usedCount = (st) => st.chain_stats.tx_count + st.mempool_stats.tx_count;

// Erkennt bei einem nackten "xpub" den Adresstyp anhand der Historie der ersten Adresse.
export async function detectScriptType(api, text) {
  const candidates = ['wpkh', 'tr', 'sh-wpkh', 'pkh'];
  const results = await Promise.all(candidates.map(async (script) => {
    const spec = parseInput(text, script);
    const addr = deriveAddress(spec, 0, 0);
    const st = await api.addressStats(addr);
    return { script, used: usedCount(st) > 0 };
  }));
  const used = results.filter((r) => r.used).map((r) => r.script);
  return { script: used[0] || 'wpkh', found: used };
}

// Durchsucht eine Kette (0 = Empfangen, 1 = Wechselgeld) bis zur Lückengrenze
async function scanChain(api, spec, chain, gapLimit, onProgress) {
  const out = [];
  let lastUsed = -1;
  let next = 0;
  while (next <= lastUsed + gapLimit) {
    const end = lastUsed + gapLimit;
    const batch = [];
    for (let i = next; i <= end; i++) batch.push(i);
    next = end + 1;
    const stats = await Promise.all(batch.map(async (index) => {
      const address = deriveAddress(spec, chain, index);
      const st = await api.addressStats(address);
      onProgress && onProgress();
      return { chain, index, address, stats: st };
    }));
    for (const s of stats) {
      out.push(s);
      if (usedCount(s.stats) > 0) lastUsed = Math.max(lastUsed, s.index);
    }
  }
  return out;
}

export async function scanWallet(api, spec, { gapLimit = 20, onProgress } = {}) {
  let done = 0;
  const progress = (phase) => onProgress && onProgress({ phase, done: ++done, requests: api.requests });

  const [tip, priceRes] = await Promise.all([
    api.tipHeight().catch(() => null),
    api.prices().catch(() => null),
  ]);

  const chains = [scanChain(api, spec, 0, gapLimit, () => progress('Adressen'))];
  if (spec.hasChange) chains.push(scanChain(api, spec, 1, gapLimit, () => progress('Adressen')));
  const addrs = (await Promise.all(chains)).flat();

  const mine = new Map(addrs.map((a) => [a.address, a]));
  const used = addrs.filter((a) => usedCount(a.stats) > 0);

  // Transaktionen sammeln
  const txMap = new Map();
  await Promise.all(used.map(async (a) => {
    const txs = await api.addressTxs(a.address);
    for (const t of txs) txMap.set(t.txid, t);
    progress('Transaktionen');
  }));

  return analyze(spec, addrs, mine, [...txMap.values()], tip, priceRes, gapLimit);
}

export function analyze(spec, addrs, mine, txs, tip, priceRes, gapLimit) {
  // Saldo je Adresse
  for (const a of addrs) {
    const c = a.stats.chain_stats, m = a.stats.mempool_stats;
    a.confirmed = c.funded_txo_sum - c.spent_txo_sum;
    a.pending = m.funded_txo_sum - m.spent_txo_sum;
    a.txCount = c.tx_count + m.tx_count;
    a.paths = derivationPaths(spec, a.chain, a.index);
  }
  const confirmed = addrs.reduce((s, a) => s + a.confirmed, 0);
  const pending = addrs.reduce((s, a) => s + a.pending, 0);

  // Ausgegebene Outpoints
  const spent = new Set();
  for (const t of txs) for (const vin of t.vin) if (!vin.is_coinbase) spent.add(`${vin.txid}:${vin.vout}`);

  const utxos = [];
  const txList = txs.map((t) => {
    let received = 0, sent = 0, ownOutputs = 0;
    t.vout.forEach((o, n) => {
      const a = o.scriptpubkey_address && mine.get(o.scriptpubkey_address);
      if (a) {
        received += o.value;
        ownOutputs++;
        if (!spent.has(`${t.txid}:${n}`)) {
          utxos.push({ txid: t.txid, vout: n, value: o.value, address: a.address, chain: a.chain, index: a.index, confirmed: !!t.status.confirmed, height: t.status.block_height || null });
        }
      }
    });
    let ownInputs = 0, allInputsMine = t.vin.length > 0;
    for (const vin of t.vin) {
      const a = vin.prevout && vin.prevout.scriptpubkey_address && mine.get(vin.prevout.scriptpubkey_address);
      if (a) { sent += vin.prevout.value; ownInputs++; } else allInputsMine = false;
    }
    const net = received - sent;
    let kind = net > 0 ? 'in' : 'out';
    if (allInputsMine && ownOutputs === t.vout.length) kind = 'self';
    const conf = t.status.confirmed && tip ? tip - t.status.block_height + 1 : 0;
    return {
      txid: t.txid,
      net,
      fee: allInputsMine ? t.fee : null,
      kind,
      confirmed: !!t.status.confirmed,
      confirmations: conf,
      height: t.status.block_height || null,
      time: t.status.block_time || null,
      vsize: t.weight ? Math.ceil(t.weight / 4) : null,
    };
  });
  // Unbestätigte zuerst, danach neueste zuerst
  txList.sort((a, b) => (a.confirmed - b.confirmed) || ((b.height || 0) - (a.height || 0)));
  utxos.sort((a, b) => b.value - a.value);

  const receiveAddrs = addrs.filter((a) => a.chain === 0).sort((a, b) => a.index - b.index);
  const nextUnused = receiveAddrs.find((a) => a.txCount === 0);

  return {
    tip,
    price: priceRes && typeof priceRes.CHF === 'number' ? { chf: priceRes.CHF, time: priceRes.time } : null,
    confirmed,
    pending,
    addresses: addrs.sort((a, b) => a.chain - b.chain || a.index - b.index),
    txs: txList,
    utxos,
    nextReceiveIndex: nextUnused ? nextUnused.index : receiveAddrs.length,
    gapLimit,
    scannedAt: Date.now(),
  };
}
