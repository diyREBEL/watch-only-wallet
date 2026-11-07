# Erzeugt Referenz-Testvektoren mit embit (unabhängige Implementierung)
import json
from embit import bip39, bip32
from embit.networks import NETWORKS
from embit.descriptor import Descriptor
from embit.descriptor.checksum import add_checksum

M = NETWORKS['main']
mn1 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
mn2 = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"
mn3 = "legal winner thank year wave sausage worth useful legal winner thank yellow"
roots = [bip32.HDKey.from_seed(bip39.mnemonic_to_seed(m)) for m in (mn1, mn2, mn3)]

def acct(root, path, ver='xpub'):
    return root.derive(path).to_public().to_base58(version=M[ver])

def addrs(desc_str, n=5, nchange=3):
    d = Descriptor.from_string(desc_str)
    r = [d.derive(i, branch_index=0).address(M) for i in range(n)]
    c = [d.derive(i, branch_index=1).address(M) for i in range(nchange)]
    return r, c

cases = []
r0 = roots[0]; fp0 = r0.my_fingerprint.hex()
single = [('pkh', "m/44h/0h/0h", 'pkh({k})'), ('sh-wpkh', "m/49h/0h/0h", 'sh(wpkh({k}))'),
          ('wpkh', "m/84h/0h/0h", 'wpkh({k})'), ('tr', "m/86h/0h/0h", 'tr({k})')]
for script, path, tmpl in single:
    xp = acct(r0, path)
    key = f"[{fp0}{path[1:]}]{xp}/<0;1>/*"
    desc = tmpl.format(k=key)
    r, c = addrs(desc)
    cases.append({'name': f'desc {script}', 'input': add_checksum(desc), 'script': script, 'receive': r, 'change': c})
    # Variante ohne Herkunft und mit /0/*
    desc2 = tmpl.format(k=f"{xp}/0/*")
    r2, _ = addrs(tmpl.format(k=f"{xp}/<0;1>/*"))
    cases.append({'name': f'desc {script} /0/*', 'input': desc2, 'script': script, 'receive': r2, 'change': c})
    # Nackter Schlüssel
    ver = {'pkh': 'xpub', 'sh-wpkh': 'ypub', 'wpkh': 'zpub', 'tr': 'xpub'}[script]
    bare = acct(r0, path, ver)
    cases.append({'name': f'bare {ver} {script}', 'input': bare, 'override': script if ver == 'xpub' else None,
                  'script': script, 'receive': r, 'change': c})

# Multisig 2-von-3
for script, path, tmpl, ver in [('wsh', "m/48h/0h/0h/2h", 'wsh({m})', 'Zpub'),
                                 ('sh-wsh', "m/48h/0h/0h/1h", 'sh(wsh({m}))', 'Ypub'),
                                 ('sh', "m/45h", 'sh({m})', 'xpub')]:
    for fn in ('sortedmulti', 'multi'):
        keys = [f"[{r.my_fingerprint.hex()}{path[1:]}]{acct(r, path)}/<0;1>/*" for r in roots]
        desc = tmpl.format(m=f"{fn}(2,{','.join(keys)})")
        r, c = addrs(desc)
        cases.append({'name': f'{script} {fn}', 'input': add_checksum(desc), 'script': script, 'receive': r, 'change': c})
    # mit SLIP-132-Schlüsseln (Coldcard-Stil) und ohne Suffix
    keys = [f"[{r.my_fingerprint.hex()}{path[1:]}]{acct(r, path, ver)}" for r in roots]
    desc_slip = tmpl.format(m=f"sortedmulti(2,{','.join(keys)})")
    keys_x = [f"[{r.my_fingerprint.hex()}{path[1:]}]{acct(r, path)}/<0;1>/*" for r in roots]
    r, c = addrs(tmpl.format(m=f"sortedmulti(2,{','.join(keys_x)})"))
    cases.append({'name': f'{script} sortedmulti {ver} ohne Suffix', 'input': desc_slip, 'script': script, 'receive': r, 'change': c})

# Checksummen-Vektoren
chk = []
for c in cases:
    if '#' in c['input']:
        body, cs = c['input'].split('#')
        chk.append({'body': body, 'checksum': cs})

json.dump({'cases': cases, 'checksums': chk}, open('test/vectors.json', 'w'), indent=1)
print(len(cases), 'Fälle;', 'BIP86 #0:', [c for c in cases if c['name'] == 'desc tr'][0]['receive'][0],
      '; BIP84 #0:', [c for c in cases if c['name'] == 'desc wpkh'][0]['receive'][0])
