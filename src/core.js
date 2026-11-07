// Kernlogik der Watch-only-Wallet: Eingaben parsen, Adressen ableiten.
// Keine privaten Schlüssel: Es wird ausschliesslich mit öffentlichen Schlüsseln gerechnet.
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const b58c = createBase58check(sha256);

// ---------------------------------------------------------------------------
// Versions-Bytes (BIP32 / SLIP-132)
// ---------------------------------------------------------------------------
const XPUB_VERSION = 0x0488b21e;
const PUB_VERSIONS = {
  0x0488b21e: { prefix: 'xpub', single: null, multi: null },
  0x049d7cb2: { prefix: 'ypub', single: 'sh-wpkh', multi: null },
  0x04b24746: { prefix: 'zpub', single: 'wpkh', multi: null },
  0x0295b43f: { prefix: 'Ypub', single: null, multi: 'sh-wsh' },
  0x02aa7ed3: { prefix: 'Zpub', single: null, multi: 'wsh' },
};
const TESTNET_PUB = new Set([0x043587cf, 0x044a5262, 0x045f1cf6, 0x024289ef, 0x02575483]);
const PRIV_VERSIONS = new Set([
  0x0488ade4, 0x049d7878, 0x04b2430c, 0x0295b005, 0x02aa7a99, // mainnet
  0x04358394, 0x044a4e28, 0x045f18bc, 0x024285b5, 0x02575048, // testnet
]);

export class InputError extends Error {}

// Wandelt xpub/ypub/zpub/Ypub/Zpub in die Standardform "xpub" um.
export function normalizeExtendedKey(str) {
  let raw;
  try {
    raw = b58c.decode(str);
  } catch {
    throw new InputError(`"${short(str)}" ist kein gültiger Extended Public Key (Prüfsumme falsch oder Tippfehler).`);
  }
  if (raw.length !== 78) throw new InputError(`"${short(str)}" hat nicht die Länge eines Extended Keys.`);
  const version = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
  if (PRIV_VERSIONS.has(version)) {
    throw new InputError('Achtung: Das ist ein PRIVATER Schlüssel (xprv/yprv/zprv). Gib ihn nirgends ein – eine Watch-only-Wallet braucht nur den öffentlichen Schlüssel (xpub/ypub/zpub).');
  }
  if (TESTNET_PUB.has(version)) throw new InputError('Testnet-Schlüssel (tpub/upub/vpub) werden nicht unterstützt – diese App ist nur für Mainnet.');
  const info = PUB_VERSIONS[version];
  if (!info) throw new InputError(`Unbekannter Schlüsseltyp in "${short(str)}".`);
  const std = new Uint8Array(raw);
  std[0] = 0x04; std[1] = 0x88; std[2] = 0xb2; std[3] = 0x1e;
  const xpub = b58c.encode(std);
  const node = HDKey.fromExtendedKey(xpub);
  return {
    xpub,
    original: str,
    prefix: info.prefix,
    impliedSingle: info.single,
    impliedMulti: info.multi,
    depth: node.depth,
    childIndex: node.index,
    parentFingerprint: node.parentFingerprint,
    node,
  };
}

function short(s) {
  s = String(s);
  return s.length > 24 ? s.slice(0, 12) + '…' + s.slice(-8) : s;
}

// ---------------------------------------------------------------------------
// Descriptor-Checksumme (BIP380)
// ---------------------------------------------------------------------------
const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function polymod(symbols) {
  let chk = 1n;
  for (const v of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) chk ^= GEN[i];
  }
  return chk;
}

