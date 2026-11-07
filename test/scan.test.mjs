import fs from 'node:fs';
import { parseInput, deriveAddress } from '../src/core.js';
import { Api, scanWallet, detectScriptType } from '../src/scan.js';
import { makeMock, tx, ext } from './mockapi.mjs';
const v = JSON.parse(fs.readFileSync(new URL('./vectors.json', import.meta.url)));
let fail = 0;
const eq = (name, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) { fail++; console.log('FAIL', name, a, '!=', b); } else console.log('ok  ', name); };

// --- Szenario 1: Single-Sig wpkh ---
const c = v.cases.find((x) => x.name === 'desc wpkh');
const R = c.receive, C = c.change;
const fund = tx({ ins: [], outs: [[R[0], 100000], [ext(1), 5]], height: 800000 });
fund.vin = [{ txid: 'aa'.repeat(32), vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: ext(0), value: 100100 } }];
const B = tx({ outs: [[R[1], 50000]], height: 800010 }); B.vin = [{ txid: 'bb'.repeat(32), vout: 0, prevout: { scriptpubkey_address: ext(2), value: 50500 } }];
const Cx = tx({ ins: [[fund, 0]], outs: [[ext(3), 60000], [C[0], 39000]], height: 800020, fee: 1000 });
const D = tx({ outs: [[R[3], 20000]] }); D.vin = [{ txid: 'cc'.repeat(32), vout: 1, prevout: { scriptpubkey_address: ext(4), value: 21000 } }];
// Viele kleine Eingänge auf Index 25 (testet Lückengrenze + Seitenabruf)
const far = deriveAddress(parseInput(c.input), 0, 23);
const many = [];
for (let i = 0; i < 30; i++) { const t = tx({ outs: [[far, 1000]], height: 800100 + i }); t.vin = [{ txid: 'dd'.repeat(32), vout: i, prevout: { scriptpubkey_address: ext(5), value: 1100 } }]; many.push(t); }
const mock = makeMock([fund, B, Cx, D, ...many], 800200);
const api = new Api('https://mock/api', { fetchImpl: mock.fetchImpl });
const spec = parseInput(c.input);
const res = await scanWallet(api, spec, { gapLimit: 20 });
eq('Saldo bestätigt', res.confirmed, 50000 + 39000 + 30000);
eq('Saldo unbestätigt', res.pending, 20000);
eq('Anzahl Transaktionen', res.txs.length, 4 + 30);
eq('Erste Tx unbestätigt', [res.txs[0].confirmed, res.txs[0].net, res.txs[0].kind], [false, 20000, 'in']);
const out = res.txs.find((t) => t.txid === Cx.txid);
eq('Ausgang netto inkl. Gebühr', [out.net, out.fee, out.kind, out.confirmations], [-61000, 1000, 'out', 181]);
eq('UTXOs', res.utxos.length, 3 + 30);
eq('UTXO-Summe = Saldo', res.utxos.reduce((s, u) => s + u.value, 0), res.confirmed + res.pending);
eq('Nächste freie Empfangsadresse', res.nextReceiveIndex, 2);
eq('Empfangskette bis Index 43 gescannt', Math.max(...res.addresses.filter((a) => a.chain === 0).map((a) => a.index)), 43);
eq('Wechselgeldkette bis Index 20 gescannt', Math.max(...res.addresses.filter((a) => a.chain === 1).map((a) => a.index)), 20);
eq('Preis CHF', res.price.chf, 80000);
eq('Pfad Adresse 23', res.addresses.find((a) => a.address === far).paths[0].full, "m/84'/0'/0'/0/23");
console.log('     Anfragen:', mock.calls());

// --- Szenario 2: Multisig ---
const m = v.cases.find((x) => x.name === 'wsh sortedmulti');
const mf = tx({ outs: [[m.receive[0], 25000]], height: 810000 }); mf.vin = [{ txid: 'ee'.repeat(32), vout: 0, prevout: { scriptpubkey_address: ext(6), value: 26000 } }];
const ms = tx({ ins: [[mf, 0]], outs: [[ext(7), 10000], [m.change[0], 14000]], height: 810005, fee: 1000 });
const mock2 = makeMock([mf, ms], 810010);
const res2 = await scanWallet(new Api('https://mock/api', { fetchImpl: mock2.fetchImpl }), parseInput(m.input));
eq('Multisig Saldo', res2.confirmed, 14000);
eq('Multisig Pfade', res2.addresses.find((a) => a.address === m.change[0]).paths.map((p) => p.full), ["m/48'/0'/0'/2'/1/0", "m/48'/0'/0'/2'/1/0", "m/48'/0'/0'/2'/1/0"]);

// --- Szenario 3: Typ-Erkennung für nacktes xpub ---
const bare = v.cases.find((x) => x.name === 'bare xpub tr');
const t3 = tx({ outs: [[bare.receive[0], 1234]], height: 1 }); t3.vin = [{ txid: 'ff'.repeat(32), vout: 0, prevout: { scriptpubkey_address: ext(8), value: 2000 } }];
const det = await detectScriptType(new Api('https://mock/api', { fetchImpl: makeMock([t3], 10).fetchImpl }), bare.input);
eq('Erkennung Taproot', det.script, 'tr');
const det2 = await detectScriptType(new Api('https://mock/api', { fetchImpl: makeMock([], 10).fetchImpl }), bare.input);
eq('Erkennung ohne Historie -> wpkh', [det2.script, det2.found.length], ['wpkh', 0]);

console.log(fail ? `${fail} FEHLER` : 'alle ok');
process.exit(fail ? 1 : 0);
