# Bundled fonts

These fonts are embedded by `src/bannerRender.js` (via `@napi-rs/canvas`) to draw
the dynamic per-token banners and the static welcome/fallback banners. They are
redistributed here under their original open-source licenses.

| Font | Weights | Copyright | License |
|---|---|---|---|
| **Space Grotesk** | 500/600/700 | Copyright © 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk) | SIL Open Font License 1.1 (see `OFL.txt`) |
| **JetBrains Mono** | 600/700/800 | Copyright © 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | SIL Open Font License 1.1 (see `OFL.txt`) |
| **Sora** | 400/500/600/700/800 | Copyright © 2020 The Sora Project Authors (https://github.com/SoraFonts/Sora) | SIL Open Font License 1.1 (see `OFL.txt`) |
| Liberation Sans | Bold/Regular | Copyright © Red Hat, Inc. | SIL Open Font License 1.1 (see `OFL.txt`) |
| DejaVu Sans Mono | Bold | DejaVu fonts (Bitstream Vera derivative) | Bitstream Vera / public-domain-style permissive |
| **Noto Sans SC / KR / Thai / Arabic / Devanagari / Hebrew** | Bold | Copyright © 2022 The Noto Project Authors (https://github.com/notofonts) | SIL Open Font License 1.1 (see `OFL.txt`) |

## The Noto faces are the COVERAGE CHAIN, and they are here on purpose

Every other font in this table is Latin-only, so before these landed a token
named **老昊** was drawn as `$□□` — on the listing card, the pump alert, the
trending card and the animated GIF overlay alike. A missing glyph does not
throw: it draws a box and ships.

They are **git-tracked**, and that is the whole point. The first fix for this
shipped as an instruction — `apt-get install -y fonts-noto-cjk fonts-noto-core`
— and the production box never got it, so paid listings went on publishing with
boxes in them for weeks. The server deploys with `git pull`; a tracked file is
the only kind of fix that cannot be skipped.

- `canvasKit.js` registers them as `DexCover *` families and appends them to
  every entry in `F`, so a name resolves **per glyph**: `老昊 Finance` keeps Sora
  for the Latin word and reaches Noto only for the Han.
- **Bold**, because they sit beside the 700/800 display weights.
- **Noto Sans SC has no hangul** (measured), so Korean is its own file — and it
  is registered AFTER the Han face, or a Chinese token would be drawn in Korean
  glyph shapes.
- **Emoji is deliberately NOT bundled.** `NotoColorEmoji` is a ~10MB colour
  bitmap face and `fonts-noto-color-emoji` is reliably installed; the boot
  warning and `npm run fonts:check` name that package when it is missing.

Refreshed the same way as the faces above — static per-weight TTFs from Google
Fonts:

```bash
curl -sS -A "Mozilla/4.0" \
  "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@700&family=Noto+Sans+KR:wght@700&family=Noto+Sans+Thai:wght@700&family=Noto+Sans+Arabic:wght@700&family=Noto+Sans+Devanagari:wght@700&family=Noto+Sans+Hebrew:wght@700"
# then download each ttf URL to Noto<Script>-Bold.ttf
cd bot && npm run fonts:check      # measures what THIS box can draw, and writes a sample PNG
```

**Space Grotesk + JetBrains Mono are the SITE's typefaces** (`src/app/globals.css`
sets `--fd` and `--fm` to them). Anything meant to look like dexvra.io — the
Top-Gainers banners — uses those two: Space Grotesk for display text, JetBrains
Mono for every stat, ticker and wide-tracked micro-label. Artwork that ships a
different typeface reads as a third-party graphic no matter how well drawn it is.

Sora is the older display face used by the per-token listing/trending/rank-up
cards (`bannerRender.js`); Liberation Sans and DejaVu Sans Mono are fallbacks
used only when a preferred face fails to load.

Static per-weight TTFs, fetched from Google Fonts:

```bash
curl -sS -A "Mozilla/5.0" \
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@600;700;800"
# then download each ttf URL to <Family>-<weight>.ttf
```

To refresh the static banner PNGs after editing the renderer:

```bash
node scripts/gen-banners.js
```
