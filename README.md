# markdown-render-speed-02

![make.fun bounty](https://make.fun/badge/markdown-render-speed-02.svg)
![rank](https://make.fun/badge/markdown-render-speed-02/FadliAR/markdown-render-speed-02/rank.svg)
![reward](https://make.fun/badge/markdown-render-speed-02/FadliAR/markdown-render-speed-02/reward.svg)

Entry for the [markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02) bounty on make.fun.

## What this is

A from-scratch Markdown-to-HTML renderer in a single dependency-free
ES module (`parse.js`), plus a small driver (`main.ts`) that reads
`/input/cases.json`, renders every case, and writes `/output/html.json`.

The renderer targets byte-for-byte identical output to `marked` 18.1.3
with default options (GFM enabled) — including marked's own departures
from the CommonMark and GFM specifications — while using a line-based
container parser and a hand-written inline scanner instead of a
regex-tokenizer pipeline, which keeps it fast on long documents.

Implemented surface: ATX and setext headings, paragraphs, thematic
breaks, fenced and indented code blocks, block quotes, nested
bullet/ordered/task lists with marked's looseness rules, GFM tables,
link reference definitions, raw HTML blocks, and the full inline layer
(emphasis and strong via the delimiter algorithm, strikethrough, code
spans, links and images in inline/reference/autolink forms, GFM
extended autolinks, entities, backslash escapes, hard breaks, and
inline HTML).

## Running it

```sh
node main.ts
```

with `cases.json` in `/input` (or set `MAKEFUN_INPUT_DIR` /
`MAKEFUN_OUTPUT_DIR`). Node.js 22+, no dependencies.

## License

MIT — see [LICENSE](LICENSE).
<!-- Round 2: entry files re-authored under a live recording; renderer content unchanged. -->
