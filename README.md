# Watch-only Wallet

Web-App fürs Handy und den Computer. Sie zeigt Kontostand, Transaktionen,
UTXOs und neue Empfangsadressen einer Bitcoin-Wallet, ohne private Schlüssel.
Senden ist darum unmöglich.

Die App rechnet die Adressen selbst aus dem öffentlichen Schlüssel aus und
zeigt zu jeder Adresse den Ableitungspfad, aufgeteilt in seine Stufen.

## Unterstützte Eingaben

- **Single-Sig:** xpub, ypub oder zpub. Bei einem xpub erkennt die App den
  Adresstyp selbst (Native SegWit, Taproot, Nested SegWit, Legacy).
- **Descriptor:** `pkh(…)`, `sh(wpkh(…))`, `wpkh(…)`, `tr(…)`
- **Multisig-Descriptor:** `wsh(sortedmulti(…))`, `sh(wsh(sortedmulti(…)))`,
  `sh(sortedmulti(…))`, jeweils auch mit `multi`. Pfade mit `/<0;1>/*`,
  `/0/*` oder ohne Angabe. Ypub und Zpub werden ebenfalls akzeptiert.

Nur Mainnet. Seed-Wörter und private Schlüssel (xprv) lehnt die App ab.

## Bestandteile

| Datei | Inhalt |
|---|---|
| `index.html` | die ganze App in einer Datei, alle Bibliotheken eingebaut (erzeugt mit `npm run build`) |
| `manifest.webmanifest` | Name und Symbol für den Home-Bildschirm |
| `sw.js` | Service Worker: App startet auch ohne Netz, zeigt dann Empfangsadressen |
| `icon-180.png`, `icon-192.png`, `icon-512.png` | App-Symbol: Bitcoin-Zeichen als Platine |
| `icon/` | Symbol als SVG und das Skript, das die PNGs erzeugt |
| `src/` | Quellcode: `core.js` (Schlüssel, Descriptors, Adressen), `scan.js` (Abfrage), `ui.js` (Oberfläche), `template.html` (Aussehen) |
| `test/` | Tests mit Referenzwerten aus der Python-Bibliothek embit |

## Einrichten

1. GitHub Pages einschalten: Repository → Settings → Pages →
   «Deploy from a branch», Branch `main`, Ordner `/ (root)`.
2. Nach ein bis zwei Minuten ist die App unter
   `https://diyrebel.github.io/watch-only-wallet/` erreichbar.
3. iPhone: in Safari öffnen → Teilen → «Zum Home-Bildschirm».
   Android: im Chrome-Menü «Zum Startbildschirm hinzufügen» oder
   «App installieren».
4. Die App vom Home-Bildschirm aus starten und die Wallet hinzufügen.
   Die App auf dem Home-Bildschirm hat ihren eigenen Speicher, getrennt vom
   Browser.

Die Datei `index.html` funktioniert auch ohne GitHub: herunterladen und im
Browser öffnen.

## Daten und Privatsphäre

- xpubs und Descriptors bleiben im Speicher des Browsers auf dem Gerät.
  Sie gehen nicht an GitHub.
- Für Kontostand und Transaktionen schickt die App die abgeleiteten Adressen
  an einen Esplora-Server, standardmässig `https://mempool.space/api`.
  Dieser sieht, welche Adressen zusammengehören, und die IP-Adresse.
- Mehr Privatsphäre bringt ein eigener mempool-Server. Weil die App über
  https läuft, muss er per https erreichbar sein; http-Adressen blockiert
  der Browser.
- Wer dieses Repository ändern kann, bestimmt den Code der App. Darum
  Schreibrechte nicht weitergeben.

## Entwicklung

```sh
npm install
npm run build   # src/ → index.html
npm test        # Adressen, Descriptors, Prüfsummen, Abfrage-Logik
```

Die Referenzwerte in `test/vectors.json` erzeugt `python3 test/gen_vectors.py`
(braucht `pip install embit`). Das Symbol erzeugt `python3 icon/make_icon.py`
(braucht Playwright und Chrome).

Verwendete Bibliotheken: `@scure/bip32`, `@scure/btc-signer`, `@scure/base`,
`@noble/hashes` (Paul Miller, MIT) und `qrcode-generator` (Kazuhiko Arase, MIT).