export function descriptorChecksum(desc) {
  const symbols = [];
  let groups = [];
  for (const c of desc) {
    const v = INPUT_CHARSET.indexOf(c);
    if (v < 0) throw new InputError(`Ungültiges Zeichen im Descriptor: "${c}"`);
    symbols.push(v & 31);
    groups.push(v >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
      groups = [];
    }
  }
  if (groups.length === 1) symbols.push(groups[0]);
  else if (groups.length === 2) symbols.push(groups[0] * 3 + groups[1]);
  const chk = polymod([...symbols, 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  let out = '';
  for (let i = 0; i < 8; i++) out += CHECKSUM_CHARSET[Number((chk >> BigInt(5 * (7 - i))) & 31n)];
  return out;
}

// ---------------------------------------------------------------------------
// Pfade
// ---------------------------------------------------------------------------
const HARD = 0x80000000;

function parseStep(tok, allowHardened) {
  const m = /^(\d+)(['hH]?)$/.exec(tok);
  if (!m) throw new InputError(`Ungültiger Pfadteil "${tok}".`);
  const n = Number(m[1]);
  if (n >= HARD) throw new InputError(`Pfadteil "${tok}" ist zu gross.`);
  if (m[2]) {
    if (!allowHardened) throw new InputError(`Gehärteter Pfadteil "${tok}" nach dem xpub ist unmöglich: Aus einem öffentlichen Schlüssel lassen sich nur ungehärtete Kinder ableiten.`);
    return n + HARD;
  }
  return n;
}

export function stepToString(n) {
  return n >= HARD ? `${n - HARD}'` : String(n);
}

// ---------------------------------------------------------------------------
// Schlüssel-Ausdruck: [fingerprint/pfad]xpub/suffix
// ---------------------------------------------------------------------------
function parseKeyExpr(expr) {
  expr = expr.trim();
  let origin = null;
  if (expr.startsWith('[')) {
    const end = expr.indexOf(']');
    if (end < 0) throw new InputError('Fehlende "]" bei der Herkunftsangabe eines Schlüssels.');
    const parts = expr.slice(1, end).split('/');
    const fp = parts.shift().toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(fp)) throw new InputError(`Ungültiger Fingerprint "${fp}" (erwartet: 8 Hex-Zeichen).`);
    origin = { fingerprint: fp, path: parts.filter(Boolean).map((p) => parseStep(p, true)) };
    expr = expr.slice(end + 1);
  }
  const slash = expr.indexOf('/');
  const keyStr = slash < 0 ? expr : expr.slice(0, slash);
  const suffixStr = slash < 0 ? '' : expr.slice(slash + 1);
  if (/^(02|03)[0-9a-fA-F]{64}$|^[0-9a-fA-F]{64}$/.test(keyStr)) {
    throw new InputError('Der Descriptor enthält einen festen Einzelschlüssel statt eines xpub. Unterstützt werden nur Descriptors mit xpub (Wallets mit vielen Adressen).');
  }
  const key = normalizeExtendedKey(keyStr);

  // Suffix: z.B. "", "0/*", "<0;1>/*", "1/*", "*"
  let steps = suffixStr ? suffixStr.split('/') : [];
  let receive, change;
  if (steps.length === 0) {
    receive = [0]; change = [1];
  } else {
    if (steps[steps.length - 1] !== '*') {
      if (/^\*['hH]$/.test(steps[steps.length - 1])) throw new InputError('Gehärtete Ableitung "*\'" ist bei einer Watch-only-Wallet unmöglich.');
      throw new InputError('Der Schlüsselpfad muss mit "/*" enden (z.B. /<0;1>/* oder /0/*).');
    }
    steps = steps.slice(0, -1);
    const multiIdx = steps.findIndex((s) => s.startsWith('<'));
    if (multiIdx >= 0) {
      const mm = /^<(\d+);(\d+)>$/.exec(steps[multiIdx]);
      if (!mm) throw new InputError(`Nur Mehrfachpfade mit zwei Werten werden unterstützt, z.B. <0;1> (gefunden: ${steps[multiIdx]}).`);
      const base = steps.map((s, i) => (i === multiIdx ? null : parseStep(s, false)));
      receive = base.map((v) => (v === null ? Number(mm[1]) : v));
      change = base.map((v) => (v === null ? Number(mm[2]) : v));
    } else {
      receive = steps.map((s) => parseStep(s, false));
      // Konvention: …/0/* = Empfangen, …/1/* = Wechselgeld
      if (receive.length && receive[receive.length - 1] === 0) change = [...receive.slice(0, -1), 1];
      else change = null;
    }
  }
  return { ...key, origin, chains: [receive, change] };
}

// ---------------------------------------------------------------------------
// Descriptor-Ausdrücke
// ---------------------------------------------------------------------------
function splitTopLevel(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '>') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

function parseFn(s) {
  const open = s.indexOf('(');
  if (open < 0 || !s.endsWith(')')) return null;
  return { name: s.slice(0, open), inner: s.slice(open + 1, -1) };
}

function parseMulti(fn) {
  const args = splitTopLevel(fn.inner);
  const k = Number(args.shift());
  if (!Number.isInteger(k) || k < 1) throw new InputError('Ungültige Schwelle (k) im Multisig-Descriptor.');
  const keys = args.map(parseKeyExpr);
  if (k > keys.length) throw new InputError(`Schwelle ${k} ist grösser als die Anzahl Schlüssel (${keys.length}).`);
  if (keys.length > 15) throw new InputError('Mehr als 15 Schlüssel werden nicht unterstützt.');
  return { threshold: k, keys, sorted: fn.name === 'sortedmulti' };
}

export const SCRIPT_LABELS = {
  pkh: 'Legacy (P2PKH, Adressen beginnen mit 1)',
  'sh-wpkh': 'Nested SegWit (P2SH-P2WPKH, Adressen beginnen mit 3)',
  wpkh: 'Native SegWit (P2WPKH, Adressen beginnen mit bc1q)',
  tr: 'Taproot (P2TR, Adressen beginnen mit bc1p)',
  wsh: 'Native SegWit Multisig (P2WSH, Adressen beginnen mit bc1q)',
  'sh-wsh': 'Nested SegWit Multisig (P2SH-P2WSH, Adressen beginnen mit 3)',
  sh: 'Legacy Multisig (P2SH, Adressen beginnen mit 3)',
};

// Übliche Kontopfade (BIP44/49/84/86/48)
export const STANDARD_PATHS = {
  pkh: "m/44'/0'/0'",
  'sh-wpkh': "m/49'/0'/0'",
  wpkh: "m/84'/0'/0'",
  tr: "m/86'/0'/0'",
  wsh: "m/48'/0'/0'/2'",
  'sh-wsh': "m/48'/0'/0'/1'",
  sh: "m/45'",
};

export function parseDescriptor(text) {
  let s = text.replace(/\s+/g, '');
  let checksumOk = null;
  const hash = s.indexOf('#');
  if (hash >= 0) {
    const given = s.slice(hash + 1);
    s = s.slice(0, hash);
    const calc = descriptorChecksum(s);
    if (given !== calc) throw new InputError(`Die Descriptor-Prüfsumme stimmt nicht (#${given}, erwartet #${calc}). Wahrscheinlich wurde der Text beim Kopieren verändert.`);
    checksumOk = true;
  }
  const top = parseFn(s);
  if (!top) throw new InputError('Das sieht nicht wie ein Descriptor aus.');
  let script, single = null, multi = null;
  const inner = parseFn(top.inner);
  switch (top.name) {
    case 'pkh': script = 'pkh'; single = parseKeyExpr(top.inner); break;
    case 'wpkh': script = 'wpkh'; single = parseKeyExpr(top.inner); break;
    case 'tr':
      if (splitTopLevel(top.inner).length > 1) throw new InputError('Taproot mit Skript-Baum (z.B. Taproot-Multisig) wird nicht unterstützt, nur tr(KEY).');
      script = 'tr'; single = parseKeyExpr(top.inner); break;
    case 'wsh':
      if (!inner || !['multi', 'sortedmulti'].includes(inner.name)) throw new InputError('Unterstützt wird bei wsh(...) nur multi(...) oder sortedmulti(...).');
      script = 'wsh'; multi = parseMulti(inner); break;
    case 'sh':
      if (inner && inner.name === 'wpkh') { script = 'sh-wpkh'; single = parseKeyExpr(inner.inner); break; }
      if (inner && inner.name === 'wsh') {
        const ii = parseFn(inner.inner);
        if (!ii || !['multi', 'sortedmulti'].includes(ii.name)) throw new InputError('Unterstützt wird bei sh(wsh(...)) nur multi(...) oder sortedmulti(...).');
        script = 'sh-wsh'; multi = parseMulti(ii); break;
      }
      if (inner && ['multi', 'sortedmulti'].includes(inner.name)) { script = 'sh'; multi = parseMulti(inner); break; }
      throw new InputError('Dieser sh(...)-Descriptor wird nicht unterstützt.');
    default:
      throw new InputError(`Descriptor-Typ "${top.name}(...)" wird nicht unterstützt.`);
  }
  return buildWalletSpec({ script, single, multi, checksumOk, source: 'descriptor' });
}

// Spezifikation aus einem einzelnen xpub/ypub/zpub. scriptOverride: Adresstyp bei "xpub".
export function parseExtendedKeyInput(str, scriptOverride) {
  const key = parseKeyExpr(str.trim());
  if (key.impliedMulti) throw new InputError(`Ein ${key.prefix} gehört zu einer Multisig-Wallet. Bitte den vollständigen Multisig-Descriptor einfügen (z.B. aus Sparrow über den Export in den Wallet-Einstellungen).`);
  const script = scriptOverride || key.impliedSingle;
  if (!script) return { needsScriptChoice: true, key };
  if (key.impliedSingle && scriptOverride && scriptOverride !== key.impliedSingle) {
    throw new InputError(`Ein ${key.prefix} steht für ${SCRIPT_LABELS[key.impliedSingle]}.`);
  }
  return buildWalletSpec({ script, single: key, multi: null, checksumOk: null, source: 'xpub' });
}

// Erkennt Eingabeart und liefert eine Wallet-Spezifikation
export function parseInput(text, scriptOverride) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) throw new InputError('Bitte einen xpub/zpub oder einen Descriptor einfügen.');
  const words = lines.join(' ').split(/\s+/);
  if (words.length >= 12 && words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    throw new InputError('Das sieht aus wie eine Seed-Phrase! Gib deine Wörter niemals in eine App oder Webseite ein. Eine Watch-only-Wallet braucht nur den xpub oder den Descriptor.');
  }
  const descLine = lines.find((l) => l.includes('('));
  if (descLine) return parseDescriptor(descLine);
  if (lines.length > 1 || words.length > 1) throw new InputError('Bitte nur einen einzigen Schlüssel oder Descriptor einfügen.');
  return parseExtendedKeyInput(lines[0], scriptOverride);
}

function keyToDescString(k, chainSuffix) {
  const origin = k.origin ? `[${k.origin.fingerprint}${k.origin.path.map((p) => '/' + stepToString(p).replace("'", 'h')).join('')}]` : '';
  return `${origin}${k.xpub}${chainSuffix(k)}`;
}

function suffixFor(k) {
  const [r, c] = k.chains;
  if (!c) return '/' + [...r.map(String), '*'].join('/');
  const parts = r.map((v, i) => (v === c[i] ? String(v) : `<${v};${c[i]}>`));
  return '/' + [...parts, '*'].join('/');
}

function buildWalletSpec({ script, single, multi, checksumOk, source }) {
  const keys = single ? [single] : multi.keys;
  // Doppelte Schlüssel erkennen
  const seen = new Set();
  for (const k of keys) {
    if (seen.has(k.xpub)) throw new InputError('Derselbe xpub kommt mehrfach vor.');
    seen.add(k.xpub);
  }
  const hasChange = keys.every((k) => k.chains[1]);
  let body;
  if (single) body = keyToDescString(single, suffixFor);
  else body = `${multi.sorted ? 'sortedmulti' : 'multi'}(${multi.threshold},${multi.keys.map((k) => keyToDescString(k, suffixFor)).join(',')})`;
  const wrap = { pkh: 'pkh(#)', wpkh: 'wpkh(#)', 'sh-wpkh': 'sh(wpkh(#))', tr: 'tr(#)', wsh: 'wsh(#)', 'sh-wsh': 'sh(wsh(#))', sh: 'sh(#)' }[script];
  const desc = wrap.replace('#', body);
  const descriptor = `${desc}#${descriptorChecksum(desc)}`;
  const spec = {
    script,
    scriptLabel: SCRIPT_LABELS[script],
    isMultisig: !!multi,
    threshold: multi ? multi.threshold : 1,
    sorted: multi ? multi.sorted : null,
    keys: keys.map((k) => ({
      xpub: k.xpub,
      original: k.original,
      prefix: k.prefix,
      origin: k.origin,
      depth: k.depth,
      childIndex: k.childIndex,
      chains: k.chains,
      node: k.node,
      chainNodes: [null, null],
    })),
    hasChange,
    checksumOk,
    source,
    descriptor,
  };
  spec.id = descriptor.slice(-8);
  spec.title = multi
    ? `Multisig ${multi.threshold}-von-${multi.keys.length}`
    : 'Single-Sig';
  return spec;
}

// ---------------------------------------------------------------------------
// Adressen ableiten
// ---------------------------------------------------------------------------
function childPub(spec, keyIdx, chain, index) {
  const k = spec.keys[keyIdx];
  if (!k.chainNodes[chain]) {
    let n = k.node;
    for (const step of k.chains[chain]) n = n.deriveChild(step);
    k.chainNodes[chain] = n;
  }
  return k.chainNodes[chain].deriveChild(index).publicKey;
}

function cmpBytes(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// chain: 0 = Empfangen, 1 = Wechselgeld
export function deriveAddress(spec, chain, index) {
  if (chain === 1 && !spec.hasChange) throw new Error('Keine Wechselgeld-Kette');
  if (!spec.isMultisig) {
    const pub = childPub(spec, 0, chain, index);
    switch (spec.script) {
      case 'pkh': return btc.p2pkh(pub).address;
      case 'wpkh': return btc.p2wpkh(pub).address;
      case 'sh-wpkh': return btc.p2sh(btc.p2wpkh(pub)).address;
      case 'tr': return btc.p2tr(pub.slice(1)).address;
    }
  }
  let pubs = spec.keys.map((_, i) => childPub(spec, i, chain, index));
  if (spec.sorted) pubs = [...pubs].sort(cmpBytes);
  const ms = btc.p2ms(spec.threshold, pubs);
  switch (spec.script) {
    case 'wsh': return btc.p2wsh(ms).address;
    case 'sh-wsh': return btc.p2sh(btc.p2wsh(ms)).address;
    case 'sh': return btc.p2sh(ms).address;
  }
  throw new Error('Unbekannter Skripttyp');
}

// Ableitungspfad je Schlüssel, für die Anzeige
export function derivationPaths(spec, chain, index) {
  return spec.keys.map((k) => {
    const tail = [...k.chains[chain], index].map(stepToString).join('/');
    if (k.origin) {
      return {
        fingerprint: k.origin.fingerprint,
        full: 'm' + k.origin.path.map((p) => '/' + stepToString(p)).join('') + '/' + tail,
        known: true,
      };
    }
    return {
      fingerprint: null,
      full: `(xpub, Tiefe ${k.depth})/${tail}`,
      known: false,
    };
  });
}

export function accountPathLabel(spec, keyIdx) {
  const k = spec.keys[keyIdx];
  if (k.origin) return 'm' + k.origin.path.map((p) => '/' + stepToString(p)).join('');
  return null;
}

export { bytesToHex };
