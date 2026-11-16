// Entry point for the markdown-render-speed-02 submission.
//
// The grader drops this repository at /bot and the case set at
// /input/cases.json; the program renders every case with parse() from
// parse.js and writes the HTML strings, in order, to /output/html.json.
// When run outside the grader, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// may point at stand-in folders (the kit's practice set, say).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as Case[];
const out: string[] = [];
for (const c of cases) {
  out.push(parse(c.markdown));
}
writeFileSync(join(outDir, 'html.json'), JSON.stringify(out));
