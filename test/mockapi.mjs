// Esplora-ähnliche Mock-API aus einer Liste von Transaktionen
export function makeMock(txs, tip) {
  const byAddr = new Map();
  const add = (addr, t) => { if (!addr) return; if (!byAddr.has(addr)) byAddr.set(addr, new Map()); byAddr.get(addr).set(t.txid, t); };
  for (const t of txs) { t.vout.forEach((o) => add(o.scriptpubkey_address, t)); t.vin.forEach((i) => add(i.prevout && i.prevout.scriptpubkey_address, t)); }
  const order = (a, b) => (a.status.confirmed - b.status.confirmed) || ((b.status.block_height || 0) - (a.status.block_height || 0)) || (a.txid < b.txid ? -1 : 1);
  function stats(addr) {
    const s = { chain_stats: z(), mempool_stats: z() };
    for (const t of (byAddr.get(addr) || new Map()).values()) {
      const st = t.status.confirmed ? s.chain_stats : s.mempool_stats;
      st.tx_count++;
      t.vout.forEach((o) => { if (o.scriptpubkey_address === addr) { st.funded_txo_count++; st.funded_txo_sum += o.value; } });
      t.vin.forEach((i) => { if (i.prevout.scriptpubkey_address === addr) { st.spent_txo_count++; st.spent_txo_sum += i.prevout.value; } });
    }
    return { address: addr, ...s };
  }
  function z() { return { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 }; }
  let calls = 0;
  async function fetchImpl(url) {
    calls++;
    const p = new URL(url).pathname.replace(/^\/api/, '');
    let m, body;
    if (p === '/blocks/tip/height') body = String(tip);
    else if (p === '/v1/prices') body = { time: 1700000000, USD: 100000, CHF: 80000 };
    else if ((m = /^\/address\/([^/]+)$/.exec(p))) body = stats(m[1]);
    else if ((m = /^\/address\/([^/]+)\/txs$/.exec(p))) {
      const list = [...(byAddr.get(m[1]) || new Map()).values()].sort(order);
      body = [...list.filter((t) => !t.status.confirmed).slice(0, 50), ...list.filter((t) => t.status.confirmed).slice(0, 25)];
    } else if ((m = /^\/address\/([^/]+)\/txs\/chain\/([0-9a-f]+)$/.exec(p))) {
      const list = [...(byAddr.get(m[1]) || new Map()).values()].filter((t) => t.status.confirmed).sort(order);
      const i = list.findIndex((t) => t.txid === m[2]);
      body = list.slice(i + 1, i + 26);
    } else return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    return { ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  }
  return { fetchImpl, calls: () => calls };
}

let n = 0;
export const txid = () => (++n).toString(16).padStart(64, '0');
export function tx({ ins = [], outs = [], height = null, fee = 0 }) {
  return {
    txid: txid(),
    vin: ins.map(([prevTx, vout]) => ({ txid: prevTx.txid, vout, is_coinbase: false, prevout: prevTx.vout[vout] })),
    vout: outs.map(([address, value]) => ({ scriptpubkey_address: address, value })),
    fee, weight: 600,
    status: height ? { confirmed: true, block_height: height, block_time: 1700000000 + height } : { confirmed: false },
  };
}
export const ext = (i) => 'bc1qexternal' + i;
