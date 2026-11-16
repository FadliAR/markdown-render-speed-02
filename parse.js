// parse.js — a dependency-free Markdown renderer whose output matches,
// byte for byte, what marked 18.1.3 produces with its default options
// (GFM on, breaks off, pedantic off). Written from the CommonMark and GFM
// spec examples plus observed behaviour of the reference renderer.
//
// Shape: a block pass turns the source into a token list (collecting link
// reference definitions on the way), then a render pass walks the tokens
// and runs a regex-driven inline pass over text payloads.

// ---------------------------------------------------------------- utilities

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Escape for element content: an ampersand that already opens an entity is
// left alone, the rest of the markup characters are always escaped.
function escapeText(s) {
  return s.replace(/[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) => ESCAPES[c]);
}

// Escape for code and attribute values: every special char is escaped,
// entities included.
function escapeRaw(s) {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// Decode the entity references the reference renderer decodes while it
// reads a link destination or title: numeric references it accepts, plus
// the small named set it knows inline (the rest it leaves as written).
function decodeEntities(s) {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(\w+));/g, (whole, dec, hex, name) => {
    if (dec !== undefined) return String.fromCodePoint(Number(dec) % 0x110000);
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16) % 0x110000);
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, name) ? ENTITY_MAP[name] : whole;
  });
}

// Decode numeric character references in text (the reference renderer
// resolves them; named references it leaves as written). Zero,
// surrogates and out-of-range values become the replacement character.
function decodeNumericRefs(s) {
  if (!s.includes('&#')) return s;
  return s.replace(/&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});/g, (whole, dec, hex) => {
    const cp = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    if (!cp) return '\uFFFD';
    if (cp > 0x10ffff) return '\uFFFD';
    if (cp >= 0xd800 && cp <= 0xdfff) return '\uFFFD';
    return String.fromCodePoint(cp);
  });
}

// The reference cleans a destination before putting it in an attribute:
// percent-encode what encodeURI encodes, but keep escapes already there.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// Undo backslash escapes of ASCII punctuation (for destinations, titles
// and info strings).
function unescapePunct(s) {
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
}

// Count leading columns of a line, a tab counting to the next multiple
// of four.
function indentOf(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') col++;
    else if (line[i] === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// The content of a line from column `col` onward (marker characters
// count by their width; a straddling tab leaves its remaining width as
// spaces).
function sliceFromCol(line, col) {
  let c = 0;
  let i = 0;
  while (i < line.length && c < col) {
    const ch = line[i];
    if (ch === '\t') {
      const w = 4 - (c % 4);
      if (c + w > col) return ' '.repeat(c + w - col) + line.slice(i + 1);
      c += w;
    } else c++;
    i++;
  }
  return line.slice(i);
}

// Remove `cols` columns from the head of a line. Widths are tracked in
// original line columns (a tab runs to the next multiple of four); a tab
// that straddles the cut leaves its remaining width as spaces, and any
// whitespace still leading the result is expanded by the same columns,
// so the rest of the line keeps its original alignment. Content past
// the first non-whitespace character is returned untouched.
function dedent(line, cols) {
  let oc = 0;
  let skipped = 0;
  let i = 0;
  let out = '';
  while (i < line.length && skipped < cols) {
    const ch = line[i];
    const w = ch === '\t' ? 4 - (oc % 4) : 1;
    if (skipped + w > cols) {
      out += ' '.repeat(skipped + w - cols);
      oc += w;
      i++;
      skipped = cols;
      break;
    }
    skipped += w;
    oc += w;
    i++;
  }
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { out += ' '; oc++; i++; }
    else { const w = 4 - (oc % 4); out += ' '.repeat(w); oc += w; i++; }
  }
  return out + line.slice(i);
}

// ------------------------------------------------------------ block rules
// The tokenizer tries rules against the source head in a fixed order.

const RE_BLANK = /^(?:[ \t]*\n)+/;
const RE_FENCES = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+([^\n]*?))?[ \t]*(?:\n|$)/;
const RE_HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*(?:\n+|$)/;

// A link reference definition: label, destination (angle or bare, the
// bare form at least one character), and an optional title that must
// be separated from the destination by whitespace and may not span a
// blank line.
const RE_DEF = /^ {0,3}\[((?:\\.|[^\]\\])*)\]:[ \t]*(?:\n[ \t]*)?(?:<((?:\\.|[^>\\])*)>|(?![<])((?:\\.|[^\s\\]|\((?:\\.|[^()\\])*\))+))(?:(?:[ \t]+(?:\n[ \t]*)?|[ \t]*\n[ \t]*)("(?:\\.|[^"\\\n]|\n(?![ \t]*\n))*"|'(?:\\.|[^'\\\n]|\n(?![ \t]*\n))*'|\((?:\\.|[^()\\\n]|\n(?![ \t]*\n))*\)))?[ \t]*(?:\n+|$)/;

// HTML block openers, by CommonMark type. Types 1-6 may interrupt a
// paragraph; type 7 (a complete tag) may not.
const HTML_BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const RE_HTML_T6 = new RegExp('^ {0,3}</?(?:' + HTML_BLOCK_TAGS + ')(?:[ \\t\\n>]|[ \\t]*/>|$)');
const RE_HTML_T7 = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)/;
// A type 7 block needs the tag alone on its line (trailing blanks ok).
const RE_HTML_T7_LINE = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;
const RE_HTML_T1 = /^ {0,3}<(script|pre|style|textarea)(?:[\s>]|$)/i;
const RE_HTML_T2 = /^ {0,3}<!--/;
const RE_HTML_T3 = /^ {0,3}<\?/;
const RE_HTML_T4 = /^ {0,3}<![A-Z]/;
const RE_HTML_T5 = /^ {0,3}<!\[CDATA\[/;

// Find where an HTML block's text ends (its terminating line included).
function htmlBlockEnd(src, type, tag) {
  if (type === 1) {
    const close = new RegExp('</' + tag + '\\s*>', 'i');
    const m = close.exec(src);
    if (m) {
      const nl = src.indexOf('\n', m.index + m[0].length);
      return nl === -1 ? src.length : nl + 1;
    }
    return src.length;
  }
  if (type === 2) {
    const i = src.indexOf('-->');
    if (i === -1) return src.length;
    const nl = src.indexOf('\n', i + 3);
    return nl === -1 ? src.length : nl + 1;
  }
  if (type === 3) {
    const i = src.indexOf('?>');
    if (i === -1) return src.length;
    const nl = src.indexOf('\n', i + 2);
    return nl === -1 ? src.length : nl + 1;
  }
  if (type === 4 || type === 5) {
    const end = type === 4 ? '>' : ']]>';
    const i = src.indexOf(end);
    if (i === -1) return src.length;
    const nl = src.indexOf('\n', i + end.length);
    return nl === -1 ? src.length : nl + 1;
  }
  // Types 6 and 7 run until (and including) the line before a blank line.
  const m = /\n[ \t]*\n/.exec(src);
  if (!m) return src.length;
  return m.index + 1;
}

// Try to read an HTML block at the head of src. Returns {text, len}
// where len counts the source characters consumed, following blank
// lines included, or null when src does not open an HTML block here.
// The reference match swallows following empty lines (bare newlines
// for types 1-5, blank lines of any whitespace for types 6-7), and
// the emitted text is that match with trailing blank lines dropped
// whenever more than just the last content line's own ending
// remains.
function trimHtmlRaw(raw) {
  const lines = raw.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return raw;
  return lines.slice(0, t + 1).join('\n');
}

function matchHtmlBlock(src, inParagraph) {
  let type = 0;
  let tag = '';
  let m;
  if ((m = RE_HTML_T1.exec(src))) { type = 1; tag = m[1].toLowerCase(); }
  else if (RE_HTML_T2.test(src)) type = 2;
  else if (RE_HTML_T3.test(src)) type = 3;
  else if (RE_HTML_T4.test(src)) type = 4;
  else if (RE_HTML_T5.test(src)) type = 5;
  else if (RE_HTML_T6.test(src)) type = 6;
  else if (!inParagraph && RE_HTML_T7_LINE.test(firstLineOf(src))) type = 7;
  if (!type) return null;
  const end = htmlBlockEnd(src, type, tag);
  let matchEnd = end;
  if (type === 6 || type === 7) {
    if (end < src.length) {
      const blanks = /^(?:[ \t]*\n)+/.exec(src.slice(end));
      if (blanks) matchEnd = end + blanks[0].length;
    }
  } else {
    while (src[matchEnd] === '\n') matchEnd++;
  }
  return { text: trimHtmlRaw(src.slice(0, matchEnd)), len: matchEnd };
}

// ---------------------------------------------------------- block parsing
// A token: {type, ...}. Text payloads stay raw; the render pass runs the
// inline pass over them. Link reference definitions land in state.links,
// keyed by their label folded to lower case.

// Remove up to `cols` columns of leading whitespace only (a straddling
// tab leaves spaces). Used for fenced code lines, whose content may
// itself start with a non-space character.
// Like dedent, but only leading whitespace is removed (up to cols
// columns of it); any leading whitespace beyond the cut is expanded
// by original columns. For lines that may be under-indented.
function dedentWs(line, cols) {
  let oc = 0;
  let skipped = 0;
  let i = 0;
  let out = '';
  while (i < line.length && skipped < cols && (line[i] === ' ' || line[i] === '\t')) {
    const w = line[i] === '\t' ? 4 - (oc % 4) : 1;
    if (skipped + w > cols) {
      out += ' '.repeat(skipped + w - cols);
      oc += w;
      i++;
      skipped = cols;
      break;
    }
    skipped += w;
    oc += w;
    i++;
  }
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { out += ' '; oc++; i++; }
    else { const w = 4 - (oc % 4); out += ' '.repeat(w); oc += w; i++; }
  }
  return out + line.slice(i);
}

function stripIndent(line, cols) {
  let c = 0;
  let i = 0;
  while (i < line.length && c < cols && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { c++; i++; }
    else {
      const w = 4 - (c % 4);
      if (c + w > cols) return ' '.repeat(c + w - cols) + line.slice(i + 1);
      c += w; i++;
    }
  }
  return line.slice(i);
}

// Split a table row into cells: pipes escaped as \| or sitting inside a
// code span do not split. One leading and one trailing pipe are framing.
function splitRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  let seenPipe = false;
  // Only backslash escapes are special here: an escaped pipe is cell
  // content (and renders as a plain pipe); code spans do NOT protect
  // pipes from splitting.
  for (i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '\\') { cur += ch + (line[i + 1] || ''); i++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; seenPipe = true; continue; }
    cur += ch;
  }
  cells.push(cur);
  if (seenPipe) {
    if (cells.length && cells[0].trim() === '') cells.shift();
    if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  }
  return cells.map((c) => c.trim());
}

