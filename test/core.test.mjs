import fs from 'node:fs';
import { parseInput, deriveAddress, descriptorChecksum, derivationPaths, InputError } from '../src/core.js';
const v = JSON.parse(fs.readFileSync(new URL('./vectors.json', import.meta.url)));
let fail = 0, ok = 0;
for (const c of v.cases) {
  try {
    const spec = parseInput(c.input, c.override || undefined);
    if (spec.needsScriptChoice) throw new Error('needsScriptChoice');
    if (spec.script !== c.script) throw new Error(`script ${spec.script} != ${c.script}`);
    const r = c.receive.map((_, i) => deriveAddress(spec, 0, i));
    const ch = c.change.map((_, i) => deriveAddress(spec, 1, i));
    if (JSON.stringify(r) !== JSON.stringify(c.receive)) throw new Error('receive mismatch ' + r[0] + ' vs ' + c.receive[0]);
    if (JSON.stringify(ch) !== JSON.stringify(c.change)) throw new Error('change mismatch');
    // Rundlauf: ausgegebener Descriptor muss wieder dieselben Adressen ergeben
    const spec2 = parseInput(spec.descriptor);
    if (deriveAddress(spec2, 0, 3) !== c.receive[3] || deriveAddress(spec2, 1, 2) !== c.change[2]) throw new Error('roundtrip mismatch');
    ok++;
  } catch (e) { fail++; console.log('FAIL', c.name, e.message); }
}
for (const x of v.checksums) {
  if (descriptorChecksum(x.body) !== x.checksum) { fail++; console.log('FAIL checksum', x.body.slice(0, 30)); } else ok++;
}
// Fehlerfälle
const bad = [
  ['abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', /Seed-Phrase/],
  ['xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi', /PRIVATER/],
  ['tpubD6NzVbkrYhZ4XgiXtGrdW5XDAPFCL9h7we1vwNCpn8tGbBcgfVYjXyhWo4E1xkh56hjod1RhGjxbaTLV3X4FyWuejifB9jusQ46QzG87VKp', /Testnet/],
];
for (const [inp, re] of bad) {
  try { parseInput(inp); fail++; console.log('FAIL no error for', inp.slice(0, 20)); }
  catch (e) { if (re.test(e.message)) ok++; else { fail++; console.log('FAIL wrong error', e.message); } }
}
// Falsche Checksumme
const good = v.cases.find((c) => c.input.includes('#')).input;
try { parseInput(good.slice(0, -1) + (good.endsWith('q') ? 'p' : 'q')); fail++; console.log('FAIL bad checksum accepted'); }
catch (e) { /Prüfsumme/.test(e.message) ? ok++ : (fail++, console.log('FAIL', e.message)); }
// Pfadanzeige
const ms = parseInput(v.cases.find((c) => c.name === 'wsh sortedmulti').input);
console.log('Pfad-Beispiel:', derivationPaths(ms, 0, 7).map((p) => p.fingerprint + ' ' + p.full).join(' | '));
const bare = parseInput(v.cases.find((c) => c.name.startsWith('bare zpub')).input);
console.log('Pfad ohne Herkunft:', derivationPaths(bare, 1, 3)[0].full, '| Descriptor:', bare.descriptor.slice(0, 20) + '…' + bare.descriptor.slice(-25));
const xp = parseInput(v.cases.find((c) => c.name.startsWith('bare xpub pkh')).input);
console.log('xpub ohne Typ:', xp.needsScriptChoice === true);
console.log(`${ok} ok, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
