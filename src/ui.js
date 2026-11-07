// Oberfläche der Watch-only-Wallet (ohne Framework)
import qrcode from 'qrcode-generator';
import { parseInput, deriveAddress, derivationPaths, SCRIPT_LABELS, STANDARD_PATHS, stepToString, InputError } from './core.js';
import { Api, scanWallet, detectScriptType } from './scan.js';

const STORE_KEY = 'watchonly-wallet.v1';
const PRESETS = [
  { url: 'https://mempool.space/api', name: 'mempool.space' },
  { url: 'https://blockstream.info/api', name: 'blockstream.info' },
];
const FP_FARBEN = ['#1e4fd8', '#8a3fb8', '#0e7c86', '#b5651d', '#5f7a12', '#c2366b', '#4b5563'];
const TYPEN_XPUB = ['wpkh', 'tr', 'sh-wpkh', 'pkh'];
const TYP_KURZ = { pkh: 'Legacy', 'sh-wpkh': 'Nested SegWit', wpkh: 'Native SegWit', tr: 'Taproot', wsh: 'Native SegWit', 'sh-wsh': 'Nested SegWit', sh: 'Legacy' };

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------
const state = {
  settings: { api: PRESETS[0].url, gap: 20, unit: 'btc' },
  wallets: [],
  currentId: null,
  view: 'start',
  tab: 'tx',
  specs: new Map(),
  results: new Map(),
  errors: new Map(),
  scanning: new Map(),
  recvStep: 0,
  selectedAddr: null,
  hideUnused: false,
  confirmDelete: false,
  add: { name: '', text: '', script: 'auto', busy: false, error: null },
};

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.settings) Object.assign(state.settings, d.settings);
    if (Array.isArray(d.wallets)) state.wallets = d.wallets;
  } catch { /* Speicher nicht verfügbar */ }
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ settings: state.settings, wallets: state.wallets }));
    return true;
  } catch { return false; }
}

function specFor(w) {
  if (!state.specs.has(w.id)) {
    try { state.specs.set(w.id, parseInput(w.input, w.script || undefined)); }
    catch (e) { state.specs.set(w.id, { error: e.message }); }
  }
  return state.specs.get(w.id);
}
const current = () => state.wallets.find((w) => w.id === state.currentId) || null;

// ---------------------------------------------------------------------------
// DOM-Helfer
// ---------------------------------------------------------------------------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const nf = new Intl.NumberFormat('de-CH');
const THIN = ' ';

function btcParts(sats) {
  const neg = sats < 0;
  const abs = Math.abs(sats);
  const whole = Math.floor(abs / 1e8);
  const frac = String(abs % 1e8).padStart(8, '0');
  const s = `${nf.format(whole)}.${frac.slice(0, 2)}${THIN}${frac.slice(2, 5)}${THIN}${frac.slice(5)}`;
  const i = s.search(/[1-9]/);
  const sign = neg ? '−' : '';
  if (i < 0) return [sign + s, ''];
  return [sign + s.slice(0, i), s.slice(i)];
}

// Betrag als Element. signed: Vorzeichen + bei positiven Werten
function amount(sats, { signed = false, unit = true } = {}) {
  const plus = signed && sats > 0 ? '+' : '';
  if (state.settings.unit === 'sats') {
    return h('span', null, (sats < 0 ? '−' : plus) + nf.format(Math.abs(sats)), unit ? h('span', { class: 'einheit-k' }, ' sats') : null);
  }
  const [dim, strong] = btcParts(sats);
  return h('span', null, plus, h('span', { class: 'dim' }, dim), strong, unit ? ' BTC' : null);
}

function chf(sats, price) {
  if (!price) return null;
  return (sats / 1e8 * price.chf).toLocaleString('de-CH', { style: 'currency', currency: 'CHF' });
}

const tbl = (...kids) => h('div', { class: 'tabelle' }, h('table', null, ...kids));

function shortMid(s, a = 10, b = 8) {
  return s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s;
}

function explorerTx(txid) {
  const base = state.settings.api.replace(/\/api\/?$/, '');
  return `${base}/tx/${txid}`;
}

function serverName() {
  try { return new URL(state.settings.api).host; } catch { return state.settings.api; }
}

function fpChip(fp, idx) {
  return h('span', { class: 'fp', style: `--fp:${FP_FARBEN[idx % FP_FARBEN.length]}`, title: 'Fingerprint des Mitsignierenden' }, fp || 'unbekannt');
}

async function copy(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    try {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text; document.body.append(ta); ta.select();
      ok = document.execCommand('copy'); ta.remove();
    } catch { ok = false; }
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = ok ? 'Kopiert' : 'Kopieren nicht möglich';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
}
function copyBtn(text, label = 'Kopieren') {
  const b = h('button', { class: 'knopf klein', type: 'button', onclick: () => copy(text, b) }, label);
  return b;
}

function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const m = 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n + 2 * m} ${n + 2 * m}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR-Code der Adresse');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#17222b');
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------------------
// Ableitungspfad zerlegen
// ---------------------------------------------------------------------------
const ZWECK = { 44: 'BIP44, Legacy', 49: 'BIP49, Nested SegWit', 84: 'BIP84, Native SegWit', 86: 'BIP86, Taproot', 48: 'BIP48, Multisig', 45: 'BIP45, Multisig' };

