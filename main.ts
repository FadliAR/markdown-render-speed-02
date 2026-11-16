// Driver for the markdown-render-speed-02 entry.
//
// The harness places this repository at /bot, the test cases at
// /input/cases.json and expects the rendered HTML at
// /output/html.json. Input and output directories can be overridden
// through the MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment
// variables, which is handy for local practice runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Case[];

const html: string[] = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
