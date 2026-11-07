# Erzeugt das App-Symbol (icon/icon.svg) und rendert icon-180/192/512.png mit Chrome (Playwright).
# Aufruf: python3 icon/make_icon.py
import sys, pathlib
from playwright.sync_api import sync_playwright

BG = '#0a5f69'     # Petrol wie diyPOOL
FG = '#ffffff'
W = 28             # Leiterbahn-Breite
L, T, M, B = 190, 146, 252, 366
RT = (M - T) / 2
RB = (B - M) / 2
XT, XB = 284, 294           # Beginn der Rundungen
TICKS = (212, 272)
TL = 50                     # Länge der Striche oben/unten
PAD, HOLE = 19, 8

def svg(dx=-5, dy=0):
    g = []
    p = (f'M{L} {T} H{XT} A{RT} {RT} 0 0 1 {XT} {M} H{L} '
         f'M{L} {M} H{XB} A{RB} {RB} 0 0 1 {XB} {B} H{L} '
         f'M{L} {T} V{B}')
    g.append(f'<path d="{p}" fill="none" stroke="{FG}" stroke-width="{W}" stroke-linecap="round" stroke-linejoin="round"/>')
    pads = []
    for x in TICKS:
        g.append(f'<path d="M{x} {T} V{T-TL} M{x} {B} V{B+TL}" stroke="{FG}" stroke-width="{W}" stroke-linecap="round"/>')
        pads += [(x, T - TL), (x, B + TL)]
    # Leiterbahn nach links mit Lötpunkt
    g.append(f'<path d="M{L} {M} H{L-62}" stroke="{FG}" stroke-width="{W}" stroke-linecap="round"/>')
    pads.append((L - 62, M))
    # Leiterbahn nach rechts aus dem unteren Bogen
    yr = (M + B) / 2
    g.append(f'<path d="M{XB + RB} {yr} H{XB + RB + 44}" stroke="{FG}" stroke-width="{W}" stroke-linecap="round"/>')
    pads.append((XB + RB + 44, yr))
    for (x, y) in pads:
        g.append(f'<circle cx="{x}" cy="{y}" r="{PAD}" fill="{FG}"/><circle cx="{x}" cy="{y}" r="{HOLE}" fill="{BG}"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
            f'<rect width="512" height="512" fill="{BG}"/>'
            f'<g transform="translate({dx} {dy})">{"".join(g)}</g></svg>')

root = pathlib.Path(__file__).resolve().parent.parent  # PNGs ins Hauptverzeichnis
out = root
s = svg()
(root / 'icon' / 'icon.svg').write_text(s)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for size in (512, 192, 180):
        pg = b.new_page(viewport={'width': size, 'height': size})
        pg.set_content(f'<html><body style="margin:0">{s.replace("<svg ", f"<svg width=\"{size}\" height=\"{size}\" ")}</body></html>')
        pg.screenshot(path=str(out / f'icon-{size}.png'), clip={'x': 0, 'y': 0, 'width': size, 'height': size})
    # Vorschau: Symbol mit iOS-Rundung und Maskable-Sicherheitskreis
    pg = b.new_page(viewport={'width': 760, 'height': 300})
    pg.set_content(f'''<html><body style="margin:0;background:#e8e8e8;display:flex;gap:30px;padding:24px;align-items:center;font:13px system-ui">
      <div style="width:240px;height:240px;border-radius:54px;overflow:hidden">{s.replace("<svg ", "<svg width=240 height=240 ")}</div>
      <div style="width:120px;height:120px;border-radius:27px;overflow:hidden">{s.replace("<svg ", "<svg width=120 height=120 ")}</div>
      <div style="width:60px;height:60px;border-radius:14px;overflow:hidden">{s.replace("<svg ", "<svg width=60 height=60 ")}</div>
      <div style="width:200px;height:200px;border-radius:50%;overflow:hidden;clip-path:circle(40%)">{s.replace("<svg ", "<svg width=200 height=200 ")}</div>
    </body></html>''')
    pg.screenshot(path=str(root / 'icon' / 'vorschau.png'))
    b.close()
print('ok')