function pathSegments(spec, keyIdx, chain, index) {
  const k = spec.keys[keyIdx];
  const segs = [];
  if (k.origin) {
    const p = k.origin.path;
    const purpose = p[0] >= 0x80000000 ? p[0] - 0x80000000 : null;
    p.forEach((step, i) => {
      const v = step >= 0x80000000 ? step - 0x80000000 : step;
      let label = 'Ebene', detail = '';
      if (i === 0) { label = 'Zweck'; detail = ZWECK[v] || ''; }
      else if (i === 1 && purpose !== 45) { label = 'Coin'; detail = v === 0 ? 'Bitcoin' : v === 1 ? 'Testnet' : ''; }
      else if (i === 2 && purpose !== 45) { label = 'Konto'; detail = `Konto Nr. ${v}`; }
      else if (i === 3 && purpose === 48) { label = 'Skripttyp'; detail = v === 2 ? 'P2WSH' : v === 1 ? 'P2SH-P2WSH' : ''; }
      segs.push({ value: stepToString(step), label, detail, privat: step >= 0x80000000 });
    });
  } else {
    segs.push({ value: '?', label: 'Kontopfad', detail: `unbekannt (Tiefe ${k.depth})`, privat: true, unknown: true });
  }
  segs.push({ grenze: true });
  const steps = k.chains[chain];
  steps.forEach((s, i) => {
    const last = i === steps.length - 1;
    segs.push({ value: stepToString(s), label: last ? 'Kette' : 'Ebene', detail: last ? (chain === 0 ? 'Empfangen' : 'Wechselgeld') : '', privat: false });
  });
  segs.push({ value: String(index), label: 'Index', detail: `Adresse Nr. ${index}`, privat: false });
  return segs;
}

function pathView(spec, keyIdx, chain, index) {
  const segs = pathSegments(spec, keyIdx, chain, index);
  return h('div', { class: 'pfad', role: 'list', 'aria-label': 'Ableitungspfad' },
    h('div', { class: 'stufe privat', role: 'listitem' }, h('b', null, 'm'), h('span', null, 'Master'), h('small', null, 'aus der Seed')),
    segs.map((s) => s.grenze
      ? h('div', { class: 'xpub-grenze', role: 'listitem', title: 'Hier steht der xpub: alles rechts davon lässt sich ohne privaten Schlüssel ableiten' }, 'xpub')
      : h('div', { class: 'stufe' + (s.privat ? ' privat' : ''), role: 'listitem' }, h('b', null, s.value), h('span', null, s.label), s.detail ? h('small', null, s.detail) : null)));
}

function pathLegend() {
  return h('div', { class: 'pfad-legende' },
    h('span', null, h('i', { style: 'background:#eef0ec' }), 'Gehärtet (\'), nur mit dem privaten Schlüssel ableitbar, passiert auf dem Signiergerät'),
    h('span', null, h('i', { style: 'background:#fbfbf8' }), 'Ungehärtet, diese App leitet sie aus dem xpub ab'));
}

// Pfade aller Schlüssel; identische Pfade werden zusammengefasst
function pathsBlock(spec, chain, index) {
  const paths = derivationPaths(spec, chain, index);
  const same = paths.every((p) => p.full === paths[0].full);
  if (same) {
    return h('div', null,
      spec.isMultisig ? h('div', { class: 'zeile', style: 'margin-top:4px' }, spec.keys.map((k, i) => fpChip(paths[i].fingerprint, i))) : null,
      pathView(spec, 0, chain, index),
      h('div', { class: 'mono hinweis' }, paths[0].full));
  }
  return h('div', null, spec.keys.map((k, i) => h('div', { style: 'margin-bottom:10px' },
    fpChip(paths[i].fingerprint, i), pathView(spec, i, chain, index), h('div', { class: 'mono hinweis' }, paths[i].full))));
}

// ---------------------------------------------------------------------------
// Abfrage
// ---------------------------------------------------------------------------
async function refresh(id) {
  const w = state.wallets.find((x) => x.id === id);
  if (!w || state.scanning.has(id)) return;
  const spec = specFor(w);
  if (spec.error) return;
  state.errors.delete(id);
  state.scanning.set(id, { done: 0 });
  render();
  try {
    const api = new Api(state.settings.api);
    const res = await scanWallet(api, spec, {
      gapLimit: Number(state.settings.gap) || 20,
      onProgress: (p) => { state.scanning.set(id, p); if (state.currentId === id) renderStatusOnly(); },
    });
    res.requests = api.requests;
    res.server = serverName();
    state.results.set(id, res);
    if (state.currentId === id) state.recvStep = 0;
  } catch (e) {
    state.errors.set(id, e.message || String(e));
  } finally {
    state.scanning.delete(id);
    render();
  }
}

function renderStatusOnly() {
  const el = document.getElementById('scan-status');
  const p = state.scanning.get(state.currentId);
  if (el && p) el.textContent = `Abfrage läuft: ${p.phase || 'Adressen'} (${p.requests || 0} Anfragen an ${serverName()})`;
}

// ---------------------------------------------------------------------------
// Ansichten
// ---------------------------------------------------------------------------
function render() {
  const app = document.getElementById('app');
  const scrollY = window.scrollY;
  const active = document.activeElement && document.activeElement.id;
  app.replaceChildren(h('div', { class: 'app' }, sidebar(), h('div', { class: 'spalte' }, phoneBar(), h('main', { class: 'haupt' }, mainView()))));
  if (active) { const el = document.getElementById(active); if (el) el.focus(); }
  window.scrollTo(0, scrollY);
}

