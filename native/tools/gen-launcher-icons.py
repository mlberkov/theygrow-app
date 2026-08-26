#!/usr/bin/env python3
"""UIP-P5 — derive the Android launcher icon set from the brand master.

WHAT THIS IS. A developer-run generator, not a build step and not a runtime
dependency. It is run BY HAND, its fifteen outputs are COMMITTED, and nothing in
either delivery channel executes it: the web channel is buildless (no bundler,
no transpiler — native/package.json says so), the Gradle build reads the
committed PNGs, and `cap sync` never writes res/. Pillow is therefore a
workstation tool, in the same class as the Android SDK, and it enters neither
app/package.json nor native/package.json nor pyproject.toml.

    python3 native/tools/gen-launcher-icons.py            # write the fifteen PNGs
    python3 native/tools/gen-launcher-icons.py --check    # re-derive and compare; exit 1 on drift
    python3 native/tools/gen-launcher-icons.py --check --arm
                                                         # self-proving: perturb one derived
                                                         # pixel, require --check to go RED

REQUIRES Python >= 3.10 and Pillow >= 9.2 (for getbbox(alpha_only=...), see the
comment in main()). Generated on 2026-08-27 with CPython
/usr/bin/python3 and Pillow 10.2.0; the committed bytes in docs/decision-log.md
(UIP-DL-005) are that pair's output. Reproducibility is claimed as PIXEL
identity, which --check verifies; BYTE identity additionally needs the same
Pillow/zlib pair, which is why the pinned digests live in the guard and not here.

THE GEOMETRY, AND WHY IT IS NOT HARD-CODED. An adaptive icon's foreground is a
108dp square of which a launcher shows at most the central 72dp (66.67%) — every
mask, circle or squircle or teardrop, is inscribed there — and Android's
documented safe zone for key content is a 66dp circle (61.11%). The master's own
content (alpha > 8) measures 553x737px inside its 1024 canvas, centred to within
half a pixel on both axes, with a MINIMAL ENCLOSING CIRCLE about the canvas
centre of diameter 0.8803 of the canvas. Mapped 1:1 that circle is 88% against a
66.67% window: the orange swoosh's tip at (771,143) and the purple figure's foot
would both be cut. Scaling to the safe circle gives 0.6111 / 0.8803 = 0.6942,
and inside the circle a parent actually sees the logo still fills 66/72 = 91.7%
of the diameter. The 72dp window fit (0.7574) was rejected: it makes the logo
graze the mask edge on a circular launcher and leaves nothing for parallax.

The fraction is MEASURED from the master at run time rather than written down, so
a corrected master reflows by itself. What keeps a master swap deliberate is
MASTER_SHA256 below: change the file and this aborts until the pin moves with it.

THE LEGACY PAIR IS NOT DEAD WEIGHT. native/android/variables.gradle sets
minSdkVersion = 24, so API 24-25 has no adaptive icon at all and falls back to
these bitmaps. They are drawn UNMASKED, so the shape has to be baked in; they
are sized from the adaptive geometry (SAFE / VISIBLE = 0.9167 of their canvas)
so the two forms cannot drift apart optically.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

REPO_ROOT = Path(__file__).resolve().parents[2]
MASTER = REPO_ROOT / "app" / "icons" / "icon-master-1024.png"
RES = REPO_ROOT / "native" / "android" / "app" / "src" / "main" / "res"

# The brand master this set is derived from (owner decision 2026-08-25, item 9).
MASTER_SHA256 = "46d27cf42368cf5934ae1e998b902ce7bda327b80f9555b2bcbac332a6bd3bcd"

SAFE_CIRCLE = 66 / 108  # 0.6111 — Android's documented adaptive safe zone
VISIBLE_WINDOW = 72 / 108  # 0.6667 — the most any mask shows
FG_DP = 108  # adaptive foreground layer
LEGACY_DP = 48  # legacy launcher bitmap
CORNER_RADIUS = 0.20  # of the legacy canvas, for the square variant
ALPHA_FLOOR = 8  # what counts as "content" when measuring the master
SUPERSAMPLE = 4  # for the legacy MASKS only; the logo is resized directly
RESAMPLE = Image.LANCZOS  # the resampler A0-DL-001 set as this repo's precedent

DENSITIES = {
    "mdpi": 1.0,
    "hdpi": 1.5,
    "xhdpi": 2.0,
    "xxhdpi": 3.0,
    "xxxhdpi": 4.0,
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def content_diameter_fraction(master: Image.Image) -> float:
    """Diameter of the minimal circle about the canvas centre enclosing all content."""
    alpha = master.getchannel("A")
    width, height = master.size
    cx, cy = (width - 1) / 2.0, (height - 1) / 2.0
    px = alpha.load()
    worst = 0.0
    for y in range(height):
        for x in range(width):
            if px[x, y] > ALPHA_FLOOR:
                d = (x - cx) ** 2 + (y - cy) ** 2
                if d > worst:
                    worst = d
    return 2.0 * (worst**0.5) / width


def logo_at(master: Image.Image, target_diameter_px: float, frac: float) -> Image.Image:
    """The master resized so its content circle measures target_diameter_px."""
    size = max(1, round(target_diameter_px / frac))
    return master.resize((size, size), RESAMPLE)


def paste_centred(canvas: Image.Image, layer: Image.Image) -> Image.Image:
    out = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    out.paste(layer, ((canvas.size[0] - layer.size[0]) // 2, (canvas.size[1] - layer.size[1]) // 2))
    return Image.alpha_composite(canvas, out)


def plate(size: int, shape: str) -> Image.Image:
    """An opaque white plate, antialiased by drawing the mask supersampled."""
    big = size * SUPERSAMPLE
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    if shape == "circle":
        draw.ellipse((0, 0, big - 1, big - 1), fill=255)
    else:
        draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=CORNER_RADIUS * big, fill=255)
    mask = mask.resize((size, size), RESAMPLE)
    out = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    out.putalpha(mask)
    return out


def derive(master: Image.Image, frac: float) -> dict[Path, Image.Image]:
    """The whole set, keyed by the path each image belongs at."""
    out: dict[Path, Image.Image] = {}
    for bucket, density in DENSITIES.items():
        mip = RES / f"mipmap-{bucket}"

        # Adaptive foreground: transparent, no plate. The launcher composites it
        # over @color/ic_launcher_background (#FFFFFF) and masks the result.
        fg = round(FG_DP * density)
        out[mip / "ic_launcher_foreground.png"] = paste_centred(
            Image.new("RGBA", (fg, fg), (0, 0, 0, 0)),
            logo_at(master, fg * SAFE_CIRCLE, frac),
        )

        # Legacy pair: shaped and opaque, sized so API 24-25 sees optically what
        # API 26+ sees after masking.
        legacy = round(LEGACY_DP * density)
        logo = logo_at(master, legacy * (SAFE_CIRCLE / VISIBLE_WINDOW), frac)
        out[mip / "ic_launcher.png"] = paste_centred(plate(legacy, "rounded"), logo)
        out[mip / "ic_launcher_round.png"] = paste_centred(plate(legacy, "circle"), logo)
    return out


def load_master() -> tuple[Image.Image, float]:
    if not MASTER.exists():
        sys.exit(f"gen-launcher-icons: the brand master is missing: {MASTER}")
    actual = sha256(MASTER)
    if actual != MASTER_SHA256:
        sys.exit(
            "gen-launcher-icons: the brand master changed — regenerate deliberately "
            f"and update MASTER_SHA256.\n  expected {MASTER_SHA256}\n  found    {actual}"
        )
    master = Image.open(MASTER).convert("RGBA")
    frac = content_diameter_fraction(master)
    return master, frac


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--check",
        action="store_true",
        help="re-derive and compare against the tree; exit 1 on drift",
    )
    ap.add_argument(
        "--arm",
        action="store_true",
        help="with --check: perturb one derived pixel and require a RED",
    )
    args = ap.parse_args()

    if args.arm and not args.check:
        sys.exit("gen-launcher-icons: --arm is only meaningful with --check")

    master, frac = load_master()
    print(
        f"gen-launcher-icons: master {MASTER.relative_to(REPO_ROOT)} "
        f"{master.size[0]}x{master.size[1]} sha256 {MASTER_SHA256[:16]}…"
    )
    print(
        f"gen-launcher-icons: measured content diameter {frac:.4f} of canvas; "
        f"safe circle {SAFE_CIRCLE:.4f}; scale {SAFE_CIRCLE / frac:.4f}"
    )

    images = derive(master, frac)

    if not args.check:
        for path, img in sorted(images.items()):
            path.parent.mkdir(parents=True, exist_ok=True)
            img.save(path, format="PNG", optimize=True)
            print(f"  wrote {path.relative_to(REPO_ROOT)}  {img.size[0]}x{img.size[1]}")
        print(f"gen-launcher-icons: wrote {len(images)} files")
        return 0

    if args.arm:
        # Self-proving: a check that silently compares nothing must not pass.
        victim = sorted(images)[0]
        armed = images[victim].copy()
        r, g, b, a = armed.getpixel((0, 0))
        armed.putpixel((0, 0), ((r + 128) % 256, g, b, a))
        images[victim] = armed
        print(
            f"gen-launcher-icons: ARMED — perturbed one pixel of "
            f"{victim.relative_to(REPO_ROOT)}; this run MUST go red"
        )

    drift: list[str] = []
    for path, expected in sorted(images.items()):
        where = path.relative_to(REPO_ROOT)
        if not path.exists():
            drift.append(f"{where}: missing from the tree")
            continue
        found = Image.open(path).convert("RGBA")
        if found.size != expected.size:
            drift.append(
                f"{where}: {found.size[0]}x{found.size[1]} on disk, "
                f"{expected.size[0]}x{expected.size[1]} derived"
            )
            continue
        # alpha_only=False is LOAD-BEARING, and the arm is what found it. Pillow
        # >= 9.2 defaults Image.getbbox() to alpha_only=True on an image that has
        # an alpha band, so a difference image whose alpha is uniformly zero --
        # which is exactly what two images with IDENTICAL alpha produce -- reports
        # no bounding box however far apart their colours are. Left at the default
        # this check would have caught a moved shape and missed a recoloured one.
        box = ImageChops.difference(found, expected).getbbox(alpha_only=False)
        if box is not None:
            drift.append(f"{where}: pixels differ from the derivation, first at {box}")
        else:
            print(f"  ok {where}  {found.size[0]}x{found.size[1]}  sha256 {sha256(path)[:16]}…")

    if drift:
        print(
            "\ngen-launcher-icons: DRIFT — the committed set is not what the master derives:",
            file=sys.stderr,
        )
        for line in drift:
            print(f"  {line}", file=sys.stderr)
        if args.arm:
            print(
                "\ngen-launcher-icons: the arm fired as designed — the check can fail.",
                file=sys.stderr,
            )
        return 1

    if args.arm:
        print(
            "\ngen-launcher-icons: ARM DID NOT FIRE — the check passed against a "
            "deliberately corrupted derivation and is comparing nothing.",
            file=sys.stderr,
        )
        return 1

    print(f"gen-launcher-icons: {len(images)} files match the derivation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
