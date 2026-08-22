#!/usr/bin/env python3
"""Regenerate the extension icons.

    python3 dev/make-icons.py

Geometry was measured from the original artwork, which is no longer in the tree:
a rounded square, a green disc, and a play triangle knocked out of the disc in
the square's own colour. The constants below are the record of it. The dark variant's square matches a dark toolbar and
the light variant's matches a light one, so in both themes the square recedes
and the green disc is what you actually see.
"""
import struct, zlib
from pathlib import Path

GREEN = (0x56, 0x9b, 0x5e)

# square colour, disc scale. A square of None means transparent: no tile, and
# the play triangle is punched clean through so the toolbar shows in it. That
# variant is what the toolbar uses, because a dark square on a dark toolbar and
# a white square on a light one both just disappear, leaving the disc either
# way. Transparent gets the same result on every theme, custom ones included,
# and frees the disc to grow now that no tile is framing it.
VARIANTS = {
    'dark':  ((0x16, 0x18, 0x1d), 1.0),
    'light': ((0xff, 0xff, 0xff), 1.0),
    'mark':  (None, 1.55),
}
SIZES = (16, 32, 48, 128)

# All as a fraction of the icon's width.
RADIUS      = 0.214    # rounded-square corner
DISC        = 0.296    # disc radius
TRI_LEFT    = -0.079   # triangle left edge, from centre
TRI_APEX    = 0.119    # triangle apex, from centre
TRI_HALF_H  = 0.116    # triangle half height
TRI_SCALE   = 1.35     # triangle size relative to the source artwork, which read
                       # too timid next to other extensions in the toolbar
SS          = 4        # supersampling factor


def render(size, square, disc_scale=1.0):
    transparent = square is None
    fill = square or (0, 0, 0)
    n = size * SS
    r, rad = n * RADIUS, n * DISC * disc_scale
    t = disc_scale * TRI_SCALE
    left, apex, half = n * TRI_LEFT * t, n * TRI_APEX * t, n * TRI_HALF_H * t
    c = (n - 1) / 2.0
    acc = [[[0, 0, 0, 0] for _ in range(size)] for _ in range(size)]

    for y in range(n):
        for x in range(n):
            # Rounded-square mask.
            if not transparent:
                dx = max(r - x, x - (n - 1 - r), 0.0)
                dy = max(r - y, y - (n - 1 - r), 0.0)
                if dx * dx + dy * dy > r * r:
                    continue

            px = None if transparent else fill
            if (x - c) ** 2 + (y - c) ** 2 <= rad * rad:
                px = GREEN
                tx, ty = x - c, y - c
                # Right-pointing triangle: inside if within the vertical span
                # that shrinks linearly from the left edge to the apex.
                if left <= tx <= apex:
                    span = half * (apex - tx) / (apex - left)
                    if abs(ty) <= span:
                        px = None if transparent else fill

            if px is None:
                continue
            cell = acc[y // SS][x // SS]
            cell[0] += px[0]; cell[1] += px[1]; cell[2] += px[2]; cell[3] += 255

    total = SS * SS
    rows = []
    for row in acc:
        out = bytearray()
        for r_, g_, b_, a_ in row:
            if a_ == 0:
                out += bytes(4)
            else:
                # Un-premultiply against the covered area so edges stay clean.
                out += bytes((round(r_ / (a_ / 255)), round(g_ / (a_ / 255)),
                              round(b_ / (a_ / 255)), round(a_ / total)))
        rows.append(bytes(out))
    return rows


def write_png(path, size, rows):
    raw = b''.join(b'\x00' + r for r in rows)

    def chunk(tag, body):
        c = tag + body
        return struct.pack('>I', len(body)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    Path(path).write_bytes(png)
    return len(png)


def main():
    out = Path(__file__).resolve().parent.parent / 'icons'
    out.mkdir(exist_ok=True)
    for name, (square, base) in VARIANTS.items():
        for size in SIZES:
            # The play mark stops reading below ~32px, so the disc grows a
            # little at toolbar sizes to buy the triangle some pixels.
            bump = 1.16 if size <= 16 else 1.08 if size <= 32 else 1.0
            scale = base * (bump if square else 1.0)
            path = out / f'{size}-{name}.png'
            n = write_png(path, size, render(size, square, scale))
            print(f'{path.relative_to(out.parent)}  {n} bytes')


if __name__ == '__main__':
    main()