function sidebar() {
  return h('aside', { class: 'seite' },
    h('div', { class: 'marke' }, h('strong', null, 'Watch-only Wallet'), h('span', null, 'Ansehen und empfangen, ohne private Schlüssel')),
    state.wallets.length ? h('nav', { class: 'wallets', 'aria-label': 'Wallets' }, state.wallets.map((w) => {
      const r = state.results.get(w.id);
      const sub = state.scanning.has(w.id) ? 'wird abgefragt' : r ? (state.settings.unit === 'sats' ? `${nf.format(r.confirmed)} sats` : `${(r.confirmed / 1e8).toFixed(8)} BTC`) : (specFor(w).title || '');
      return h('button', {
        class: 'wallet-knopf', type: 'button', 'aria-current': state.view === 'wallet' && state.currentId === w.id ? 'true' : 'false',
        onclick: () => openWallet(w.id),
      }, h('b', null, w.name), h('small', null, sub));
    })) : null,
    h('div', { class: 'seite-aktionen' },
      h('button', { class: 'knopf primaer', type: 'button', onclick: openAdd }, '+ Wallet hinzufügen'),
      h('button', { class: 'knopf', type: 'button', onclick: openSettings }, 'Server und Einstellungen')));
}

function openAdd() {
  state.view = 'add';
  state.add = { name: '', text: '', script: 'auto', busy: false, error: null };
  render();
  window.scrollTo(0, 0);
}
function openSettings() {
  state.view = 'settings';
  render();
  window.scrollTo(0, 0);
}

// Kopfleiste auf dem Handy: Wallet-Auswahl statt Seitenleiste
function phoneBar() {
  const w = current();
  const inWallet = state.view === 'wallet' && w;
  const placeholder = state.view === 'add' ? 'Wallet hinzufügen' : state.view === 'settings' ? 'Einstellungen' : 'Wallet wählen';
  return h('header', { class: 'handy-leiste' },
    state.wallets.length
      ? h('select', { 'aria-label': 'Wallet wählen', onchange: (e) => { if (e.target.value) openWallet(e.target.value); } },
        !inWallet ? h('option', { value: '', selected: true }, placeholder) : null,
        state.wallets.map((x) => h('option', { value: x.id, selected: inWallet && x.id === w.id }, x.name)))
      : h('span', { class: 'titel-klein' }, 'Watch-only Wallet'),
    h('button', { class: 'knopf', type: 'button', 'aria-label': 'Wallet hinzufügen', title: 'Wallet hinzufügen', onclick: openAdd }, '+'),
    h('button', { class: 'knopf', type: 'button', onclick: openSettings }, 'Einstellungen'));
}

function openWallet(id) {
  state.currentId = id;
  state.view = 'wallet';
  state.recvStep = 0;
  state.selectedAddr = null;
  state.confirmDelete = false;
  render();
  if (!state.results.has(id) && !state.errors.has(id)) refresh(id);
}

function mainView() {
  if (state.view === 'add') return addView();
  if (state.view === 'settings') return settingsView();
  const w = current();
  if (state.view === 'wallet' && w) return walletView(w);
  return startView();
}

function startView() {
  return h('div', { class: 'willkommen' },
    h('h1', null, 'Kontostand ansehen, ohne Zugriff auf die Coins'),
    h('p', null, 'Füge einen xpub, ypub oder zpub ein, oder den Descriptor einer Multisig-Wallet. Die App leitet daraus die Adressen ab, fragt Kontostand und Transaktionen ab und zeigt dir neue Empfangsadressen. Senden ist unmöglich, weil die privaten Schlüssel fehlen.'),
    h('div', { class: 'zeile' }, h('button', { class: 'knopf primaer', type: 'button', onclick: openAdd }, 'Wallet hinzufügen')),
    h('div', { class: 'feld', style: 'margin-top:28px' },
      h('h2', null, 'Was mit deinen Daten passiert'),
      h('p', { class: 'hinweis', style: 'margin:0 0 8px' }, `Die öffentlichen Schlüssel bleiben im Speicher dieses Browsers. Für die Abfrage gehen die abgeleiteten Adressen an den eingestellten Server (zurzeit ${serverName()}). Dieser sieht, welche Adressen zusammengehören, und deine IP-Adresse.`),
      h('p', { class: 'hinweis', style: 'margin:0' }, 'Mehr Privatsphäre bringt ein eigener Server, etwa mempool auf einem eigenen Node. Die Adresse stellst du unter "Einstellungen" ein.')),
    location.protocol === 'https:' ? h('div', { class: 'feld' },
      h('h2', null, 'Als App auf dem Handy'),
      h('p', { class: 'hinweis', style: 'margin:0' }, 'iPhone: in Safari Teilen und dann "Zum Home-Bildschirm". Android: im Chrome-Menü "Zum Startbildschirm hinzufügen" oder "App installieren". Die als App gestartete Version hat ihren eigenen Speicher: Wallets dort neu hinzufügen.')) : null);
}