const RE_DELIM_CELL = /^:?-+:?$/;

// If src opens with a GFM table, return {header, align, rows, len}.
function matchTable(src) {
  const nl1 = src.indexOf('\n');
  if (nl1 === -1) return null;
  const headLine = src.slice(0, nl1);
  if (!headLine.includes('|')) return null;
  const afterHead = src.slice(nl1 + 1);
  const nl2 = afterHead.indexOf('\n');
  const delimLine = nl2 === -1 ? afterHead : afterHead.slice(0, nl2);
  if (!delimLine.includes('-')) return null;
  const header = splitRow(headLine.replace(/^ {0,3}/, ''));
  const delims = splitRow(delimLine.replace(/^ {0,3}/, ''));
  if (header.length === 0 || delims.length !== header.length) return null;
  const align = [];
  for (const d of delims) {
    if (!RE_DELIM_CELL.test(d)) return null;
    align.push(d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : null);
  }
  let len = nl1 + 1 + (nl2 === -1 ? afterHead.length : nl2 + 1);
  const rows = [];
  let rest = src.slice(len);
  while (rest.length) {
    const nl = rest.indexOf('\n');
    const line = nl === -1 ? rest : rest.slice(0, nl);
    // A spaces-only line ends the table; a line containing a tab is
    // still a (mostly empty) row in the reference implementation.
    if (/^ *$/.test(line)) break;
    if (interruptsParagraph(line) || startsList(line, false)) break;
    const cells = splitRow(line.replace(/^ {0,3}/, ''));
    while (cells.length < header.length) cells.push('');
    rows.push(cells.slice(0, header.length));
    const adv = nl === -1 ? rest.length : nl + 1;
    len += adv;
    rest = rest.slice(adv);
  }
  return { header, align, rows, len };
}

// A definition's label must contain a non-whitespace character and
// only balanced brackets.
function labelUsable(label) {
  if (!/\S/.test(label)) return false;
  let depth = 0;
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === '\\') i++;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

