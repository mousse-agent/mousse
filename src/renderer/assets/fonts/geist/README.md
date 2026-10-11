# Geist fonts

I copied these unmodified variable WOFF2 files from Vercel's official
[Geist v1.7.2 release](https://github.com/vercel/geist-font/releases/tag/v1.7.2).
Both families support weights 100–900, with normal and italic faces. The
stylesheet references local assets so the packaged renderer works offline.

Upstream paths:

- `fonts/Geist/webfonts/Geist[wght].woff2`
- `fonts/Geist/webfonts/Geist-Italic[wght].woff2`
- `fonts/GeistMono/webfonts/GeistMono[wght].woff2`
- `fonts/GeistMono/webfonts/GeistMono-Italic[wght].woff2`

I retained upstream `OFL.txt` and `LICENSE.txt` beside the fonts. Both contain
the SIL Open Font License 1.1 and their original copyright notices.
Copies in `src/renderer/public/licenses/geist/` are also included unchanged in
the built renderer distribution by Vite's public-directory copy step.