function walletView(w) {
  const spec = specFor(w);
  if (spec.error) {
    return h('div', null, h('div', { class: 'meldung fehler' }, `Diese Wallet lässt sich nicht mehr lesen: ${spec.error}`), infoTab(w, spec));
  }
  const res = state.results.get(w.id);
  const scan = state.scanning.get(w.id);
  const err = state.errors.get(w.id);
  const unit = state.settings.unit;

  const total = res ? res.confirmed : 0;
  const kopf = h('header', { class: 'kopf' },
    h('div', null, h('h1', null, w.name), h('div', { class: 'typ' }, `${spec.title}, ${spec.scriptLabel}`)),
    h('div', { class: 'umschalter', role: 'group', 'aria-label': 'Einheit' },
      ['btc', 'sats'].map((u) => h('button', { type: 'button', 'aria-pressed': unit === u ? 'true' : 'false', onclick: () => { state.settings.unit = u; save(); render(); } }, u === 'btc' ? 'BTC' : 'sats'))),
    h('div', { class: 'saldo' },
      h('div', { class: 'betrag-gross', 'aria-label': 'Bestätigter Kontostand' }, res ? amount(total, { unit: false }) : h('span', { class: 'dim' }, '–'),
        h('span', { class: 'einheit' }, unit === 'sats' ? 'sats' : 'BTC')),
      res && res.price ? h('div', { class: 'chf' }, `ca. ${chf(total, res.price)}`) : null),
    res && res.pending !== 0 ? h('div', { class: 'offen-zeile' }, amount(res.pending, { signed: true }), ' unbestätigt') : null,
    h('div', { class: 'status-zeile' },
      h('button', { class: 'knopf klein', type: 'button', disabled: !!scan, onclick: () => refresh(w.id) }, scan ? 'Abfrage läuft' : 'Aktualisieren'),
      h('span', { id: 'scan-status', 'aria-live': 'polite' },
        scan ? `Abfrage läuft: ${scan.phase || 'Adressen'} (${scan.requests || 0} Anfragen an ${serverName()})`
          : res ? `Stand ${new Date(res.scannedAt).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}${res.tip ? `, Block ${nf.format(res.tip)}` : ''}, ${res.requests} Anfragen an ${res.server}${res.price ? `, Kurs ${nf.format(Math.round(res.price.chf))} CHF/BTC` : ''}`
            : 'Noch nicht abgefragt')));

  const tabs = [
    ['tx', 'Transaktionen', res ? res.txs.length : null],
    ['recv', 'Empfangen', null],
    ['addr', 'Adressen', res ? res.addresses.filter((a) => a.txCount > 0).length : null],
    ['utxo', 'UTXOs', res ? res.utxos.length : null],
    ['info', 'Aufbau', null],
  ];
  const reiter = h('div', { class: 'reiter', role: 'tablist' }, tabs.map(([id, label, n]) =>
    h('button', { type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': state.tab === id ? 'true' : 'false', onclick: () => { state.tab = id; render(); } },
      label, n != null ? h('span', { class: 'zahl' }, n) : null)));

  let body;
  if (state.tab === 'tx') body = txTab(res);
  else if (state.tab === 'recv') body = recvTab(spec, res);
  else if (state.tab === 'addr') body = addrTab(spec, res);
  else if (state.tab === 'utxo') body = utxoTab(spec, res);
  else body = infoTab(w, spec);

  return h('div', null, kopf,
    err ? h('div', { class: 'meldung fehler', style: 'margin-top:16px' }, err) : null,
    state.errors.has(w.id + ':note') ? h('div', { class: 'meldung info', style: 'margin-top:16px' }, state.errors.get(w.id + ':note'), ' ',
      h('button', { class: 'knopf klein', type: 'button', onclick: () => { state.errors.delete(w.id + ':note'); render(); } }, 'Ausblenden')) : null,
    reiter, h('section', { role: 'tabpanel', 'aria-labelledby': `tab-${state.tab}` }, body));
}

function needScan(res) {
  if (res) return null;
  return h('p', { class: 'hinweis' }, 'Noch keine Daten. Mit "Aktualisieren" fragst du den Server ab.');
}

function txTab(res) {
  if (!res) return needScan(res);
  if (!res.txs.length) return h('div', { class: 'feld' }, h('p', { style: 'margin:0' }, 'Noch keine Transaktionen. Unter "Empfangen" findest du eine Adresse für die erste Zahlung.'));
  const KIND = { in: 'Eingang', out: 'Ausgang', self: 'Intern' };
  return tbl(
    h('thead', null, h('tr', null, h('th', null, 'Datum'), h('th', null, 'Art'), h('th', { class: 'zahl' }, 'Betrag'), h('th', { class: 'zahl nur-breit' }, 'Gebühr'), h('th', { class: 'nur-breit' }, 'Bestätigungen'), h('th', null, 'Transaktion'))),
    h('tbody', null, res.txs.map((t) => h('tr', null,
      h('td', null, t.time ? new Date(t.time * 1000).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' }) : h('span', { class: 'marke-tx offen' }, 'unbestätigt')),
      h('td', null, KIND[t.kind]),
      h('td', { class: 'zahl ' + (t.net > 0 ? 'ein' : t.net < 0 ? 'aus' : '') }, amount(t.net, { signed: true })),
      h('td', { class: 'zahl nur-breit' }, t.fee != null ? `${nf.format(t.fee)} sats` : ''),
      h('td', { class: 'nur-breit' }, t.confirmed ? (t.confirmations >= 6 ? '6+' : String(t.confirmations || '')) : '0'),
      h('td', null, h('a', { href: explorerTx(t.txid), target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, shortMid(t.txid, 8, 6)))))));
}

function receiveIndex(res) {
  // n-te freie Empfangsadresse ab der ersten unbenutzten
  const used = new Set(res ? res.addresses.filter((a) => a.chain === 0 && a.txCount > 0).map((a) => a.index) : []);
  let idx = res ? res.nextReceiveIndex : 0;
  let step = state.recvStep;
  while (true) {
    if (!used.has(idx)) { if (step === 0) return idx; step--; }
    idx++;
  }
}

function recvTab(spec, res) {
  const scanning = state.scanning.has(state.currentId);
  const index = receiveIndex(res);
  const address = deriveAddress(spec, 0, index);
  const groups = address.match(/.{1,4}/g);
  const gap = Number(state.settings.gap) || 20;
  return h('div', null,
    !res ? h('div', { class: 'meldung warn' }, scanning ? 'Abfrage läuft: Gleich ist klar, welche Adressen schon benutzt wurden.' : 'Noch nicht abgefragt: Ob diese Adresse schon benutzt wurde, ist unbekannt.') : null,
    state.recvStep >= gap ? h('div', { class: 'meldung warn' }, `Mehr als ${gap} unbenutzte Adressen hintereinander: Andere Wallets mit Lückengrenze ${gap} finden Zahlungen an diese Adresse eventuell nicht.`) : null,
    h('div', { class: 'empfang' },
      h('div', { class: 'qr' }, qrSvg(`bitcoin:${address}`)),
      h('div', null,
        h('div', { class: 'adresse-gross', 'aria-label': address }, groups.map((g) => h('span', null, g))),
        h('div', { class: 'index-zeile' },
          copyBtn(address, 'Adresse kopieren'),
          h('button', { class: 'knopf klein', type: 'button', disabled: state.recvStep === 0, onclick: () => { state.recvStep--; render(); } }, 'Vorherige'),
          h('button', { class: 'knopf klein', type: 'button', onclick: () => { state.recvStep++; render(); } }, 'Nächste freie Adresse'),
          h('span', { class: 'hinweis' }, `Index ${index}`)),
        spec.isMultisig
          ? h('div', { class: 'meldung info' }, 'Prüfe diese Adresse auf mindestens einem Signiergerät, bevor du sie weitergibst. Nur so ist sicher, dass sie wirklich zu deinem Multisig gehört.')
          : h('div', { class: 'meldung info' }, 'Am sichersten ist es, die Adresse auf dem Signiergerät zu vergleichen, bevor du sie weitergibst.'))),
    h('div', { class: 'feld', style: 'margin-top:20px' },
      h('h2', null, 'Ableitungspfad dieser Adresse'),
      pathsBlock(spec, 0, index),
      pathLegend()));
}

function addrTab(spec, res) {
  let rows;
  if (res) rows = res.addresses;
  else {
    rows = [];
    for (let i = 0; i < 10; i++) rows.push({ chain: 0, index: i, address: deriveAddress(spec, 0, i), txCount: null });
    if (spec.hasChange) for (let i = 0; i < 5; i++) rows.push({ chain: 1, index: i, address: deriveAddress(spec, 1, i), txCount: null });
  }
  if (state.hideUnused && res) rows = rows.filter((a) => a.txCount > 0);
  const sel = rows.find((a) => a.address === state.selectedAddr);
  return h('div', null,
    !res ? h('p', { class: 'hinweis' }, 'Noch nicht abgefragt. Hier sind die ersten Adressen, lokal aus dem Schlüssel berechnet.') : null,
    sel ? h('div', { class: 'feld', style: 'margin-bottom:16px' },
      h('h2', null, `${sel.chain === 0 ? 'Empfangsadresse' : 'Wechselgeldadresse'} ${sel.index}`),
      h('div', { class: 'mono kurz', style: 'margin-bottom:8px' }, sel.address, ' ', copyBtn(sel.address)),
      pathsBlock(spec, sel.chain, sel.index), pathLegend())
      : h('p', { class: 'hinweis' }, 'Wähle eine Adresse, um ihren Ableitungspfad zu sehen.'),
    res ? h('label', { class: 'zeile', style: 'margin:0 0 12px;font-size:14px' },
      h('input', { type: 'checkbox', checked: state.hideUnused, onchange: (e) => { state.hideUnused = e.target.checked; render(); } }), 'Nur benutzte Adressen zeigen') : null,
    tbl(
      h('thead', null, h('tr', null, h('th', null, 'Kette'), h('th', { class: 'zahl' }, 'Index'), h('th', null, 'Adresse'), h('th', { class: 'nur-breit' }, 'Pfad'), h('th', { class: 'zahl' }, 'Tx'), h('th', { class: 'zahl' }, 'Saldo'))),
      h('tbody', null, rows.map((a) => {
        const p = derivationPaths(spec, a.chain, a.index)[0];
        const tail = p.full.split('/').slice(-2).join('/');
        return h('tr', {
          class: 'klickbar' + (a.address === state.selectedAddr ? ' gewaehlt' : '') + (a.txCount === 0 ? ' leer' : ''),
          tabindex: '0',
          onclick: () => { state.selectedAddr = a.address; render(); },
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.selectedAddr = a.address; render(); } },
        },
        h('td', null, a.chain === 0 ? 'Empfangen' : 'Wechselgeld'),
        h('td', { class: 'zahl' }, a.index),
        h('td', { class: 'mono kurz' }, a.address),
        h('td', { class: 'mono nur-breit' }, `…/${tail}`),
        h('td', { class: 'zahl' }, a.txCount == null ? '' : a.txCount),
        h('td', { class: 'zahl' }, a.txCount ? amount(a.confirmed + a.pending, { unit: false }) : ''));
      }))));
}

function utxoTab(spec, res) {
  if (!res) return needScan(res);
  if (!res.utxos.length) return h('div', { class: 'feld' }, h('p', { style: 'margin:0' }, 'Keine unverbrauchten Outputs: Der Kontostand ist null.'));
  return h('div', null,
    h('p', { class: 'hinweis', style: 'margin-top:0' }, 'Dein Guthaben besteht aus diesen einzelnen Münzen (UTXOs). Beim Senden wählt die Wallet-Software einige davon als Inputs aus.'),
    tbl(
      h('thead', null, h('tr', null, h('th', { class: 'zahl' }, 'Betrag'), h('th', null, 'Adresse'), h('th', { class: 'nur-breit' }, 'Kette/Index'), h('th', null, 'Status'), h('th', null, 'Outpoint'))),
      h('tbody', null, res.utxos.map((u) => h('tr', null,
        h('td', { class: 'zahl' }, amount(u.value, { unit: false })),
        h('td', { class: 'mono kurz' }, shortMid(u.address, 12, 8)),
        h('td', { class: 'mono nur-breit' }, `${u.chain}/${u.index}`),
        h('td', null, u.confirmed ? 'bestätigt' : h('span', { class: 'marke-tx offen' }, 'unbestätigt')),
        h('td', null, h('a', { href: explorerTx(u.txid), target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, `${shortMid(u.txid, 8, 4)}:${u.vout}`)))))));
}

function infoTab(w, spec) {
  const parts = [];
  if (!spec.error) {
    parts.push(h('div', { class: 'feld' },
      h('h2', null, 'Wallet-Typ'),
      h('div', { class: 'vorschau', style: 'border:0;padding:0;margin:0' }, h('dl', null,
        h('dt', null, 'Typ'), h('dd', null, spec.isMultisig ? `${spec.threshold}-von-${spec.keys.length} Multisig${spec.sorted ? ' (sortedmulti: Schlüssel je Adresse sortiert)' : ' (multi: feste Schlüsselreihenfolge)'}` : 'Single-Sig, ein Schlüssel'),
        h('dt', null, 'Skript'), h('dd', null, spec.scriptLabel),
        h('dt', null, 'Wechselgeld'), h('dd', null, spec.hasChange ? 'eigene Kette (…/1/…)' : 'keine eigene Kette'),
        h('dt', null, 'Prüfsumme'), h('dd', null, spec.checksumOk ? 'im Original vorhanden und korrekt' : 'im Original nicht vorhanden, hier berechnet'))),
      h('h3', null, 'Descriptor'),
      h('div', { class: 'descriptor' }, spec.descriptor),
      h('div', { class: 'zeile', style: 'margin-top:8px' }, copyBtn(spec.descriptor, 'Descriptor kopieren'),
        h('span', { class: 'hinweis' }, 'Damit lässt sich die Wallet in Sparrow oder Bitcoin Core als Watch-only importieren. Bei Multisig ist er Teil der Datensicherung.'))));

    parts.push(h('div', { class: 'feld' },
      h('h2', null, spec.isMultisig ? `Schlüssel der ${spec.keys.length} Mitsignierenden` : 'Schlüssel'),
      tbl(
        h('thead', null, h('tr', null, h('th', null, 'Fingerprint'), h('th', null, 'Kontopfad'), h('th', null, 'xpub'))),
        h('tbody', null, spec.keys.map((k, i) => h('tr', null,
          h('td', null, fpChip(k.origin ? k.origin.fingerprint : null, i)),
          h('td', { class: 'mono' }, k.origin ? 'm' + k.origin.path.map((p) => '/' + stepToString(p)).join('') : h('span', { class: 'hinweis' }, `nicht angegeben, Standard wäre ${STANDARD_PATHS[spec.script]}`)),
          h('td', null, h('span', { class: 'mono' }, shortMid(k.original, 12, 8)), ' ', copyBtn(k.original)))))),
      h('h3', null, 'Pfad der ersten Empfangsadresse'),
      pathsBlock(spec, 0, 0),
      pathLegend()));
  }

  const nameInput = h('input', { type: 'text', id: 'rename', value: w.name, 'aria-label': 'Name der Wallet' });
  parts.push(h('div', { class: 'feld' },
    h('h2', null, 'Verwalten'),
    h('label', { class: 'titel', for: 'rename' }, 'Name'),
    h('div', { class: 'zeile', style: 'margin-top:0' }, h('div', { style: 'flex:1;min-width:200px' }, nameInput),
      h('button', { class: 'knopf', type: 'button', onclick: () => { const n = nameInput.value.trim(); if (n) { w.name = n; save(); render(); } } }, 'Name speichern')),
    h('div', { class: 'zeile' },
      state.confirmDelete
        ? [h('span', null, 'Wallet aus diesem Browser entfernen? Die Coins bleiben unberührt.'),
          h('button', { class: 'knopf gefahr scharf', type: 'button', onclick: () => removeWallet(w.id) }, 'Ja, entfernen'),
          h('button', { class: 'knopf', type: 'button', onclick: () => { state.confirmDelete = false; render(); } }, 'Abbrechen')]
        : h('button', { class: 'knopf gefahr', type: 'button', onclick: () => { state.confirmDelete = true; render(); } }, 'Wallet entfernen'))));
  return h('div', null, parts);
}

function removeWallet(id) {
  state.wallets = state.wallets.filter((w) => w.id !== id);
  state.specs.delete(id); state.results.delete(id); state.errors.delete(id);
  save();
  state.currentId = null;
  state.view = 'start';
  state.confirmDelete = false;
  render();
}

// ---------------------------------------------------------------------------
// Wallet hinzufügen
// ---------------------------------------------------------------------------
function analyzeInput() {
  const a = state.add;
  if (!a.text.trim()) return { empty: true };
  try {
    const r = parseInput(a.text, a.script !== 'auto' ? a.script : undefined);
    if (r.needsScriptChoice) return { choice: true, key: r.key };
    return { spec: r };
  } catch (e) {
    if (e instanceof InputError) return { error: e.message };
    // Fehler bei falschem Typ-Override (z.B. zpub + Taproot) → ohne Override erneut
    return { error: e.message || String(e) };
  }
}

function addView() {
  const a = state.add;
  const an = analyzeInput();
  const nameIn = h('input', { type: 'text', id: 'add-name', value: a.name, placeholder: 'z.B. Sparwallet', oninput: (e) => { a.name = e.target.value; } });
  const ta = h('textarea', {
    id: 'add-text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
    placeholder: 'zpub6r… oder wsh(sortedmulti(2,[a1b2c3d4/48h/0h/0h/2h]xpub…/<0;1>/*,…))#…',
    oninput: (e) => { a.text = e.target.value; a.error = null; scheduleAddRender(); },
  });
  ta.value = a.text;

  let preview = null;
  if (an.error) preview = h('div', { class: 'meldung fehler', style: 'margin-top:12px' }, an.error);
  else if (an.choice) {
    const opts = TYPEN_XPUB.map((t) => {
      let first = '';
      try { first = deriveAddress(parseInput(a.text, t), 0, 0); } catch { /* */ }
      return { t, first };
    });
    preview = h('div', { class: 'vorschau' },
      h('p', { style: 'margin:0 0 8px' }, 'Ein xpub verrät den Adresstyp nicht. Je nach Typ ergibt derselbe Schlüssel ganz andere Adressen:'),
      h('dl', null, opts.map((o) => [h('dt', null, TYP_KURZ[o.t]), h('dd', { class: 'mono kurz' }, o.first)])),
      h('label', { class: 'titel', for: 'add-script' }, 'Adresstyp'),
      h('select', { id: 'add-script', onchange: (e) => { a.script = e.target.value; render(); } },
        h('option', { value: 'auto', selected: a.script === 'auto' }, 'Automatisch erkennen (fragt die erste Adresse jedes Typs ab)'),
        TYPEN_XPUB.map((t) => h('option', { value: t, selected: a.script === t }, SCRIPT_LABELS[t]))),
      h('p', { class: 'hinweis' }, 'Vergleiche mit der ersten Empfangsadresse in deiner Wallet-Software.'));
  } else if (an.spec) {
    const s = an.spec;
    const firsts = [0, 1, 2].map((i) => deriveAddress(s, 0, i));
    preview = h('div', { class: 'vorschau' },
      h('dl', null,
        h('dt', null, 'Erkannt'), h('dd', null, `${s.title}, ${s.scriptLabel}`),
        s.isMultisig ? [h('dt', null, 'Schlüssel'), h('dd', null, s.keys.map((k, i) => [fpChip(k.origin ? k.origin.fingerprint : null, i), ' ']))] : null,
        h('dt', null, 'Prüfsumme'), h('dd', null, s.checksumOk ? 'vorhanden und korrekt' : 'keine angegeben'),
        h('dt', null, 'Erste Adressen'), h('dd', { class: 'mono kurz' }, firsts.map((f) => h('div', null, f)))),
      h('p', { class: 'hinweis' }, 'Stimmen diese Adressen mit deiner Wallet-Software überein? Dann ist alles richtig erkannt.'));
  }

  const canSave = (an.spec || an.choice) && !a.busy;
  return h('div', { style: 'max-width:760px' },
    h('h1', { style: 'font-size:24px;margin:0 0 4px' }, 'Wallet hinzufügen'),
    h('p', { class: 'hinweis', style: 'margin:0 0 6px' }, 'Nur öffentliche Schlüssel: xpub, ypub, zpub oder ein Descriptor. Seed-Wörter und private Schlüssel (xprv) gehören nie hierher.'),
    h('div', { class: 'feld' },
      h('label', { class: 'titel', for: 'add-name', style: 'margin-top:0' }, 'Name'), nameIn,
      h('label', { class: 'titel', for: 'add-text' }, 'Extended Public Key oder Descriptor'), ta,
      h('div', { id: 'add-preview' }, preview,
        a.error ? h('div', { class: 'meldung fehler', style: 'margin-top:12px' }, a.error) : null),
      h('div', { class: 'zeile' },
        h('button', { class: 'knopf primaer', type: 'button', id: 'add-save', disabled: !canSave, onclick: saveNewWallet }, a.busy ? 'Typ wird erkannt' : 'Wallet speichern'),
        h('button', { class: 'knopf', type: 'button', onclick: () => { state.view = state.currentId ? 'wallet' : 'start'; render(); } }, 'Abbrechen'))));
}

let addTimer = null;
function scheduleAddRender() {
  clearTimeout(addTimer);
  addTimer = setTimeout(() => {
    // Nur Vorschau und Speichern-Knopf ersetzen, damit der Cursor im Textfeld bleibt
    const fresh = addView();
    for (const id of ['add-preview', 'add-save']) {
      const oldEl = document.getElementById(id);
      const newEl = fresh.querySelector('#' + id);
      if (oldEl && newEl) oldEl.replaceWith(newEl);
    }
  }, 250);
}

async function saveNewWallet() {
  const a = state.add;
  const an = analyzeInput();
  let script = null;
  if (an.choice) {
    if (a.script === 'auto') {
      a.busy = true; render();
      try {
        const det = await detectScriptType(new Api(state.settings.api), a.text);
        script = det.script;
        a.detectNote = det.found.length
          ? `Erkannt: ${SCRIPT_LABELS[det.script]}${det.found.length > 1 ? ` (auch benutzt: ${det.found.slice(1).map((t) => TYP_KURZ[t]).join(', ')})` : ''}.`
          : `Keine Historie gefunden, darum ${SCRIPT_LABELS.wpkh} angenommen. Unter "Aufbau" siehst du den Typ; bei Bedarf Wallet entfernen und mit anderem Typ neu hinzufügen.`;
      } catch (e) {
        a.busy = false; a.error = `Automatische Erkennung fehlgeschlagen: ${e.message}. Wähle den Adresstyp von Hand.`; render();
        return;
      }
      a.busy = false;
    } else script = a.script;
  } else if (!an.spec) return;

  const spec = an.spec || parseInput(a.text, script);
  if (state.wallets.some((w) => specFor(w).descriptor === spec.descriptor)) {
    a.error = 'Diese Wallet ist bereits gespeichert.'; render(); return;
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const name = a.name.trim() || `${spec.title} ${TYP_KURZ[spec.script]}`;
  state.wallets.push({ id, name, input: a.text.trim(), script: an.choice ? script : null, created: Date.now() });
  state.specs.set(id, spec);
  const stored = save();
  state.errors.delete(id);
  const note = a.detectNote;
  state.add = { name: '', text: '', script: 'auto', busy: false, error: null };
  state.tab = 'tx';
  openWallet(id);
  if (note) state.errors.set(id + ':note', note);
  if (!stored) state.errors.set(id + ':note', (note ? note + ' ' : '') + 'Hinweis: Dieser Browser erlaubt kein dauerhaftes Speichern. Die Wallet ist nach dem Schliessen wieder weg.');
  render();
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
const MIXED_TEXT = 'Diese Seite läuft über https. Der Browser blockiert darum Anfragen an http-Adressen. Gib eine https-Adresse an, oder öffne die App als lokale Datei.';
function mixedContent(url) {
  return location.protocol === 'https:' && /^http:\/\//i.test(url);
}

function settingsView() {
  const s = state.settings;
  const urlIn = h('input', { type: 'url', id: 'set-url', value: s.api, spellcheck: 'false' });
  const gapIn = h('input', { type: 'number', id: 'set-gap', min: '5', max: '200', value: String(s.gap) });
  const msg = h('div', { 'aria-live': 'polite' });
  return h('div', { style: 'max-width:760px' },
    h('h1', { style: 'font-size:24px;margin:0 0 14px' }, 'Server und Einstellungen'),
    h('div', { class: 'feld' },
      h('h2', null, 'Server für die Abfrage'),
      h('p', { class: 'hinweis', style: 'margin-top:0' }, 'Die App braucht eine Esplora-kompatible Schnittstelle, wie sie mempool.space und blockstream.info anbieten. Ein eigener mempool-Server auf deinem Node funktioniert ebenfalls, sofern er Anfragen aus dem Browser zulässt (CORS).'),
      h('div', { class: 'zeile', style: 'margin-top:0' }, PRESETS.map((p) =>
        h('button', { class: 'knopf klein', type: 'button', onclick: () => { urlIn.value = p.url; } }, p.name))),
      h('label', { class: 'titel', for: 'set-url' }, 'Adresse der Schnittstelle'), urlIn,
      h('p', { class: 'hinweis' }, location.protocol === 'https:'
        ? 'Eigener Server: Weil diese Seite über https läuft, muss auch der Server per https erreichbar sein.'
        : 'Beispiel eigener Node: http://umbrel.local:3006/api'),
      h('label', { class: 'titel', for: 'set-gap' }, 'Lückengrenze (Gap Limit)'), gapIn,
      h('p', { class: 'hinweis' }, 'So viele unbenutzte Adressen hintereinander werden geprüft, bevor die Suche aufhört. Üblich sind 20. Wenn eine Wallet-Software viele Adressen übersprungen hat, hier erhöhen.'),
      h('div', { class: 'zeile' },
        h('button', { class: 'knopf primaer', type: 'button', onclick: () => {
          const url = urlIn.value.trim();
          const gap = Math.max(5, Math.min(200, Number(gapIn.value) || 20));
          if (!/^https?:\/\/[^\s]+$/.test(url)) { msg.replaceChildren(h('div', { class: 'meldung fehler', style: 'margin-top:12px' }, 'Bitte eine Adresse mit http:// oder https:// angeben.')); return; }
          if (mixedContent(url)) { msg.replaceChildren(h('div', { class: 'meldung fehler', style: 'margin-top:12px' }, MIXED_TEXT)); return; }
          const changed = url.replace(/\/+$/, '') !== s.api || gap !== Number(s.gap);
          s.api = url.replace(/\/+$/, ''); s.gap = gap;
          const ok = save();
          if (changed) { state.results.clear(); state.errors.clear(); }
          msg.replaceChildren(h('div', { class: ok ? 'meldung info' : 'meldung warn', style: 'margin-top:12px' }, ok ? 'Einstellungen gespeichert.' : 'Gespeichert für diese Sitzung. Dieser Browser erlaubt kein dauerhaftes Speichern.'));
        } }, 'Einstellungen speichern'),
        h('button', { class: 'knopf', type: 'button', onclick: async (e) => {
          const btn = e.currentTarget;
          if (mixedContent(urlIn.value.trim())) { msg.replaceChildren(h('div', { class: 'meldung fehler', style: 'margin-top:12px' }, MIXED_TEXT)); return; }
          btn.disabled = true;
          try {
            const tip = await new Api(urlIn.value.trim()).tipHeight();
            if (!Number.isFinite(tip)) throw new Error('Antwort ist keine Blockhöhe');
            msg.replaceChildren(h('div', { class: 'meldung info', style: 'margin-top:12px' }, `Verbindung funktioniert, aktuelle Blockhöhe ${nf.format(tip)}.`));
          } catch (err) {
            msg.replaceChildren(h('div', { class: 'meldung fehler', style: 'margin-top:12px' }, `Verbindung fehlgeschlagen: ${err.message}`));
          } finally { btn.disabled = false; }
        } }, 'Verbindung testen')),
      msg),
    h('div', { class: 'feld' },
      h('h2', null, 'Privatsphäre'),
      h('p', { class: 'hinweis', style: 'margin:0' }, 'Der Server erfährt alle Adressen einer Wallet auf einmal und kann sie dir über deine IP-Adresse zuordnen. Bei einem öffentlichen Server ist das bei jeder Abfrage der Fall. Ein eigener Node vermeidet das.')));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
load();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
if (state.wallets.length) openWallet(state.wallets[0].id);
else render();