// Does this line start a block that may interrupt a paragraph?
function interruptsParagraph(line) {
  if (RE_FENCES.test(line)) {
    const m = RE_FENCES.exec(line);
    if (m[1][0] === '`' && m[2].includes('`')) return false;
    return true;
  }
  if (RE_ATX.test(line)) return true;
  if (RE_HR.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (matchHtmlBlock(line, true)) return true;
  return false;
}

// Read a paragraph (or a setext heading) starting at src. Returns
// {token, len}. Setext: when a later line of the block is an underline,
// the whole block becomes the heading text. Lines whose start offset
// is in `prot` are lazy continuations: always plain text here.
function readParagraph(src, state, prot, base) {
  let len = 0;
  let text = '';
  let rest = src;
  let first = true;
  for (;;) {
    const nl = rest.indexOf('\n');
    const line = nl === -1 ? rest : rest.slice(0, nl);
    const adv = nl === -1 ? rest.length : nl + 1;
    if (!first) {
      // A whitespace-only line ends the paragraph, except a non-empty
      // one sitting at the very end of the input with no newline.
      if (/^[ \t]*$/.test(line) && (nl !== -1 || line.length === 0)) break;
      if (!(prot && prot.has(base + len))) {
        const se = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
        if (se) {
          // setext underline: the text so far is the heading; its outer
          // whitespace is trimmed (a paragraph would keep it).
          const depth = se[1][0] === '=' ? 1 : 2;
          const htext = text.replace(/\n$/, '').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          return { token: { type: 'heading', depth, text: htext }, len: len + adv };
        }
        if (interruptsParagraph(line)) break;
        if (startsList(line, true, (state.inItem || 0) > 0)) break;
        if (matchTable(rest)) break;
      }
    }
    text += line + '\n';
    len += adv;
    rest = rest.slice(adv);
    first = false;
    if (nl === -1) break;
  }
  return { token: { type: 'paragraph', text: text.replace(/\n$/, '') }, len };
}

// The list-item variant of a paragraph. Inside an item the
// reference lexes text line by line (its "top" state is off), so a
// line indented four or more does not open a code block while a
// text run is going: it is merged into the run with four columns
// stripped, and blank lines inside such an indented stretch are
// absorbed as empty lines of the run.
function readTextRun(src, state, prot, base) {
  let len = 0;
  let text = '';
  let rest = src;
  let first = true;
  let inCode = false;
  for (;;) {
    const nl = rest.indexOf('\n');
    const line = nl === -1 ? rest : rest.slice(0, nl);
    const adv = nl === -1 ? rest.length : nl + 1;
    if (!first) {
      const isBlank = /^[ \t]*$/.test(line);
      if (isBlank && inCode && nl !== -1) {
        // The run survives the blank stretch only when indented
        // lines resume on the other side of it.
        let r2 = rest;
        let nb = 0;
        while (r2.length) {
          const l2 = firstLineOf(r2);
          if (!/^[ \t]*$/.test(l2)) break;
          nb++;
          const a2 = advanceLine(r2);
          if (a2 === null) { r2 = ''; break; }
          r2 = a2;
        }
        if (r2.length && indentOf(firstLineOf(r2)) >= 4) {
          for (let k = 0; k < nb; k++) {
            text += '\n';
            const a3 = lineLength(rest);
            len += a3;
            rest = rest.slice(a3);
          }
          continue;
        }
      }
      if (isBlank) break;
      if (!isBlank) {
        if (indentOf(line) >= 4) {
          text += stripIndent(line, 4) + '\n';
          len += adv;
          rest = rest.slice(adv);
          inCode = true;
          if (nl === -1) break;
          continue;
        }
        inCode = false;
        if (!(prot && prot.has(base + len))) {
          const se = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
          if (se) {
            const depth = se[1][0] === '=' ? 1 : 2;
            const htext = text.replace(/\n$/, '').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            return { token: { type: 'heading', depth, text: htext }, len: len + adv };
          }
          if (interruptsParagraph(line)) break;
          if (startsList(line, true, (state.inItem || 0) > 0)) break;
          if (matchTable(rest)) break;
        }
      }
    }
    text += line + '\n';
    len += adv;
    rest = rest.slice(adv);
    first = false;
    if (nl === -1) break;
  }
  return { token: { type: 'paragraph', text: text.replace(/\n$/, '') }, len };
}

// Strip one blockquote marker from a line; returns null when the line
// carries no marker. The marker is up to three spaces, a '>', and one
// optional space (a tab there counts its width minus the one space).
function stripQuoteMark(line) {
  let i = 0;
  let col = 0;
  while (line[i] === ' ' && col < 3) { i++; col++; }
  if (line[i] !== '>') return null;
  i++; col++;
  let out = '';
  // The marker's one space of padding: a space, or one column of a tab
  // (the rest of that tab stays as indentation).
  if (line[i] === ' ') { i++; col++; }
  else if (line[i] === '\t') {
    const w = 4 - (col % 4);
    out += ' '.repeat(Math.max(0, w - 1));
    col += w;
    i++;
  }
  // Expand the rest of the leading whitespace by original columns.
  while (line[i] === ' ' || line[i] === '\t') {
    if (line[i] === ' ') { out += ' '; col++; i++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
  }
  return out + line.slice(i);
}

// Read a blockquote starting at src.
function readBlockquote(src, state) {
  const lines = [];
  const lazyIdx = new Set();
  let rest = src;
  let len = 0;
  let lastWasBlank = true;
  let prevLazy = false;
  for (;;) {
    const nl = rest.indexOf('\n');
    const line = nl === -1 ? rest : rest.slice(0, nl);
    const adv = nl === -1 ? rest.length : nl + 1;
    const stripped = stripQuoteMark(line);
    if (stripped !== null) {
      lines.push(stripped);
      lastWasBlank = /^[ \t]*$/.test(stripped);
      prevLazy = false;
      len += adv; rest = rest.slice(adv);
      if (nl === -1) break;
      continue;
    }
    // Lazy continuation: a plain line that continues the quote's open
    // paragraph (code blocks and other blocks are not continued).
    if (!lastWasBlank && !/^[ \t]*$/.test(line) && !interruptsParagraph(line) && !startsList(line, true, (state.inItem || 0) > 0) &&
        innerEndsInParagraph(lines.join('\n'), state, lineOffsets(lines, lazyIdx))) {
      const ind = indentOf(line);
      // A setext underline that follows another lazy line is stored
      // indented, so the inner pass keeps it as paragraph text.
      let stored;
      if (prevLazy && /^ {0,3}(=+|-+)[ \t]*$/.test(line)) stored = '    ' + line.replace(/^ +/, '');
      else stored = ind >= 4 ? dedent(line, 4) : line;
      lines.push(stored);
      lazyIdx.add(lines.length - 1);
      prevLazy = true;
      len += adv; rest = rest.slice(adv);
      if (nl === -1) break;
      continue;
    }
    break;
  }
  const inner = lines.join('\n');
  // A blockquote's contents are lexed with the reference's top state
  // on, even when the quote itself sits inside a list item.
  const prevTop = state.top;
  state.top = true;
  const tokens = lexBlocks(inner, state, lineOffsets(lines, lazyIdx));
  state.top = prevTop;
  return { token: { type: 'blockquote', tokens }, len };
}

// ------------------------------------------------------------------ lists

const RE_MARKER = /^([-+*]|\d{1,9}[.)])(?=$|[ \t])/;
const RE_HR_LINE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;

// Does this line open a list item? When a paragraph is open, CommonMark
// lets a list interrupt only when the item is not empty, and an ordered
// list only when it starts at 1 — except inside a list item, where the
// reference implementation lets any start number interrupt.
function startsList(line, inParagraph, anyNumber) {
  const ind = indentOf(line);
  if (ind > 3) return false;
  const m = RE_MARKER.exec(line.slice(line.match(/^ */)[0].length));
  if (!m) return false;
  if (inParagraph) {
    const after = line.slice(line.match(/^ */)[0].length + m[0].length);
    if (!/[^\s]/.test(after)) return false;
    if (!anyNumber && /\d/.test(m[1][0]) && parseInt(m[1], 10) !== 1) return false;
  }
  return true;
}

// Parse the marker at the head of a line (already known to have at most
// three columns of indent). Returns {indent, bullet, ordered, delim,
// markerWidth, contentCol, firstContent} where contentCol is the column
// the item's content aligns to and firstContent is the rest of the line.
function parseMarker(line) {
  const indent = indentOf(line);
  const text = dedent(line, indent);
  const m = RE_MARKER.exec(text);
  if (!m) return null;
  const marker = m[1];
  const ordered = /\d/.test(marker[0]);
  const after = text.slice(marker.length);
  // Columns from the marker's end to the first content character.
  let spCols = 0;
  let ai = 0;
  let col = indent + marker.length;
  while (ai < after.length && (after[ai] === ' ' || after[ai] === '\t')) {
    if (after[ai] === ' ') { spCols++; col++; }
    else { const w = 4 - (col % 4); spCols += w; col += w; }
    ai++;
  }
  const hasContent = ai < after.length;
  let contentCol;
  if (!hasContent) contentCol = indent + marker.length + 1;
  else if (spCols >= 1 && spCols <= 4) contentCol = col;
  else contentCol = indent + marker.length + 1;
  // The reference item splitter measures the marker prefix in
  // characters (leading spaces plus the bullet itself) and keeps the
  // raw remainder of the line for its tab-expansion bookkeeping.
  const b = line.match(/^ */)[0].length + marker.length;
  return {
    indent,
    bullet: ordered ? null : marker,
    ordered,
    delim: ordered ? marker[marker.length - 1] : null,
    start: ordered ? String(parseInt(marker.slice(0, -1), 10)) : '',
    contentCol,
    firstContent: hasContent ? dedent(line, contentCol) : '',
    startsBlank: !hasContent,
    b,
    restRaw: line.slice(b),
  };
}

// Expand a run of whitespace the way the reference does: walking
// from a starting column, each tab advances to the next multiple
// of four and every other character takes one column.
function expandWsRun(ws, base) {
  let t = base;
  let out = '';
  for (const ch of ws) {
    if (ch === '\t') {
      const r = 4 - (t % 4);
      out += ' '.repeat(r);
      t += r;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

// Expand only a line's leading whitespace run (base = the column the
// run starts at).
function expandLeading(line, base) {
  const m = /^[ \t]+/.exec(line);
  if (!m) return line;
  return expandWsRun(m[0], base) + line.slice(m[0].length);
}

// The "begin" tests the reference item splitter applies around a
// list item: a line that opens a fence, heading, HTML block,
// blockquote, list or thematic break at up to `a` columns of indent
// ends the item instead of joining it. `a` is the item's content
// column minus one, clamped to 0..3. The lazy variant omits the
// blockquote and bullet tests; it is applied to the item's previous
// line when judging a shallow candidate line.
function beginRegexes(a) {
  return {
    fence: new RegExp('^ {0,' + a + '}(?:```|~~~)'),
    heading: new RegExp('^ {0,' + a + '}#{1,6}(?:\\s|$)'),
    html: new RegExp('^ {0,' + a + '}(?:</?(?:' + HTML_BLOCK_TAGS + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'),
    quote: new RegExp('^ {0,' + a + '}>'),
    bullet: new RegExp('^ {0,' + a + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))'),
    hr: new RegExp('^ {0,' + a + '}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)'),
  };
}
const BEGIN_SETS = [beginRegexes(0), beginRegexes(1), beginRegexes(2), beginRegexes(3)];

function beginsBlock(line, bg) {
  return bg.fence.test(line) || bg.heading.test(line) || bg.html.test(line) ||
    bg.quote.test(line) || bg.bullet.test(line) || bg.hr.test(line);
}
function beginsBlockLazy(line, bg) {
  return bg.fence.test(line) || bg.heading.test(line) || bg.html.test(line) || bg.hr.test(line);
}

function sameList(a, b) {
  if (a.ordered !== b.ordered) return false;
  return a.ordered ? a.delim === b.delim : a.bullet === b.bullet;
}

const NO_PROT = new Set();

// Read a whole list starting at src. Returns {token, len} or null.
// Item membership follows the reference splitter: a line belongs to
// the current item while it is blank or reaches the item's content
// column; a shallower line joins only as a lazy continuation, and
// only when the previous line is not blank, is not itself indented
// four or more, and does not open a fence, heading, HTML block or
// thematic break.
function readList(src, state) {
  const first = parseMarker(firstLineOf(src));
  if (!first) return null;
  const texts = [];
  const contentLens = [];
  const itemLens = [];
  let loose = false;
  let prevRawBlankEnd = false;
  let len = 0;
  let cur = first;
  for (;;) {
    const rest = src.slice(len);
    const R = cur.contentCol;
    const bg = BEGIN_SETS[Math.max(0, Math.min(3, R - 1))];
    let text = cur.firstContent;
    let itemLen = lineLength(rest);
    let itemContentLen = cur.startsBlank ? firstLineOf(rest).trimEnd().length : itemLen;
    let itemRest = advanceLine(rest);
    let breakLine = null;
    let skipLoop = false;
    if (cur.startsBlank && itemRest !== null && /^[ \t]*$/.test(firstLineOf(itemRest))) {
      // A marker line that is blank, followed by another blank line:
      // the item is empty and ends there.
      itemLen += lineLength(itemRest);
      itemRest = advanceLine(itemRest);
      text = '';
      skipLoop = true;
    }
    if (!skipLoop) {
      let prevLine = expandLeading(cur.restRaw, cur.b);
      let prevBlank = cur.startsBlank;
      while (itemRest !== null) {
        const line = firstLineOf(itemRest);
        const z = expandLeading(line, 0);
        if (beginsBlock(line, bg)) { breakLine = line; break; }
        const firstNs = z.search(/[^ \t]/);
        if (firstNs >= R || !line.trim()) {
          text += '\n' + z.slice(R);
        } else {
          const prevExp = prevLine.replace(/\t/g, '    ');
          if (prevBlank || prevExp.search(/[^ \t]/) >= 4 || beginsBlockLazy(prevLine, bg)) {
            breakLine = line;
            break;
          }
          // Lazy continuation, kept as written — except a setext
          // underline, which is stored indented so the inner lexer
          // still reads it as an underline.
          let kept = line;
          if (/^ {0,3}(=+|-+) *$/.test(line) && prevLine.trim() !== '') {
            kept = '    ' + z.replace(/^ {0,3}/, '');
          }
          text += '\n' + kept;
        }
        prevBlank = !line.trim();
        prevLine = z.slice(R);
        itemLen += lineLength(itemRest);
        if (line.trim() !== '') itemContentLen = itemLen;
        itemRest = advanceLine(itemRest);
      }
    }
    // Looseness: an item whose raw span ends with a blank line makes
    // the list loose once a sibling item follows it.
    const raw = src.slice(len, len + itemLen);
    if (prevRawBlankEnd) loose = true;
    else if (/\n[ \t]*\n[ \t]*$/.test(raw)) prevRawBlankEnd = true;
    texts.push(text);
    contentLens.push(itemContentLen);
    itemLens.push(itemLen);
    len += itemLen;
    if (itemRest === null) break;
    // The next item, if any, starts on the line the collection
    // stopped at — unless that line is a thematic break, which ends
    // the list outright.
    const candLine = firstLineOf(itemRest);
    const indB = indentOf(candLine);
    const pm = parseMarker(candLine);
    if (pm && indB <= 3 && sameList(cur, pm) && !RE_HR_LINE.test(candLine)) { cur = pm; continue; }
    break;
  }
  const items = [];
  const prevTop = state.top;
  state.top = false;
  for (let idx = 0; idx < texts.length; idx++) {
    // Only the final item's text is end-trimmed by the reference.
    const t = idx === texts.length - 1 ? texts[idx].trimEnd() : texts[idx];
    state.inItem = (state.inItem || 0) + 1;
    const tokens = lexBlocks(t, state, NO_PROT);
    state.inItem--;
    if (tokens.blankBetween) loose = true;
    const item = { tokens, task: false, checked: false };
    markTask(item);
    items.push(item);
  }
  state.top = prevTop;
  // The list's consumed length ends at the last item's last content
  // line: trailing blank lines belong to whatever follows.
  const lastIdx = texts.length - 1;
  return {
    token: { type: 'list', ordered: first.ordered, start: first.start, loose, items },
    len: len - (itemLens[lastIdx] - contentLens[lastIdx]),
  };
}

function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}
function lineLength(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s.length : nl + 1;
}
function advanceLine(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? null : s.slice(nl + 1);
}

// Character offsets of the starts of the lines (joined with '\n')
// whose indices are in idxSet. Used to tell the block lexer which
// lines were lazy continuations, so it does not reinterpret them as
// block starts when it lexes a container's inner text.
function lineOffsets(lines, idxSet) {
  const out = new Set();
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    if (idxSet.has(i)) out.add(off);
    off += lines[i].length + 1;
  }
  return out;
}

// Does this token list end inside an open paragraph (looking through
// nested blockquotes)?
function endsInParagraph(toks) {
  const last = toks[toks.length - 1];
  if (!last) return false;
  if (last.type === 'paragraph') return true;
  if (last.type === 'blockquote') return endsInParagraph(last.tokens);
  if (last.type === 'list' && last.items.length) {
    return endsInParagraph(last.items[last.items.length - 1].tokens);
  }
  return false;
}

// Would lexing this text end inside an open paragraph? Used for lazy
// continuation decisions: true when the last block is a paragraph.
function innerEndsInParagraph(text, state, prot) {
  if (!text.trim()) return false;
  const toks = lexBlocks(text, { links: state.links, inItem: state.inItem || 0 }, prot);
  return endsInParagraph(toks);
}

// Detect a task list item: the first paragraph of the item opens with a
// checkbox marker, which the renderer replaces with an input element.
function markTask(item) {
  const first = item.tokens[0];
  if (!first || (first.type !== 'paragraph' && first.type !== 'text')) return;
  const m = /^\[([ xX])\] /.exec(first.text) || /^\[([ xX])\]$/.exec(first.text);
  if (!m) return;
  item.task = true;
  item.checked = m[1] !== ' ';
  first.text = first.text.slice(m[0].length);
}

// ------------------------------------------------------------- block loop

function lexBlocks(src, state, prot) {
  const tokens = [];
  let rest = src;
  while (rest.length) {
    // Blank lines between blocks. A separator marker is left behind so
    // the caller can tell blocks were blank-separated (list looseness
    // depends on it); the markers are filtered out before returning.
    const blank = RE_BLANK.exec(rest);
    if (blank) {
      if (tokens.length && tokens[tokens.length - 1].type !== 'sep') tokens.push({ type: 'sep' });
      rest = rest.slice(blank[0].length);
      continue;
    }
    if (/^[ \t]+$/.test(rest)) break;

    const line = firstLineOf(rest);
    const ind = indentOf(line);

    // Indented code block: lines indented four or more, blanks allowed
    // inside, trailing blank lines not part of the block.
    if (ind >= 4) {
      const lines = [];
      let r = rest;
      let lastContent = -1;
      while (r.length) {
        const l = firstLineOf(r);
        if (/^[ \t]*$/.test(l)) { lines.push(stripIndent(l, 4)); r = advanceLine(r) ?? ''; continue; }
        if (indentOf(l) < 4) break;
        lines.push(stripIndent(l, 4));
        lastContent = lines.length - 1;
        r = advanceLine(r) ?? '';
      }
      if (lastContent >= 0) {
        const text = lines.slice(0, lastContent + 1).join('\n') + '\n';
        tokens.push({ type: 'code', text, lang: '' });
        rest = r;
        continue;
      }
    }

    // Fenced code.
    const fm = RE_FENCES.exec(rest);
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
      const fence = fm[1];
      const ch = fence[0];
      const info = fm[2].trim();
      const openWs = line.match(/^\s*/)[0];
      let r = advanceLine(rest) ?? '';
      const body = [];
      let closed = false;
      while (r.length) {
        const l = firstLineOf(r);
        const close = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$').exec(l);
        if (close) { closed = true; r = advanceLine(r) ?? ''; break; }
        body.push(l);
        r = advanceLine(r) ?? '';
      }
      void closed;
      // Indent compensation (backtick fences only): each content
      // line gives up as many leading whitespace CHARACTERS as the
      // fence line itself was indented, capped at its own leading
      // whitespace run — a tab counts as one character here.
      if (ch === '`' && openWs.length) {
        for (let bi = 0; bi < body.length; bi++) {
          const ws = /^\s+/.exec(body[bi]);
          if (ws) body[bi] = body[bi].slice(Math.min(ws[0].length, openWs.length));
        }
      }
      // One trailing blank content line is the newline before the
      // closing fence, not content.
      if (body.length && body[body.length - 1] === '') body.pop();
      const lang = unescapePunct(info.split(/\s+/)[0] || '');
      tokens.push({ type: 'code', text: body.length ? body.join('\n') + '\n' : '', lang, fenced: true });
      rest = r;
      continue;
    }

    // ATX heading.
    const hm = RE_ATX.exec(rest);
    if (hm) {
      let text = (hm[2] ?? '').replace(/[ \t]+$/, '');
      if (/^#+$/.test(text)) text = '';
      else text = text.replace(/[ \t]+#+$/, '');
      tokens.push({ type: 'heading', depth: hm[1].length, text });
      rest = rest.slice(hm[0].length);
      continue;
    }

    // Thematic break.
    const hr = RE_HR.exec(rest);
    if (hr) {
      tokens.push({ type: 'hr' });
      rest = rest.slice(hr[0].length);
      continue;
    }

    // Blockquote.
    if (/^ {0,3}>/.test(rest)) {
      const q = readBlockquote(rest, state);
      tokens.push(q.token);
      rest = rest.slice(q.len);
      continue;
    }

    // List.
    if (startsList(line, false)) {
      const li = readList(rest, state);
      if (li) {
        tokens.push(li.token);
        rest = rest.slice(li.len);
        continue;
      }
    }

    // HTML block.
    const hb = matchHtmlBlock(rest, false);
    if (hb) {
      tokens.push({ type: 'html', text: hb.text });
      rest = rest.slice(hb.len);
      continue;
    }

    // Link reference definition.
    const dm = RE_DEF.exec(rest);
    if (dm && labelUsable(dm[1])) {
      const label = normalizeLabel(dm[1]);
      if (!state.links.has(label)) {
        const href = decodeEntities(unescapePunct(dm[2] !== undefined ? dm[2] : dm[3] || ''));
        let title = null;
        if (dm[4] !== undefined) title = decodeEntities(unescapePunct(dm[4].slice(1, -1)));
        state.links.set(label, { href, title });
      }
      tokens.push({ type: 'def' });
      rest = rest.slice(dm[0].length);
      continue;
    }

    // Table.
    const tb = matchTable(rest);
    if (tb) {
      tokens.push({ type: 'table', header: tb.header, align: tb.align, rows: tb.rows });
      rest = rest.slice(tb.len);
      continue;
    }

    // Paragraph or setext heading. Inside list items the reference
    // lexes with its top state off, which turns paragraphs into
    // line-by-line text runs.
    const p = state.top === false
      ? readTextRun(rest, state, prot, src.length - rest.length)
      : readParagraph(rest, state, prot, src.length - rest.length);
    tokens.push(p.token);
    rest = rest.slice(p.len);
  }
  // Drop separator markers, remembering whether a blank line sat
  // between two real blocks. Link definitions render as nothing but
  // still count as blocks for that question.
  const cleaned = [];
  let sepPending = false;
  let blankBetween = false;
  let blocks = 0;
  for (const t of tokens) {
    if (t.type === 'sep') { sepPending = true; continue; }
    if (sepPending && blocks > 0) blankBetween = true;
    sepPending = false;
    blocks++;
    if (t.type !== 'def') cleaned.push(t);
  }
  cleaned.blankBetween = blankBetween;
  return cleaned;
}

// ----------------------------------------------------------------- inline
// The inline pass scans text into nodes, then a delimiter pass pairs
// emphasis runs. Node kinds: text (raw source text), raw (pre-rendered),
// code, html, br, link, img, delim, em, strong, del.

const DISALLOWED_TAGS = new Set(['title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'script', 'plaintext']);
const RE_TAG_OPEN = /^<([A-Za-z][A-Za-z0-9-]*)((?:[ \t\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*)[ \t\n]*\/?>|^<\/([A-Za-z][A-Za-z0-9-]*)[ \t\n]*>/;
const RE_TAG_CLOSE = /^<\/[A-Za-z][A-Za-z0-9-]*[ \t\n]*>/;
const RE_COMMENT = /^<!--[\s\S]*?-->/;
const RE_PI = /^<\?[\s\S]*?\?>/;
const RE_DECL = /^<![A-Za-z][\s\S]*?>/;
const RE_CDATA = /^<!\[CDATA\[[\s\S]*?\]\]>/;
const RE_AUTOLINK_URI = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;
const RE_AUTOLINK_MAIL = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
const RE_URL_START = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const PUNCT_RE = /[!-\/:-@\[-`{-~]/;
// For emphasis flanking the reference counts Unicode punctuation and
// symbols as punctuation, not just the ASCII set.
const FLANK_PUNCT_RE = /[\p{P}\p{S}]/u;

function normalizeLabel(s) {
  // Whitespace-folded, case-folded label key (with the common Unicode
  // folds a plain toLowerCase misses).
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// Find the ']' closing the '[' at text[i]. Escaped brackets do not
// count, and neither do brackets inside a code span or an HTML tag.
// Returns its index or -1.
function findClosingBracket(text, i) {
  let depth = 1;
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') {
      let n = 0;
      while (text[j + n] === '`') n++;
      // In a link label a backtick run pairs with the NEXT run of
      // backticks, whatever its length (the content between holds
      // no backticks). A run of two or more sitting immediately
      // before the closing bracket is allowed bare, and that reading
      // wins over a far-away pairing. With no later run and no
      // bracket after it, the label fails.
      if (n >= 2 && text[j + n] === ']' && depth === 1) return j + n;
      const next = text.indexOf('`', j + n);
      if (next === -1) return -1;
      let mEnd = next;
      while (text[mEnd] === '`') mEnd++;
      j = mEnd;
      continue;
    }
    if (ch === '<') {
      const rest = text.slice(j);
      const tm = RE_TAG_OPEN.exec(rest) || RE_TAG_CLOSE.exec(rest) ||
        RE_AUTOLINK_URI.exec(rest) || RE_AUTOLINK_MAIL.exec(rest) ||
        RE_COMMENT.exec(rest) || RE_PI.exec(rest) || RE_DECL.exec(rest) ||
        RE_CDATA.exec(rest);
      if (tm) { j += tm[0].length; continue; }
      j++;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return j; }
    j++;
  }
  return -1;
}

// Parse a link or image whose '[' sits at text[i]. Returns
// {href, title, label, end} or null.
function parseLinkAt(text, i, state) {
  const close = findClosingBracket(text, i);
  if (close === -1) return null;
  const label = text.slice(i + 1, close);
  let k = close + 1;
  if (text[k] === '(') {
    // Inline destination and optional title.
    let p = k + 1;
    const skipWs = () => { while (p < text.length && /[ \t\n]/.test(text[p])) p++; };
    skipWs();
    let href = null;
    if (text[p] === '<') {
      // Angle destination: scan for the closing '>', stepping over
      // backslash escape pairs (an escaped '>' does not close it).
      let q = p + 1;
      let closedAngle = false;
      while (q < text.length) {
        const c = text[q];
        if (c === '\\') { q += 2; continue; }
        if (c === '>') { closedAngle = true; break; }
        if (c === '<' || c === '\n') break;
        q++;
      }
      if (closedAngle) {
        href = text.slice(p + 1, q);
        p = q + 1;
      }
    } else {
      let depth = 0;
      const start = p;
      while (p < text.length) {
        const ch = text[p];
        if (ch === '\\') { p += 2; continue; }
        if (/[\x00-\x20\x7f]/.test(ch)) break;
        if (ch === '(') depth++;
        else if (ch === ')') { if (depth === 0) break; depth--; }
        p++;
      }
      href = text.slice(start, p);
    }
    if (href !== null) {
      skipWs();
      let title = null;
      let ok = true;
      const q = text[p];
      if (q === '"' || q === "'" || q === '(') {
        const closer = q === '(' ? ')' : q;
        let r = p + 1;
        let t = '';
        let closedTitle = false;
        while (r < text.length) {
          const ch = text[r];
          if (ch === '\\') { t += ch + (text[r + 1] ?? ''); r += 2; continue; }
          if (ch === closer) { closedTitle = true; break; }
          if (q === '(' && ch === '(') { ok = false; break; }
          t += ch;
          r++;
        }
        if (closedTitle) { title = t; p = r + 1; skipWs(); }
        else ok = false;
      }
      if (ok && text[p] === ')') {
        return { form: 'inline', href: decodeEntities(unescapePunct(href)), title: title === null ? null : decodeEntities(unescapePunct(title)), label, end: p + 1 };
      }
    }
    // Fall through: maybe a reference or shortcut link.
  }
  if (text[k] === '[') {
    const end2 = findClosingBracket(text, k);
    if (end2 !== -1) {
      const ref = text.slice(k + 1, end2) || label;
      const hit = state.links.get(normalizeLabel(ref));
      if (hit) return { form: 'ref', href: hit.href, title: hit.title, label, end: end2 + 1 };
      return null;
    }
  }
  const hit = state.links.get(normalizeLabel(label));
  if (hit) return { form: 'ref', href: hit.href, title: hit.title, label, end: k };
  return null;
}

// Whether a parsed inline node list contains a bracket-formed link
// anywhere inside (autolinks do not deactivate an outer link; images
// are not links).
function hasLink(nodes) {
  for (const n of nodes) {
    if (n.k === 'link' && !n.auto) return true;
    if (n.kids && hasLink(n.kids)) return true;
  }
  return false;
}

// Trim a bare URL the way the GFM autolink rules trim it: trailing
// punctuation goes, an unbalanced close paren goes, a trailing entity
// is not punctuation.
// The reference trims an extended autolink by repeatedly keeping
// only the longest prefix that ends "stably": runs of ordinary
// characters, balanced parenthesis groups, ampersands that do not
// start an entity, and punctuation runs that are not at the end.
function trimAutolink(url) {
  let s = url;
  for (;;) {
    const m = BACKPEDAL_RE.exec(s);
    const next = m ? m[0] : '';
    if (next === s) return s;
    s = next;
  }
}

// An extended email autolink at the head of rest, optionally behind a
// mailto: or xmpp: scheme. The candidate run is consumed whole, then
// validated: trailing dots are not part of it, and a candidate ending
// in '-' or '_' (or failing the address shape) is no link at all.
// Returns {text, href} or null.
const EMAIL_FULL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
function matchEmailAutolink(rest) {
  let prefix = '';
  let s = rest;
  const sm = /^(?:mailto|xmpp):/i.exec(s);
  if (sm) { prefix = sm[0]; s = s.slice(sm[0].length); }
  const run = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9._~-]+/.exec(s);
  if (!run) return null;
  let cand = run[0];
  while (cand.endsWith('.')) cand = cand.slice(0, -1);
  if (cand.endsWith('-') || cand.endsWith('_')) return null;
  if (!EMAIL_FULL.test(cand)) return null;
  // An xmpp: address may carry one resource segment (/txt, /a@b.c).
  if (prefix && /^xmpp:/i.test(prefix)) {
    const tail = s.slice(run[0].length);
    const seg = /^\/[^/\s<]+/.exec(tail);
    if (seg) cand += seg[0];
  }
  return { text: prefix + cand, href: prefix ? prefix + cand : 'mailto:' + cand };
}

// ------------------------------------------------------- emphasis engine
// The reference forms emphasis and strikethrough by attempting, at
// each delimiter run, to find a closing run in the rest of the text:
// candidate runs are classified by their neighbouring characters,
// some classes only add to a pool of openers the closer must cover,
// and a multiple-of-three rule can set a candidate aside. The search
// runs over a masked copy of the whole inline segment, computed once
// per segment: reference links are blobbed first (a link whose label
// itself contains a link keeps its label visible), then punctuation
// outside code spans collapses (code-span interiors have their
// backticks blanked, escapes become '+'), and finally code spans,
// inline links and tags are replaced by same-length blobs.

const PS_RE = /[\p{P}\p{S}]/u;
const CHUNK_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/;
const CHUNK_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/;
const PSS_RE = /[\s\p{P}\p{S}]/u;
const OPEN_QUOTE_RE = /[\p{Pi}\p{Ps}"']/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

const MASK_LABEL = '(?:[^\\[\\]\\\\`]*(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const MASK_REF = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const REFLINK_SEARCH_RE = new RegExp('!?\\[' + MASK_LABEL + '\\]\\[' + MASK_REF + '\\]|!?\\[' + MASK_REF + '\\](?:\\[\\])?(?!\\()', 'g');
const ANY_PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP_RE = /(?:\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>)/g;

// One reference-link match of the mask's first pass: blob it unless
// its reference is unknown; a link whose label contains a real link
// keeps the (recursively masked) label and blobs only the reference.
function maskRefCallback(r, state) {
  const o = r.lastIndexOf('[');
  if (!state.links.has(normalizeLabel(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (labelHasRealLink(inner, state)) {
      return '[' + inner.replace(REFLINK_SEARCH_RE, (m) => maskRefCallback(m, state)) + '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

// The masked view of an inline segment, same length as the input.
function computeMask(text, state) {
  let t = text;
  if (t.includes('[')) t = t.replace(REFLINK_SEARCH_RE, (r) => maskRefCallback(r, state));
  t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (n, s, r) => r !== undefined
    ? '+'.repeat(n.length)
    : s !== undefined
      ? s + n.slice(s.length, n.length - s.length).replace(/`/g, '+') + s
      : n);
  t = t.replace(BLOCK_SKIP_RE, (n) => '[' + 'a'.repeat(Math.max(0, n.length - 2)) + ']');
  return t;
}

// The start of the last run of ch in the mask whose preceding
// character is not blank-ish (the closer search bound); the mask
// reads a virtual newline before position 0.
function lastBound(mask, ch) {
  let v = -1;
  let pos = 0;
  while (pos < mask.length) {
    const c = mask[pos];
    if (c === '*' || c === '_' || c === '~') {
      let j = pos;
      while (j < mask.length && mask[j] === c) j++;
      const before = pos === 0 ? '\n' : mask[pos - 1];
      if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f' && c === ch) v = pos;
      pos = j;
      continue;
    }
    pos++;
  }
  return v;
}

function clsPunct(c) { return c !== '' && c !== '~' && PS_RE.test(c); }
function clsPunctSpace(c) { return c !== '' && c !== '~' && PSS_RE.test(c); }
function clsNotPunctSpace(c) { return c !== '' && (c === '~' || !PSS_RE.test(c)); }
function clsWs(c) { return c !== '' && /\s/.test(c); }

// Classify a maximal delimiter run by its neighbours: 1/2 close-only,
// 3/4 open-only, 5/6 both open and close, 0 unusable as either.
function classifyRun(p, n, ch) {
  if (clsPunct(p) && p !== ch && (n === '' || clsWs(n))) return 1;
  if (clsNotPunctSpace(p) && (n === '' || clsPunctSpace(n))) return 2;
  if (clsPunctSpace(p) && p !== ch && clsNotPunctSpace(n)) return 3;
  if (clsWs(p) && clsPunct(n)) return 4;
  if (clsPunct(p) && p !== ch && clsPunct(n)) return 5;
  if (clsNotPunctSpace(p) && clsNotPunctSpace(n)) return 6;
  return 0;
}

// The underscore classification differs: its class tests count a
// tilde as punctuation, and a run with word characters on both sides
// is unusable (intraword underscores neither open nor close).
function classifyRunUnd(p, n) {
  const punct = (c) => c !== '' && PS_RE.test(c);
  const punctSpace = (c) => c !== '' && PSS_RE.test(c);
  const notPunctSpace = (c) => c !== '' && !PSS_RE.test(c);
  if (punct(p) && p !== '_' && (n === '' || clsWs(n))) return 1;
  if (notPunctSpace(p) && (n === '' || punctSpace(n))) return 2;
  if (punctSpace(p) && p !== '_' && notPunctSpace(n)) return 3;
  if (clsWs(p) && punct(n)) return 4;
  if (punct(p) && p !== '_' && punct(n)) return 5;
  return 0;
}

// The strikethrough classification: same shape as the underscore
// one (plain punctuation classes, a tilde counts as punctuation),
// but a run with word characters on both sides is usable.
function classifyRunPlain(p, n, ch) {
  const punct = (c) => c !== '' && PS_RE.test(c);
  const punctSpace = (c) => c !== '' && PSS_RE.test(c);
  const notPunctSpace = (c) => c !== '' && !PSS_RE.test(c);
  if (punct(p) && p !== ch && (n === '' || clsWs(n))) return 1;
  if (notPunctSpace(p) && (n === '' || punctSpace(n))) return 2;
  if (punctSpace(p) && p !== ch && notPunctSpace(n)) return 3;
  if (clsWs(p) && punct(n)) return 4;
  if (punct(p) && p !== ch && punct(n)) return 5;
  if (notPunctSpace(p) && notPunctSpace(n)) return 6;
  return 0;
}

// Does a link label itself contain a real link? (An inner link makes
// the reference mask keep the label visible instead of blobbing the
// whole link, and makes the outer link fail.) Mirrors the reference's
// link-in-text test: inline links count by shape, reference links
// count when their reference exists and their own label is link-free,
// images never count.
function labelHasRealLink(label, state) {
  let pos = 0;
  while (pos < label.length) {
    const c = label[pos];
    if (c === '[') {
      const link = parseLinkAt(label, pos, state);
      if (link) {
        if (link.form !== 'inline') {
          if (!labelHasRealLink(link.label, state)) return true;
        } else return true;
      }
      pos++;
      continue;
    }
    if (c === '!' && label[pos + 1] === '[') { pos++; continue; }
    const s = scanStep(label, pos, state);
    pos = s.end;
  }
  return false;
}

// One step of the closer search: the unit starting at pos, its end
// offset, and the character its end reads as in the blob view.
function scanStep(text, pos, state) {
  const c = text[pos];
  if (c === '\\') {
    if (pos + 1 < text.length && PUNCT_RE.test(text[pos + 1])) return { end: pos + 2, kind: 'escape', last: '+' };
    return { end: pos + 1, kind: 'char', last: '\\' };
  }
  if (c === '`') {
    let n = 0;
    while (text[pos + n] === '`') n++;
    let j = pos + n;
    while (j < text.length) {
      if (text[j] === '`') {
        let m = 0;
        while (text[j + m] === '`') m++;
        if (m === n) return { end: j + m, kind: 'blob', last: ']' };
        j += m;
      } else j++;
    }
    return { end: pos + n, kind: 'char', last: '`' };
  }
  if (c === '<') {
    const rest = text.slice(pos);
    const m = /^<!--(?:>|->|[\s\S]*?-->)/.exec(rest) || /^<\?[\s\S]*?\?>/.exec(rest) ||
      /^<![A-Za-z][\s\S]*?>/.exec(rest) || /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(rest) ||
      RE_AUTOLINK_URI.exec(rest) || RE_AUTOLINK_MAIL.exec(rest) || RE_TAG_OPEN.exec(rest);
    if (m) return { end: pos + m[0].length, kind: 'blob', last: ']' };
    return { end: pos + 1, kind: 'char', last: '<' };
  }
  if (c === '[' || (c === '!' && text[pos + 1] === '[')) {
    const link = parseLinkAt(text, c === '[' ? pos : pos + 1, state);
    if (link && !labelHasRealLink(link.label, state)) return { end: link.end, kind: 'blob', last: ']' };
    return { end: pos + 1, kind: 'char', last: c };
  }
  const cp = text.codePointAt(pos);
  return { end: pos + (cp > 0xffff ? 2 : 1), kind: 'char', last: c };
}

// Try to form an em or strong span at the delimiter run at text[i].
// prevCh is the last character of the preceding text token ('' when
// the previous token was not text). The classification context (the
// character before the run, whether the run effectively starts the
// segment) is read from the mask, as in the reference. Returns
// {kind, content, end} or null.
function tryEmStrong(text, mask, i, state, prevCh) {
  const ch = text[i];
  let runEnd = i;
  while (runEnd < text.length && text[runEnd] === ch) runEnd++;
  const k = runEnd - i;
  const after = runEnd < text.length ? text[runEnd] : '';
  if (after === '' || /\s/.test(after)) return null;
  // A following punctuation character (a tilde does not count as
  // one here) makes this a punctuation-led opening; keep it in d.
  let d = '';
  if (after !== '~' && PS_RE.test(after)) d = after;
  let runStart = i;
  while (runStart > 0 && mask[runStart - 1] === ch) runStart--;
  const backed = runStart < i;
  const p = runStart > 0 ? mask[runStart - 1] : '';
  const h = p === '*' || p === '_' || (p !== '' && p !== '*' && p !== '_' && PSS_RE.test(p));
  const n = backed ? p : prevCh;
  const o = prevCh === ch;
  const u = backed ? h : (n !== '' && n !== '*' && n !== '_' && PSS_RE.test(n));
  if (ch === '_' && d === '' && n !== '' && ALNUM_RE.test(n)) return null;
  if (d !== '' && n !== '' && !u) return null;
  const y = (i - runStart) + k;
  const R = p !== '' && p.trim() !== '' && (d !== '' || (ch === '*' && !h));
  const v = lastBound(mask, ch);
  if (v < i + k) return null;
  let pool = k;
  let f = 0;
  let pos = runEnd;
  let prevLast = ch;
  // A leading chunk holding the other delimiter's double run with
  // one of ours inside it is spoken for: skip it whole.
  const chunk = (ch === '*' ? CHUNK_AST : CHUNK_UND).exec(mask.slice(pos));
  if (chunk) {
    pos += chunk[0].length;
    if (chunk[0].length) prevLast = mask[pos - 1];
  }
  while (pos < mask.length) {
    if (mask[pos] === ch) {
      let j = pos;
      while (j < mask.length && mask[j] === ch) j++;
      if (pos - 1 > v) break;
      const b = j - pos;
      const g = ch === '_' ? classifyRunUnd(prevLast, j < mask.length ? mask[j] : '') : classifyRun(prevLast, j < mask.length ? mask[j] : '', ch);
      if (g === 3 || g === 4) {
        pool += b;
      } else if (g !== 0) {
        let skipped = false;
        if (g === 5 || g === 6 || R) {
          if (o && (g === 5 || g === 6)) return null;
          if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; skipped = true; }
        }
        if (!skipped) {
          pool -= b;
          if (pool <= 0) {
            const used = Math.min(b, b + pool + f);
            const end = pos + used;
            const raw = text.slice(i, end);
            if (Math.min(k, used) % 2 === 1) return { kind: 'em', content: raw.slice(1, -1), end };
            return { kind: 'strong', content: raw.slice(2, -2), end };
          }
        }
      }
      prevLast = ch;
      pos = j;
      continue;
    }
    prevLast = mask[pos];
    pos++;
  }
  return null;
}

// Try to form a strikethrough span at the tilde run at text[i].
function tryDel(text, mask, i, state, prevCh) {
  if (text[i + 1] === '~' && text[i + 2] === '~') return null;
  const o = text[i + 1] === '~' ? 2 : 1;
  const after = i + o < text.length ? text[i + o] : '';
  if (after === '' || /\s/.test(after)) return null;
  if (prevCh !== '' && (prevCh === '*' || prevCh === '_' || !PSS_RE.test(prevCh))) return null;
  const v = lastBound(mask, '~');
  if (v < i + o) return null;
  let pool = o;
  let pos = i + o;
  let prevLast = '~';
  while (pos < mask.length) {
    if (mask[pos] === '~') {
      let j = pos;
      while (j < mask.length && mask[j] === '~') j++;
      if (pos - 1 > v) break;
      const b = j - pos;
      if (b === o) {
        const g = classifyRunPlain(prevLast, j < mask.length ? mask[j] : '', '~');
        if (g === 3 || g === 4) pool += b;
        else if (g !== 0) {
          pool -= b;
          if (pool <= 0) {
            const used = Math.min(b, b + pool);
            return { kind: 'del', content: text.slice(i + o, pos), end: pos + used };
          }
        }
      }
      prevLast = '~';
      pos = j;
      continue;
    }
    prevLast = mask[pos];
    pos++;
  }
  return null;
}

function inlineNodes(text, state) {
  const nodes = [];
  const mask = computeMask(text, state);
  const pushText = (s) => {
    if (!s) return;
    const last = nodes[nodes.length - 1];
    if (last && last.k === 'text') last.v += s;
    else nodes.push({ k: 'text', v: s });
  };
  // prevCh: last character of the preceding text token ('' when the
  // previous token was not text). barrier: how far left a delimiter
  // run at the scan position may extend (non-text units reset it).
  let prevCh = '';
  let barrier = 0;
  const nonText = () => { prevCh = ''; barrier = i; };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '\n') {
        nodes.push({ k: 'br' });
        i += 2;
        // A hard break swallows the next line's leading whitespace.
        while (text[i] === ' ' || text[i] === '\t') i++;
        nonText();
        continue;
      }
      if (next !== undefined && PUNCT_RE.test(next)) {
        nodes.push({ k: 'raw', v: ESCAPES[next] ?? next, plain: next });
        i += 2;
        nonText();
        continue;
      }
      pushText('\\');
      prevCh = '\\';
      i++;
      continue;
    }
    if (ch === '`') {
      let n = 0;
      while (text[i + n] === '`') n++;
      // Find a closing run of exactly n backticks.
      let j = i + n;
      let closeAt = -1;
      while (j < text.length) {
        if (text[j] === '`') {
          let m = 0;
          while (text[j + m] === '`') m++;
          if (m === n) { closeAt = j; break; }
          j += m;
        } else j++;
      }
      if (closeAt === -1) { pushText('`'.repeat(n)); prevCh = '`'; i += n; continue; }
      let content = text.slice(i + n, closeAt).replace(/\n/g, ' ');
      if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push({ k: 'code', v: content });
      i = closeAt + n;
      nonText();
      continue;
    }
    if (ch === '<') {
      const rest = text.slice(i);
      let m;
      if ((m = /^<!--(?:>|->|[\s\S]*?-->)/.exec(rest)) || (m = /^<\?[\s\S]*?\?>/.exec(rest)) ||
          (m = /^<![A-Za-z][\s\S]*?>/.exec(rest)) || (m = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(rest))) {
        nodes.push({ k: 'html', v: m[0] });
        i += m[0].length;
        nonText();
        continue;
      }
      if ((m = RE_AUTOLINK_URI.exec(rest))) {
        nodes.push({ k: 'link', auto: true, href: m[1], title: null, kids: [{ k: 'text', v: m[1] }] });
        i += m[0].length;
        nonText();
        continue;
      }
      if ((m = RE_AUTOLINK_MAIL.exec(rest))) {
        nodes.push({ k: 'link', auto: true, href: 'mailto:' + m[1], title: null, kids: [{ k: 'text', v: m[1] }] });
        i += m[0].length;
        nonText();
        continue;
      }
      if ((m = RE_TAG_OPEN.exec(rest))) {
        if (DISALLOWED_TAGS.has((m[1] ?? m[3]).toLowerCase())) nodes.push({ k: 'raw', v: m[0], plain: m[0] });
        else nodes.push({ k: 'html', v: m[0] });
        // One state for the whole document: a tag whose text starts
        // with "<a " opens it, a literal "</a>" closes it, and
        // extended autolinks stay literal in between.
        if (/^<a /i.test(m[0])) state.inLink = true;
        else if (/^<\/a>/i.test(m[0])) state.inLink = false;
        i += m[0].length;
        nonText();
        continue;
      }
      pushText('<');
      prevCh = '<';
      i++;
      continue;
    }
    if (ch === '!' && text[i + 1] === '[') {
      const link = parseLinkAt(text, i + 1, state);
      if (link) {
        const altKids = inlineNodes(link.label, state);
        nodes.push({ k: 'img', href: link.href, title: link.title, alt: plainText(altKids) });
        i = link.end;
        nonText();
        continue;
      }
      pushText('!');
      prevCh = '!';
      i++;
      continue;
    }
    if (ch === '[') {
      const link = parseLinkAt(text, i, state);
      if (link) {
        // Inside a link label, extended autolinks stay literal.
        const wasInLink = state.inLink;
        state.inLink = true;
        const kids = inlineNodes(link.label, state);
        state.inLink = wasInLink;
        // A link may not contain another link: if the label produced
        // one, this '[' stays literal and the inner link wins.
        if (!hasLink(kids)) {
          nodes.push({ k: 'link', href: link.href, title: link.title, kids });
          i = link.end;
          nonText();
          continue;
        }
      }
      pushText('[');
      prevCh = '[';
      i++;
      continue;
    }
    if (ch === '*' || ch === '_') {
      const hit = tryEmStrong(text, mask, i, state, prevCh);
      if (hit) {
        nodes.push({ k: hit.kind, kids: inlineNodes(hit.content, state) });
        i = hit.end;
        nonText();
        continue;
      }
      pushText(ch);
      prevCh = ch;
      i++;
      continue;
    }
    if (ch === '~') {
      const hit = tryDel(text, mask, i, state, prevCh);
      if (hit) {
        nodes.push({ k: 'del', kids: inlineNodes(hit.content, state) });
        i = hit.end;
        nonText();
        continue;
      }
      pushText('~');
      prevCh = '~';
      i++;
      continue;
    }
    // Extended autolinks at a word boundary (suppressed inside <a>).
    const prevRawCh = i === 0 ? '' : text[i - 1];
    if (!state.inLink && !/[A-Za-z0-9]/.test(prevRawCh)) {
      const rest = text.slice(i);
      const m = RE_URL_START.exec(rest);
      if (m) {
        let url;
        let href;
        if (m[2] === '@') {
          url = m[0];
          href = 'mailto:' + m[0];
        } else {
          url = trimAutolink(m[0]);
          href = m[1] === 'www.' ? 'http://' + url : url;
        }
        if (url) {
          nodes.push({ k: 'link', auto: true, href, title: null, kids: [{ k: 'text', v: url }] });
          i += url.length;
          nonText();
          continue;
        }
      }
    }
    // Plain text run: stop at the next special character, at a hard
    // break (two spaces or a backslash before the newline is handled by
    // the escape branch; trailing spaces stay in the text), or at a
    // word boundary where an autolink may start.
    let j = i;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\' || c === '`' || c === '<' || c === '[' || c === '*' || c === '_' || c === '~') break;
      if (c === '!' && text[j + 1] === '[') break;
      if (j > i && !/[A-Za-z0-9]/.test(text[j - 1]) && (c === 'w' || c === 'h' || c === 'f' || /[A-Za-z0-9._+-]/.test(c))) {
        const ahead = text.slice(j);
        if (RE_URL_START.test(ahead)) break;
      }
      if (c === ' ' && text[j + 1] === ' ') {
        // Possibly a hard break: spaces then newline.
        let s = j;
        while (text[s] === ' ') s++;
        if (text[s] === '\n') {
          // Emit the text before the spaces, then the break; the next
          // line's leading whitespace is swallowed.
          pushText(text.slice(i, j));
          nodes.push({ k: 'br' });
          i = s + 1;
          while (text[i] === ' ' || text[i] === '\t') i++;
          nonText();
          j = -1;
          break;
        }
      }
      j++;
    }
    if (j === -1) continue; // a hard break was emitted
    if (j === i) { pushText(text[i]); prevCh = text[i]; i++; continue; }
    pushText(text.slice(i, j));
    prevCh = text[j - 1];
    i = j;
  }
  return nodes;
}

// The plain-text reading of inline nodes, for image alt attributes.
function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.k === 'text') out += decodeNumericRefs(n.v);
    else if (n.k === 'raw') out += n.plain ?? '';
    else if (n.k === 'code') out += n.v;
    else if (n.k === 'br') out += '\n';
    else if (n.k === 'link' || n.k === 'em' || n.k === 'strong' || n.k === 'del') out += plainText(n.kids);
    else if (n.k === 'img') out += n.alt;
  }
  return out;
}

function renderNodes(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.k) {
      case 'text': out += escapeText(decodeNumericRefs(n.v)); break;
      case 'raw': out += n.v; break;
      case 'code': out += '<code>' + escapeRaw(n.v) + '</code>'; break;
      case 'html': out += n.v; break;
      case 'br': out += '<br>'; break;
      case 'em': out += '<em>' + renderNodes(n.kids) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(n.kids) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(n.kids) + '</del>'; break;
      case 'link':
        out += '<a href="' + escapeText(cleanUrl(n.href)) + '"' +
          (n.title !== null && n.title !== undefined ? ' title="' + escapeText(n.title) + '"' : '') +
          '>' + renderNodes(n.kids) + '</a>';
        break;
      case 'img':
        out += '<img src="' + escapeText(cleanUrl(n.href)) + '" alt="' + escapeRaw(n.alt) + '"' +
          (n.title !== null && n.title !== undefined ? ' title="' + escapeText(n.title) + '"' : '') + '>';
        break;
    }
  }
  return out;
}

function renderInline(text, state) {
  const nodes = inlineNodes(text, state);
  return renderNodes(nodes);
}

// --------------------------------------------------------------- renderer

function renderToken(t, state) {
  switch (t.type) {
    case 'heading':
      return '<h' + t.depth + '>' + renderInline(t.text, state) + '</h' + t.depth + '>\n';
    case 'paragraph':
      return '<p>' + renderInline(t.text, state) + '</p>\n';
    case 'code': {
      const cls = t.lang ? ' class="language-' + escapeText(t.lang) + '"' : '';
      return '<pre><code' + cls + '>' + escapeRaw(t.text) + '</code></pre>\n';
    }
    case 'hr':
      return '<hr>\n';
    case 'html':
      return t.text;
    case 'blockquote':
      return '<blockquote>\n' + renderTokens(t.tokens, state) + '</blockquote>\n';
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      t.header.forEach((c, i) => {
        out += '<th' + (t.align[i] ? ' align="' + t.align[i] + '"' : '') + '>' + renderInline(c, state) + '</th>\n';
      });
      out += '</tr>\n</thead>\n';
      if (t.rows.length) {
        out += '<tbody>';
        for (const row of t.rows) {
          out += '<tr>\n';
          row.forEach((c, i) => {
            out += '<td' + (t.align[i] ? ' align="' + t.align[i] + '"' : '') + '>' + renderInline(c, state) + '</td>\n';
          });
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    case 'list': {
      let out = t.ordered
        ? (t.start && t.start !== '1' ? '<ol start="' + t.start + '">\n' : '<ol>\n')
        : '<ul>\n';
      for (const item of t.items) out += '<li>' + renderItem(item, t.loose, state) + '</li>\n';
      return out + (t.ordered ? '</ol>\n' : '</ul>\n');
    }
    default:
      return '';
  }
}

// A list item: tight items render their paragraphs bare; the task
// checkbox, when present, leads the first paragraph's content.
function renderItem(item, loose, state) {
  let out = '';
  item.tokens.forEach((t, idx) => {
    const isFirstPara = idx === 0 && t.type === 'paragraph';
    if (t.type === 'paragraph' && !loose) {
      out += (isFirstPara && item.task ? checkboxHtml(item.checked) : '') +
        renderInline(t.text, state);
    } else if (isFirstPara && item.task) {
      out += '<p>' + checkboxHtml(item.checked) + renderInline(t.text, state) + '</p>\n';
    } else {
      out += renderToken(t, state);
    }
  });
  return out;
}

function checkboxHtml(checked) {
  return checked
    ? '<input checked="" disabled="" type="checkbox"> '
    : '<input disabled="" type="checkbox"> ';
}

function renderTokens(tokens, state) {
  let out = '';
  for (const t of tokens) out += renderToken(t, state);
  return out;
}

// ------------------------------------------------------------------ entry

export function parse(markdown) {
  const state = { links: new Map(), inLink: false, top: true };
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const tokens = lexBlocks(src, state);
  return renderTokens(tokens, state);
}
