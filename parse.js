// parse.js — a from-scratch Markdown parser (no dependencies) that renders
// HTML byte-for-byte the way marked 18.1.3 does with default options
// (gfm: true, breaks: false, pedantic: false), including its departures
// from the CommonMark / GFM specs.
//
// Structure: a line-based block parser builds a small node tree while
// collecting link reference definitions; a scanner-based inline parser
// then renders each block's text. Written for the markdown-render-speed-02
// make.fun entry.

// ---------------------------------------------------------------- helpers

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape for ordinary text and attribute values: < > " ' are always
// escaped; & is escaped unless it begins an entity-shaped sequence
// (&#123; / &#x1F; / &name;) which passes through untouched.
const ESCAPE_RE = /[<>"']|&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);)/g;
function escapeHtml(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(ESCAPE_RE, (c) => ESC_MAP[c]);
}

// Escape used for code content: every special char is escaped, & included.
const ESCAPE_ALL_RE = /[&<>"']/g;
function escapeCode(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(ESCAPE_ALL_RE, (c) => ESC_MAP[c]);
}

// Percent-encode a URL the way encodeURI does (which is what marked's
// cleanUrl boils down to for the inputs it accepts): the unreserved set
// below stays raw, everything else becomes UTF-8 %XX with uppercase hex.
const URL_SAFE = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'();/?:@&=+$#,%"
);
function cleanUrl(href) {
  let out = '';
  for (const ch of href) {
    if (URL_SAFE.has(ch)) { out += ch; continue; }
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      out += '%' + cp.toString(16).toUpperCase().padStart(2, '0');
    } else {
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

// Resolve backslash escapes of ASCII punctuation in a raw fragment
// (used for link destinations and titles).
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
function resolveEscapes(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// A numeric character reference at position i of s, or null.
// Valid forms: &# + 1-7 digits + ;  or  &#x/X + 1-6 hex digits + ;
function numericRefAt(s, i) {
  if (s.charCodeAt(i) !== 38 || s[i + 1] !== '#') return null; // &
  let j = i + 2;
  let cp;
  if (s[j] === 'x' || s[j] === 'X') {
    let k = j + 1;
    let hex = '';
    while (k < s.length && hex.length < 7 && /[0-9a-fA-F]/.test(s[k])) { hex += s[k]; k++; }
    if (hex.length === 0 || hex.length > 6 || s[k] !== ';') return null;
    cp = parseInt(hex, 16);
    j = k + 1;
  } else {
    let digits = '';
    while (j < s.length && digits.length < 8 && s[j] >= '0' && s[j] <= '9') { digits += s[j]; j++; }
    if (digits.length === 0 || digits.length > 7 || s[j] !== ';') return null;
    cp = parseInt(digits, 10);
    j++;
  }
  return { end: j, cp };
}

// The text-token transform marked applies while lexing inline text:
// when (and only when) a run of plain text contains a numeric character
// reference, the references are decoded to their characters (invalid
// code points become U+FFFD, and &#38; becomes the literal text "&amp;"),
// and any other "&" that starts an underscore-bearing entity-like
// sequence positioned after the first reference is escaped to &amp;.
function transformText(raw) {
  let firstRefEnd = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '&') {
      const r = numericRefAt(raw, i);
      if (r) { firstRefEnd = r.end; break; }
    }
  }
  if (firstRefEnd === -1) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c !== '&') { out += c; i++; continue; }
    const r = numericRefAt(raw, i);
    if (r) {
      if (r.cp === 38) out += '&amp;';
      else if (r.cp === 0 || r.cp > 0x10FFFF || (r.cp >= 0xD800 && r.cp <= 0xDFFF)) out += '\uFFFD';
      else out += String.fromCodePoint(r.cp);
      i = r.end;
      continue;
    }
    // entity-shaped sequence?
    let j = i + 1;
    while (j < raw.length && /[A-Za-z0-9_]/.test(raw[j])) j++;
    if (j > i + 1 && raw[j] === ';') {
      const name = raw.slice(i + 1, j);
      if (/^[A-Za-z0-9]+$/.test(name)) {
        out += raw.slice(i, j + 1); // clean entity name: passes through
      } else if (i >= firstRefEnd) {
        out += '&amp;' + raw.slice(i + 1, j + 1); // underscore form after a ref
      } else {
        out += raw.slice(i, j + 1);
      }
      i = j + 1;
      continue;
    }
    out += '&';
    i++;
  }
  return out;
}

// Character classification helpers for the inline parser.
const WS_RE = /\s/;
function isWs(ch) { return ch === undefined || WS_RE.test(ch); }
const PUNCT_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
function isPunct(ch) { return ch !== undefined && PUNCT_RE.test(ch); }

// Normalize a link label for definition lookup: case-insensitive, runs of
// whitespace collapse to a single space.
function normalizeLabel(s) {
  // marked's label fold: trim, collapse whitespace, and a
  // lower->upper->lower round trip (folds ß/ẞ to ss, ligatures, ...)
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}


// ---------------------------------------------------------------- inline
//
// The inline parser scans a block's text once, building a flat node list.
// Emphasis is resolved afterwards with the usual delimiter-stack pass;
// links and images are formed when a ']' is reached, using a bracket
// stack. Node kinds:
//   text  { s }                          plain text (entity transform applied)
//   esc   { s }                          one backslash-escaped char
//   raw   { s, plain }                   finished html (code span, autolink, tag, <br>)
//   delim { ch, len, canOpen, canClose } an unmatched * or _ run
//   bopen { s }                          a literal '[' or '![' that may still form a link
//   wrap  { tag, kids }                  em / strong / del
//   link  { href, title, kids }
//   image { href, title, alt }

function renderInlineNodes(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.k) {
      case 'text': out += escapeHtml(n.s); break;
      case 'esc': out += escapeCode(n.s); break;
      case 'raw': out += n.s; break;
      case 'delim': out += n.ch.repeat(n.len); break;
      case 'bopen': out += n.s; break;
      case 'wrap': out += '<' + n.tag + '>' + renderInlineNodes(n.kids) + '</' + n.tag + '>'; break;
      case 'link':
        out += '<a href="' + escapeHtml(n.href) + '"';
        if (n.title !== null) out += ' title="' + escapeHtml(n.title) + '"';
        out += '>' + renderInlineNodes(n.kids) + '</a>';
        break;
      case 'image':
        out += '<img src="' + escapeHtml(n.href) + '" alt="' + escapeHtml(n.alt) + '"';
        if (n.title !== null) out += ' title="' + escapeHtml(n.title) + '"';
        out += '>';
        break;
    }
  }
  return out;
}

// marked's link/reflink tokenizers match the bracketed text with a
// restrictive pattern: units are bracket groups (one nesting level,
// backticks ordinary inside), escape pairs, pseudo code spans (a
// backtick run, non-backtick content, a closing run of ANY length),
// a trailing backtick run, or any char but [ ] \ and backtick.
// A double-backtick span containing single backticks is NOT a unit.
function validLinkText(T) {
  let i = 0;
  while (i < T.length) {
    const c = T[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') {
      i++;
      let ok = false;
      while (i < T.length) {
        const d = T[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') {
          i++;
          let innerOk = false;
          while (i < T.length) {
            const e = T[i];
            if (e === '\\') { i += 2; continue; }
            if (e === ']') { innerOk = true; i++; break; }
            if (e === '[') return false;
            i++;
          }
          if (!innerOk) return false;
          continue;
        }
        if (d === ']') { ok = true; i++; break; }
        i++;
      }
      if (!ok) return false;
      continue;
    }
    if (c === ']') return false;
    if (c === '`') {
      let run = 0;
      while (T[i + run] === '`') run++;
      if (i + run === T.length) { i = T.length; continue; }
      let p = i + run;
      while (p < T.length && T[p] !== '`') p++;
      if (p === T.length) return false;
      let run2 = 0;
      while (T[p + run2] === '`') run2++;
      i = p + run2;
      continue;
    }
    i++;
  }
  return true;
}

// marked's nolink (shortcut reference) text pattern: escape pairs
// or any chars but brackets/backslash/newline, with newlines never
// followed by a blank line; the text may not be all whitespace.
function validNolinkText(T) {
  if (T.length === 0 || !/\S/.test(T)) return false;
  let i = 0;
  while (i < T.length) {
    const c = T[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[' || c === ']') return false;
    if (c === '\n') {
      let j = i + 1;
      while (T[j] === ' ' || T[j] === '\t') j++;
      if (T[j] === '\n') return false;
    }
    i++;
  }
  return true;
}

// Does a node list contain a link node anywhere inside it?
function kidsContainLink(nodes) {
  for (const n of nodes) {
    if (n.k === 'link') return true;
    if (n.kids && kidsContainLink(n.kids)) return true;
  }
  return false;
}

function plainOfNodes(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.k) {
      case 'text': out += n.s; break;
      case 'esc': out += n.s; break;
      case 'raw': out += n.plain; break;
      case 'delim': out += n.ch.repeat(n.len); break;
      case 'bopen': out += n.s; break;
      case 'wrap': out += plainOfNodes(n.kids); break;
      case 'link': out += plainOfNodes(n.kids); break;
      case 'image': out += n.alt; break;
    }
  }
  return out;
}

// --- pieces used by the scanner ---

const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const COMMENT_RE = /^<!--(?:-?>|[\s\S]*?-->)/;
const TAG_OPEN_RE = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/;
const TAG_CLOSE_RE = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/;
const PI_RE = /^<\?[\s\S]*?\?>/;
const DECL_RE = /^<![a-zA-Z]+[\s\S]*?>/;
const CDATA_RE = /^<!\[CDATA\[[\s\S]*?\]\]>/;

const EMAIL_RE = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const PROTOCOL_RE = /^(?:https?|ftp):\/\//i;

// Try to match an inline HTML construct at src[i] === '<'.
// Returns { html, len } or null.
function matchHtmlAt(src, i) {
  const rest = src.slice(i);
  let m = AUTOLINK_RE.exec(rest);
  if (m) {
    const text = m[1];
    const isEmail = !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(text);
    const href = isEmail ? 'mailto:' + text : cleanUrl(text);
    return {
      node: { k: 'raw', s: '<a href="' + escapeHtml(href) + '">' + escapeHtml(text) + '</a>', plain: text },
      len: m[0].length,
    };
  }
  for (const re of [COMMENT_RE, TAG_CLOSE_RE, TAG_OPEN_RE, PI_RE, CDATA_RE, DECL_RE]) {
    m = re.exec(rest);
    if (m) return { node: { k: 'raw', s: m[0], plain: '' }, len: m[0].length };
  }
  return null;
}

// Parse the "( destination "title" )" part of an inline link starting at
// src[i] === '('. Returns { href, title, end } (end = index past ')') or null.
function parseLinkDest(src, i) {
  let p = i + 1;
  while (p < src.length && (src[p] === ' ' || src[p] === '\t' || src[p] === '\n')) p++;
  let dest = null;
  let afterDest = -1;
  if (src[p] === '<') {
    // angle destination: no newline, no unescaped < or >
    let j = p + 1;
    let ok = false;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '>') { ok = true; break; }
      if (c === '<' || c === '\n') break;
      j++;
    }
    if (!ok) return null;
    dest = src.slice(p + 1, j);
    afterDest = j + 1;
  } else {
    // bare destination: a sequence of units — escape pairs, balanced
    // (possibly nested, possibly empty) paren groups, and plain chars
    // other than parens/whitespace. Candidate ends are the positions
    // with paren depth 0, tried longest first (regex backtracking).
    const ends = [];
    let j = p;
    let depth = 0;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\' && j + 1 < src.length && src[j + 1] !== '\n') {
        j += 2;
        if (depth === 0) ends.push(j);
        continue;
      }
      if (c === '(') { depth++; j++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--;
        j++;
        if (depth === 0) ends.push(j);
        continue;
      }
      if (c <= ' ' || c === '\x7f') break;
      j++;
      if (depth === 0) ends.push(j);
    }
    for (let e = ends.length - 1; e >= 0; e--) {
      const tail = matchLinkTail(src, ends[e]);
      if (tail) {
        return { href: src.slice(p, ends[e]), title: tail.title, end: tail.end };
      }
    }
    const tail0 = matchLinkTail(src, p);
    if (tail0) return { href: '', title: tail0.title, end: tail0.end };
    return null;
  }
  const tail = matchLinkTail(src, afterDest);
  if (!tail) return null;
  return { href: dest, title: tail.title, end: tail.end };
}

// Match the part after a link destination: optional whitespace, an
// optional title (which needs a whitespace separator before it), more
// optional whitespace, and the closing ')'. src[i] is just past the dest.
function matchLinkTail(src, i) {
  let p = i;
  let sawWs = false;
  while (p < src.length && (src[p] === ' ' || src[p] === '\t' || src[p] === '\n')) { p++; sawWs = true; }
  if (src[p] === ')') return { title: null, end: p + 1 };
  if (!sawWs) return null;
  const q = src[p];
  let title = null;
  let after = -1;
  if (q === '"' || q === "'") {
    let j = p + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === q) { after = j + 1; break; }
      if (q === '"' && src[j] === '\n' && src[j + 1] === '\n') return null;
      j++;
    }
    if (after === -1) return null;
    title = src.slice(p + 1, after - 1);
  } else if (q === '(') {
    let j = p + 1;
    let ok = false;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '(') return null;
      if (src[j] === ')') { ok = true; break; }
      j++;
    }
    if (!ok) return null;
    title = src.slice(p + 1, j);
    after = j + 1;
  } else {
    return null;
  }
  let r = after;
  while (r < src.length && (src[r] === ' ' || src[r] === '\t' || src[r] === '\n')) r++;
  if (src[r] !== ')') return null;
  return { title, end: r + 1 };
}

// Scan a reference label starting just after '[' at src[i]; returns
// { label, end } where end is just past the closing ']', or null.
function scanRefLabel(src, i) {
  let j = i;
  while (j < src.length && j - i <= 999) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return { label: src.slice(i, j), end: j + 1 };
    j++;
  }
  return null;
}

// Try a GFM bare autolink (protocol URL, www. URL, email) at src[i].
// kind: 'url' | 'email'. Returns { text, href, len } or null.
function matchBareAutolink(src, i, prevChar) {
  const rest = src.slice(i);
  let m = PROTOCOL_RE.exec(rest);
  if (m) {
    // domain: (label + optional dot)+ then everything up to ws or '<'
    let j = m[0].length;
    let labels = 0;
    while (j < rest.length) {
      let k = j;
      while (k < rest.length && /[a-zA-Z0-9-]/.test(rest[k])) k++;
      if (k === j) break;
      labels++;
      j = k;
      if (rest[j] === '.') j++;
      else break;
    }
    if (labels === 0) return null;
    while (j < rest.length && !/[\s<]/.test(rest[j])) j++;
    let text = rest.slice(0, j);
    let prev;
    do {
      prev = text;
      const b = BACKPEDAL_RE.exec(text);
      text = b ? b[0] : '';
    } while (text !== prev && text !== '');
    if (text === '') return null;
    return { text, href: text, len: text.length };
  }
  if (rest.startsWith('www.') &&
      (prevChar === null || prevChar === ' ' || prevChar === '\t' || prevChar === '\n' ||
       prevChar === '(' || prevChar === '*' || prevChar === '_' || prevChar === '~' || WS_RE.test(prevChar))) {
    let j = 4;
    let labels = 0;
    while (j < rest.length) {
      let k = j;
      while (k < rest.length && /[a-zA-Z0-9-]/.test(rest[k])) k++;
      if (k === j) break;
      labels++;
      j = k;
      if (rest[j] === '.') j++;
      else break;
    }
    if (labels === 0) return null;
    while (j < rest.length && !/[\s<]/.test(rest[j])) j++;
    let text = rest.slice(0, j);
    let prev;
    do {
      prev = text;
      const b = BACKPEDAL_RE.exec(text);
      text = b ? b[0] : '';
    } while (text !== prev && text !== '');
    if (text === '') return null;
    return { text, href: 'http://' + text, len: text.length };
  }
  // email protocols
  if (rest.startsWith('mailto:') || rest.startsWith('xmpp:')) {
    const off = rest.indexOf(':') + 1;
    const em = EMAIL_RE.exec(rest.slice(off));
    if (em) {
      let text = rest.slice(0, off) + em[0];
      if (rest.startsWith('xmpp:')) {
        const extra = /^\/[A-Za-z0-9@.]+/.exec(rest.slice(text.length));
        if (extra) text += extra[0];
      }
      return { text, href: text, len: text.length };
    }
  }
  m = EMAIL_RE.exec(rest);
  if (m) return { text: m[0], href: 'mailto:' + m[0], len: m[0].length };
  return null;
}

// The inline scanner. Returns the node list for a block's text.
function inlineParse(src, refs, inLink) {
  const nodes = [];
  const brackets = [];
  let buf = '';
  // marked's fe() bound: the last index of a delimiter run of each
  // character whose preceding character is not whitespace — no closer
  // can start beyond it.
  const lastCloserIdx = { '*': -1, '_': -1 };
  // a character preceded by an odd run of backslashes is escaped
  // and invisible in marked's mask (it becomes '+')
  const masked = new Array(src.length).fill(false);
  {
    let bs = 0;
    for (let s = 0; s < src.length; s++) {
      if (bs % 2 === 1) masked[s] = true;
      bs = src[s] === '\\' ? bs + 1 : 0;
    }
  }
  // marked's inline mask, steps 2+3 (anyPunctuationOutsideCode and
  // blockSkip): code spans are located with the span pattern (a
  // backtick run, content whose ends are not backticks, a closing
  // run of the same length — escapes do not delimit); sanitizing
  // their interiors lets blockSkip hide whole link constructs, the
  // spans themselves, and HTML tags. Positions in a hidden region
  // are invisible to the emphasis scan. (Step 1, reflinkSearch, is
  // approximated by skipConstruct during the scan.)
  const hidden = new Uint8Array(src.length);
  {
    const spans = [];
    let j = 0;
    while (j < src.length) {
      if (src[j] === '\\' && j + 1 < src.length && isPunct(src[j + 1])) { j += 2; continue; }
      if (src[j] !== '`') { j++; continue; }
      let R = 0;
      while (src[j + R] === '`') R++;
      // the closing run is the first run of exactly R backticks:
      // the span pattern's content is [^`]-bounded only, so an
      // escaped backtick still closes the span in the mask
      let p = j + R;
      let closeEnd = -1;
      while (p < src.length) {
        if (src[p] === '`') {
          let R2 = 0;
          while (src[p + R2] === '`') R2++;
          if (R2 === R) { closeEnd = p + R2; break; }
          p += R2;
          continue;
        }
        p++;
      }
      if (closeEnd === -1) { j += R; continue; }
      spans.push([j, closeEnd]);
      j = closeEnd;
    }
    const spanAt = new Map(spans.map(([a, b]) => [a, b]));
    let k = 0;
    while (k < src.length) {
      const ck = src[k];
      if (ck === '\\' && k + 1 < src.length && isPunct(src[k + 1])) { k += 2; continue; }
      if (spanAt.has(k)) { const e = spanAt.get(k); hidden.fill(1, k, e); k = e; continue; }
      if (ck === '<' && src[k + 1] !== ' ') {
        let e = k + 1;
        while (e < src.length && src[e] !== '<' && src[e] !== '>') e++;
        if (src[e] === '>') { hidden.fill(1, k, e + 1); k = e + 1; continue; }
        k++;
        continue;
      }
      if (ck === '[' || (ck === '!' && src[k + 1] === '[')) {
        let e = k + (ck === '!' ? 2 : 1);
        let ok = false;
        while (e < src.length) {
          if (spanAt.has(e)) { e = spanAt.get(e); continue; }
          const ce = src[e];
          if (ce === ']') { ok = true; break; }
          if (ce === '[' || ce === '`') break;
          e++;
        }
        if (ok && src[e + 1] === '(') {
          let depth = 0;
          let d = e + 1;
          let done = -1;
          while (d < src.length) {
            const cd = src[d];
            if (cd === '\\') { d += 2; continue; }
            if (cd === '(') { depth++; if (depth > 2) break; }
            else if (cd === ')') { depth--; if (depth === 0) { done = d + 1; break; } }
            d++;
          }
          if (done !== -1) { hidden.fill(1, k, done); k = done; continue; }
        }
        k++;
        continue;
      }
      k++;
    }
  }
  for (let s = 0; s < src.length; s++) {
    const ch = src[s];
    if ((ch !== '*' && ch !== '_') || masked[s] || hidden[s]) continue;
    const pv = s === 0 ? '\n' : (masked[s - 1] ? '+' : hidden[s - 1] ? ']' : src[s - 1]);
    let e = s + 1;
    while (e < src.length && src[e] === ch && !masked[e] && !hidden[e]) e++;
    if (!isWs(pv)) lastCloserIdx[ch] = s;
    s = e - 1;
  }

  const flush = () => {
    if (buf !== '') {
      // inside a <pre>/<code>/<kbd>/<script> inline span, marked's
      // text tokens render raw (no escaping, no entity transform)
      nodes.push({ k: 'text', s: S.inRawBlock ? buf : transformText(buf) });
      buf = '';
    }
  };
  // The character a GFM "www." autolink would see right before the current
  // position: the last text character scanned, a bracket char, or null
  // when a finished construct (code span, link, tag...) precedes —
  // marked restarts its source string there, so www. fires freely.
  const prevSignificantChar = () => {
    if (buf !== '') return buf[buf.length - 1];
    const last = nodes[nodes.length - 1];
    if (!last) return null;
    if (last.k === 'bopen') return '[';
    if (last.k === 'text') return last.s.length ? last.s[last.s.length - 1] : null;
    return null;
  };

  // Find the ']' matching the bracket whose text starts at `from`,
  // counting nested brackets (code spans and escapes skipped).
  const findMatchingClose = (from) => {
    let depth = 1;
    let j = from;
    while (j < src.length) {
      const cj = src[j];
      if (cj === '\\') { j += 2; continue; }
      if (cj === '`') {
        // a pseudo code span in marked's link-text pattern: a
        // backtick run, non-backtick content, a closing run of any
        // length — brackets inside it do not count
        let bl = 0;
        while (src[j + bl] === '`') bl++;
        let r2 = j + bl;
        while (r2 < src.length && src[r2] !== '`') r2++;
        if (r2 >= src.length) { j += bl; continue; }
        let l2 = 0;
        while (src[r2 + l2] === '`') l2++;
        j = r2 + l2;
        continue;
      }
      if (cj === '[') depth++;
      else if (cj === ']') { depth--; if (depth === 0) return j; }
      j++;
    }
    return -1;
  };

  // Would the given open bracket form a link at closeIdx?
  // Mirrors tryFormLink's decision without mutating anything,
  // including the rejection when a link already formed inside.
  const wouldFormAt = (top, closeIdx) => {
    if (!top || top.inactive) return false;
    const text = src.slice(top.textStart, closeIdx);
    const textValid = validLinkText(text);
    let forms = false;
    if (src[closeIdx + 1] === '(' && textValid) {
      if (parseLinkDest(src, closeIdx + 1)) forms = true;
    }
    if (!forms && src[closeIdx + 1] === '[' && textValid) {
      const lab = scanRefLabel(src, closeIdx + 2);
      if (lab) {
        const labelText = lab.label === '' ? text : lab.label;
        forms = refs.has(normalizeLabel(labelText));
      }
    }
    if (!forms) {
      forms = text.length <= 999 && validNolinkText(text) && refs.has(normalizeLabel(text));
    }
    if (!forms) return false;
    if (!top.isImage) {
      const nIdx = nodes.indexOf(top.node);
      if (nIdx !== -1 && kidsContainLink(nodes.slice(nIdx + 1))) return false;
    }
    return true;
  };
  const linkWouldForm = (closeIdx) => wouldFormAt(brackets[brackets.length - 1], closeIdx);

  // Is the scan currently inside the text of a bracket that will
  // form a link/image? marked lexes such text separately with
  // inLink set: bare autolinks are suppressed there, emphasis may
  // not cross its ']', and tag-state mutations are rolled back.
  const insideFormingBracket = () => {
    for (let b = brackets.length - 1; b >= 0; b--) {
      const closeIdx = findMatchingClose(brackets[b].textStart);
      if (closeIdx !== -1 && wouldFormAt(brackets[b], closeIdx)) return true;
    }
    return false;
  };

  // The innermost bracket that will form a link/image, with the
  // index of its ']': forward searches (code spans, strikethrough,
  // emphasis) may not cross that ']' because marked lexes the text
  // as its own string. Null when no enclosing bracket forms.
  const formingRegion = () => {
    for (let b = brackets.length - 1; b >= 0; b--) {
      const closeIdx = findMatchingClose(brackets[b].textStart);
      if (closeIdx !== -1 && wouldFormAt(brackets[b], closeIdx)) return closeIdx;
    }
    return null;
  };
  // The text start of the innermost bracket that will form (the
  // region paired with formingRegion's close index).
  const formingRegionStart = () => {
    for (let b = brackets.length - 1; b >= 0; b--) {
      const closeIdx = findMatchingClose(brackets[b].textStart);
      if (closeIdx !== -1 && wouldFormAt(brackets[b], closeIdx)) return brackets[b].textStart;
    }
    return 0;
  };
  // In a region-confined scan, marked's recursion masks the region
  // text on its own: only mask intervals fully inside the region
  // stay hidden there; an interval that contains the region (the
  // outer construct itself) or crosses its edge does not hide.
  const hiddenInRegion = (q, regionStart, limit) => {
    if (!hidden[q]) return false;
    if (limit >= src.length) return true;
    let hs = q;
    while (hs > 0 && hidden[hs - 1]) hs--;
    let he = q;
    while (he < src.length && hidden[he]) he++;
    return hs >= regionStart && he <= limit;
  };

  // When no enclosing bracket forms but one's construct is hidden
  // by marked's emStrong mask (a blockSkip link shape or a defined
  // reference construct), an emphasis scan starting inside it
  // resumes only after the construct's end. Returns 0 if none.
  const maskResumeAt = (pos) => {
    if (hidden[pos]) {
      let e = pos;
      while (e < src.length && hidden[e]) e++;
      return e;
    }
    for (let b = brackets.length - 1; b >= 0; b--) {
      const top = brackets[b];
      const start = top.textStart - (top.isImage ? 2 : 1);
      const end = skipConstruct(start);
      if (end !== -1) return end;
    }
    return 0;
  };

  // marked's tag tokenizer mutates document-level lexer state:
  // an <a ...> start tag sets inLink (suppressing bare autolinks)
  // until a </a> end tag, and <pre>/<code>/<kbd>/<script> spans
  // switch text to raw rendering. The link-text lexing saves and
  // restores inLink, so a tag inside a bracket that will form a
  // link has no lasting effect; raw-block state is never restored.
  const applyTagState = (tagText) => {
    if (!S.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tagText)) S.inRawBlock = true;
    else if (S.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tagText)) S.inRawBlock = false;
    if (insideFormingBracket()) return;
    if (!S.inLinkTag && /^<a /i.test(tagText)) S.inLinkTag = true;
    else if (S.inLinkTag && /^<\/a>/i.test(tagText)) S.inLinkTag = false;
  };

  // Attempt to close the innermost open bracket at src[closeIdx] === ']'.
  // Returns the index scanning should continue from, or -1 if no
  // link/image was formed (the caller then emits ']' as text).
  const tryFormLink = (closeIdx) => {
    const top = brackets[brackets.length - 1];
    if (top.inactive) { brackets.pop(); return -1; }
    flush();
    let href = null;
    let title = null;
    let end = -1;
    const text = src.slice(top.textStart, closeIdx);
    const textValid = validLinkText(text);
    if (src[closeIdx + 1] === '(' && textValid) {
      const d = parseLinkDest(src, closeIdx + 1);
      if (d) {
        href = cleanUrl(resolveEscapes(d.href));
        title = d.title === null ? null : resolveEscapes(d.title);
        end = d.end;
      }
    }
    if (end === -1 && src[closeIdx + 1] === '[' && textValid) {
      const lab = scanRefLabel(src, closeIdx + 2);
      if (lab) {
        const labelText = lab.label === '' ? text : lab.label;
        const def = refs.get(normalizeLabel(labelText));
        if (def) { href = def.href; title = def.title; end = lab.end; }
        else { brackets.pop(); return -1; } // well-formed but undefined: no link
      }
    }
    if (end === -1) {
      // shortcut reference: the nolink text pattern applies instead
      if (text.length <= 999 && validNolinkText(text)) {
        const def = refs.get(normalizeLabel(text));
        if (def) { href = def.href; title = def.title; end = closeIdx + 1; }
      }
    }
    if (end === -1) { brackets.pop(); return -1; }
    // Form the link/image out of everything after the opening bracket.
    const bIdx = brackets.indexOf(top);
    const nIdx = nodes.indexOf(top.node);
    if (!top.isImage && kidsContainLink(nodes.slice(nIdx + 1))) {
      // marked rejects a link whose text emitted a link token
      brackets.pop();
      return -1;
    }
    const kids = nodes.splice(nIdx + 1);
    nodes.pop(); // drop the bracket node itself
    brackets.length = bIdx;
    if (top.isImage) {
      nodes.push({ k: 'image', href, title, alt: plainOfNodes(kids) });
    } else {
      nodes.push({ k: 'link', href, title, kids });
      // A formed link deactivates every earlier link opener.
      for (const b of brackets) if (!b.isImage) b.inactive = true;
    }
    return end;
  };

  // marked's inline mask hides whole link constructs and HTML
  // tags from the delimiter scan: skip them like code spans.
  const skipConstruct = (q0) => {
    if (src[q0] === '<') {
      if (src[q0 + 1] === ' ') return -1;
      let j = q0 + 1;
      while (j < src.length && src[j] !== '<' && src[j] !== '>') j++;
      return src[j] === '>' ? j + 1 : -1;
    }
    // '[' or '![': first the inline shape [text](dest), whose
    // text has no nested brackets (marked's blockSkip mask)
    const textStart = q0 + (src[q0] === '!' ? 2 : 1);
    let j = textStart;
    let inlineOk = true;
    while (j < src.length) {
      const cj = src[j];
      // (no escape handling: in marked's mask the text part of a
      // skipped construct treats backslashes as ordinary chars)
      if (cj === '`') {
        let bl = 0;
        while (src[j + bl] === '`') bl++;
        let r2 = j + bl;
        let closed = -1;
        while (r2 < src.length) {
          if (src[r2] === '`') {
            let l2 = 0;
            while (src[r2 + l2] === '`') l2++;
            if (l2 === bl) { closed = r2 + l2; break; }
            r2 += l2;
          } else r2++;
        }
        if (closed === -1) { inlineOk = false; break; }
        j = closed;
        continue;
      }
      if (cj === ']') break;
      if (cj === '[') { inlineOk = false; break; }
      j++;
    }
    if (inlineOk && src[j] === ']' && src[j + 1] === '(') {
      let depth = 0;
      let k = j + 1;
      while (k < src.length) {
        const ck = src[k];
        if (ck === '\\') { k += 2; continue; }
        if (ck === '(') { depth++; if (depth > 2) return -1; }
        else if (ck === ')') { depth--; if (depth === 0) return k + 1; }
        k++;
      }
      return -1;
    }
    // reference shapes (marked's reflinkSearch mask): a defined
    // full/collapsed ref hides the whole construct when its text
    // holds no link, and only the label otherwise; a defined
    // shortcut ref hides the whole bracket
    const closeIdx = findMatchingClose(textStart);
    if (closeIdx === -1) return -1;
    const text = src.slice(textStart, closeIdx);
    if (src[closeIdx + 1] === '[') {
      const lab = scanRefLabel(src, closeIdx + 2);
      if (!lab) return -1;
      const labelText = lab.label === '' ? text : lab.label;
      if (!refs.has(normalizeLabel(labelText))) return -1;
      return /\]\[|\]\(/.test(text) ? closeIdx + 1 : lab.end;
    }
    if (src[closeIdx + 1] === '(') return -1;
    return refs.has(normalizeLabel(text)) ? closeIdx + 1 : -1;
  };

  // Attempt a strikethrough span at src[i] === '~' with the given run
  // length (1 or 2). Returns the index past the closer, or -1.
  const tryDel = (i, run, limit) => {
    if (run > 2) return -1;
    const dEnd = limit;
    const dStart = limit < src.length ? formingRegionStart() : 0;
    const after = src[i + run];
    if (after === undefined || after === '~' || isWs(after)) return -1;
    // scan for the matching closer, tracking nested same-length
    // spans: a run that can close decrements the depth, a run that
    // can only open increments it.
    let depth = 1;
    let p = i + run;
    while (p < limit) {
      const idx = src.indexOf('~', p);
      if (idx === -1 || idx >= limit) return -1;
      let rl = 0;
      while (src[idx + rl] === '~') rl++;
      if (hiddenInRegion(idx, dStart, dEnd)) { p = idx + rl; continue; }
      // an odd run of backslashes escapes only the first tilde
      // (the mask turns the pair into '++'); the rest of the run
      // still counts, with the escape as its preceding character
      let bs = 0;
      let q = idx - 1;
      while (q >= 0 && src[q] === '\\') { bs++; q--; }
      let rStart = idx;
      let rLen = rl;
      let prevOverride = null;
      if (bs % 2 === 1) { rStart = idx + 1; rLen = rl - 1; prevOverride = '+'; }
      if (rLen <= 0) { p = idx + rl; continue; }
      if (rLen === run) {
        const prevCh = prevOverride !== null ? prevOverride : src[rStart - 1];
        const nextCh = src[idx + rl];
        const canClose = prevCh !== undefined && !isWs(prevCh) && prevCh !== '~';
        const canOpen = nextCh !== undefined && !isWs(nextCh) && nextCh !== '~';
        if (canClose) {
          depth--;
          if (depth === 0) {
            flush();
            const kids = inlineParse(src.slice(i + run, rStart), refs, inLink || insideFormingBracket());
            nodes.push({ k: 'wrap', tag: 'del', kids });
            return idx + rl;
          }
        } else if (canOpen) {
          depth++;
        }
      }
      p = idx + rl;
    }
    return -1;
  };

  // marked's emStrong tokenizer, reimplemented: at a delimiter run,
  // scan forward over runs of the same character with a balance
  // counter. A run preceded by whitespace is an opener (balance
  // grows); a right-flanking run is a closer; a run that can do both
  // first faces the rule of three (skipped lengths accumulate in f).
  // The span closes when the balance reaches zero; an odd minimum
  // of opener/closer lengths makes an <em>, an even one a <strong>.
  const tryEmStrongAt = (i, ch, oFlag, limit, resume, regionStart) => {
    let runStart = i;
    while (runStart > 0 && src[runStart - 1] === ch) runStart--;
    let L = 0;
    while (src[i + L] === ch) L++;
    const nextCh = charAfter(src, i + L);
    if (nextCh === undefined || isWs(nextCh)) return null;
    const prevCh = runStart > 0 ? charBefore(src, runStart) : '';
    // the run must be left-flanking to open
    if (isPunct(nextCh) && prevCh !== '' && !isWs(prevCh) && !isPunct(prevCh)) return null;
    if (ch === '_') {
      // an intraword _ run with an alphanumeric before it cannot open
      if (prevCh !== '' && ALNUM_RE.test(prevCh) && !isPunct(nextCh)) return null;
    }
    const p = prevCh;
    const h = p !== '' && (isPunct(p) || p === '*' || p === '_');
    const d = isPunct(nextCh) && nextCh !== '~' ? nextCh : '';
    const R = p !== '' && !isWs(p) && (d !== '' || (ch === '*' && !h));
    const y = (i - runStart) + L;
    const bound = lastCloserIdx[ch];
    let m = L;
    let f = 0;
    let q = i + L;
    // an opener inside a mask-hidden construct resumes after it
    if (resume > q) q = resume;
    // The RDelim regex's first alternative hides a delimiter of this
    // character sitting between two runs of the other character
    // (__ ... * ... __ when scanning for *, and vice versa).
    if (q === i + L) {
      const och = ch === '*' ? '_' : '*';
      const segEnd = (from) => {
        let j = from;
        while (j < src.length && src[j] !== ch && src[j] !== och) { if (src[j] === '\\') j++; j++; }
        return j;
      };
      const j = segEnd(q);
      if (src[j] === och && src[j + 1] === och && src[j + 2] !== och) {
        const k = segEnd(j + 2);
        if (src[k] === ch && src[k + 1] !== ch) {
          const l = segEnd(k + 1);
          if (src[l] === och && src[l + 1] === och) q = l;
        }
      }
    }
    while (q < limit) {
      if (hiddenInRegion(q, regionStart, limit)) { q++; continue; }
      const qc = src[q];
      if (qc === '\\') { q += 2; continue; }
      if (qc === '[' || qc === '<' || (qc === '!' && src[q + 1] === '[')) {
        const sk = skipConstruct(q);
        if (sk !== -1) { q = sk; continue; }
        q++;
        continue;
      }
      if (qc === '`') {
        // skip a code span: its delimiters are masked in marked
        let bl = 0;
        while (src[q + bl] === '`') bl++;
        let r2 = q + bl;
        let closed = -1;
        while (r2 < src.length) {
          if (src[r2] === '`') {
            let l2 = 0;
            while (src[r2 + l2] === '`') l2++;
            if (l2 === bl) { closed = r2 + l2; break; }
            r2 += l2;
          } else r2++;
        }
        q = closed === -1 ? q + bl : closed;
        continue;
      }
      if (qc !== ch) { q++; continue; }
      let b = 0;
      while (src[q + b] === ch && !hiddenInRegion(q + b, regionStart, limit)) b++;
      if (limit >= src.length && q > bound) break;
      const pb = charBefore(src, q);
      const na = charAfter(src, q + b);
      // classify the run by its neighbours (marked's RDelim
      // alternatives): a left-flanking-only run is a nested opener;
      // a right-flanking-only run is a closer; a run that flanks
      // both ways is gated by the rule of three. "~" counts as a
      // word character here, as in the (?:[^\s\p{P}\p{S}]|~) groups.
      // A neighbour inside a mask-hidden region reads as the
      // region's bracket char (punctuation) in the mask.
      let pbCls = isWs(pb) ? 0 : (pb === '~' ? 2 : (isPunct(pb) ? 1 : 2));
      let naCls = na === undefined || isWs(na) ? 0 : (na === '~' ? 2 : (isPunct(na) ? 1 : 2));
      if (q > 0 && hiddenInRegion(q - 1, regionStart, limit)) pbCls = 1;
      if (q + b < src.length && hiddenInRegion(q + b, regionStart, limit)) naCls = 1;
      if (naCls !== 0 && (pbCls === 0 || (pbCls === 1 && naCls === 2))) {
        m += b;
        q += b;
        continue;
      }
      if (naCls === 0 && pbCls === 0) { q += b; continue; }
      // a word-flanked _ run matches no RDelim alternative at all:
      // it is invisible to the scan (marked's intraword _ rule)
      if (pbCls === 2 && naCls === 2 && ch === '_') { q += b; continue; }
      const gated = (pbCls === 1 && naCls === 1) || (pbCls === 2 && naCls === 2);
      if (gated && oFlag) break;
      if ((gated || R) && y % 3 !== 0 && (y + b) % 3 === 0) { f += b; q += b; continue; }
      m -= b;
      if (m > 0) { q += b; continue; }
      const used = Math.min(b, b + m + f);
      const isEm = Math.min(L, used) % 2 === 1;
      const inner = isEm ? src.slice(i + 1, q + used - 1) : src.slice(i + 2, q + used - 2);
      // an emphasis span inside a forming link's text is lexed by
      // marked in the link's recursion (inLink set): bare
      // autolinks stay suppressed in the inner string too
      const kids = inlineParse(inner, refs, inLink || insideFormingBracket());
      return { node: { k: 'wrap', tag: isEm ? 'em' : 'strong', kids }, end: q + used };
    }
    return null;
  };

  let i = 0;
  const len = src.length;
  while (i < len) {
    const c = src[i];

    if (c === '\\') {
      const n = src[i + 1];
      if (n === '\n') {
        flush();
        nodes.push({ k: 'raw', s: '<br>', plain: '' });
        i += 2;
        while (src[i] === ' ' || src[i] === '\t') i++;
        continue;
      }
      if (n !== undefined && ASCII_PUNCT.has(n)) {
        flush();
        nodes.push({ k: 'esc', s: n });
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    if (c === '`') {
      let run = 0;
      while (src[i + run] === '`') run++;
      // inside a forming bracket, marked lexes the text as its own
      // string: the closing run must lie inside the bracket's text
      const rEnd = brackets.length ? (formingRegion() ?? len) : len;
      let closeAt = -1;
      let j = i + run;
      while (j < rEnd) {
        if (src[j] === '`') {
          let r2 = 0;
          while (src[j + r2] === '`') r2++;
          if (r2 === run) { closeAt = j; break; }
          j += r2;
        } else j++;
      }
      if (closeAt === -1) { buf += '`'.repeat(run); i += run; continue; }
      let content = src.slice(i + run, closeAt).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ k: 'raw', s: '<code>' + escapeCode(content) + '</code>', plain: content });
      i = closeAt + run;
      continue;
    }

    if (c === '<') {
      const h = matchHtmlAt(src, i);
      if (h) {
        flush();
        applyTagState(src.slice(i, i + h.len));
        nodes.push(h.node);
        i += h.len;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    if (c === '!' && src[i + 1] === '[') {
      flush();
      const node = { k: 'bopen', s: '![' };
      nodes.push(node);
      brackets.push({ node, isImage: true, textStart: i + 2, inactive: false });
      i += 2;
      continue;
    }
    if (c === '[') {
      flush();
      const node = { k: 'bopen', s: '[' };
      nodes.push(node);
      brackets.push({ node, isImage: false, textStart: i + 1, inactive: false });
      i++;
      continue;
    }

    if (c === ']') {
      if (brackets.length) {
        const end = tryFormLink(i);
        if (end !== -1) { i = end; continue; }
      }
      buf += ']';
      i++;
      continue;
    }

    if (c === '*' || c === '_') {
      // Inside a bracket whose link will form, marked lexes the
      // text separately: an emphasis scan may not cross its ']'.
      // Inside a bracket whose construct is only hidden by the
      // mask, the scan resumes after the construct instead.
      let limit = src.length;
      let resume = 0;
      let regionStart = 0;
      if (brackets.length) {
        const fr = formingRegion();
        if (fr !== null) { limit = fr; regionStart = formingRegionStart(); }
        else resume = maskResumeAt(i);
      } else if (hidden[i]) {
        resume = maskResumeAt(i);
      }
      const res = tryEmStrongAt(i, c, prevSignificantChar() === c, limit, resume, regionStart);
      if (res) {
        flush();
        nodes.push(res.node);
        i = res.end;
        continue;
      }
      // no span opens here: one character becomes text and the rest
      // of the run is retried at the next position
      buf += c;
      i++;
      continue;
    }

    if (c === '~') {
      let run = 0;
      while (src[i + run] === '~') run++;
      const dEnd = brackets.length ? (formingRegion() ?? len) : len;
      const end = run <= 2 ? tryDel(i, run, dEnd) : -1;
      if (end !== -1) { i = end; continue; }
      buf += '~'.repeat(run);
      i += run;
      continue;
    }

    if (c === '\n') {
      let tsp = 0;
      while (tsp < buf.length && buf[buf.length - 1 - tsp] === ' ') tsp++;
      if (tsp >= 2) {
        buf = buf.slice(0, buf.length - tsp);
        flush();
        nodes.push({ k: 'raw', s: '<br>', plain: '' });
        i++;
        while (src[i] === ' ' || src[i] === '\t') i++;
        continue;
      }
      buf += '\n';
      i++;
      continue;
    }

    // GFM bare autolinks — suppressed inside the text of a bracket
    // that will form a link, and document-wide after an unclosed
    // <a ...> tag.
    if (!inLink && !S.inLinkTag && (brackets.length === 0 || !insideFormingBracket())) {
      const c0 = c;
      if (c0 === 'h' || c0 === 'H' || c0 === 'f' || c0 === 'F' || c0 === 'w' || c0 === 'm' || c0 === 'x' ||
          (LOCAL_START.test(c0) && (i === 0 || !LOCAL_START.test(src[i - 1])))) {
        const a = matchBareAutolink(src, i, prevSignificantChar());
        if (a) {
          flush();
          nodes.push({
            k: 'raw',
            s: '<a href="' + escapeHtml(cleanUrl(a.href)) + '">' + escapeHtml(a.text) + '</a>',
            plain: a.text,
          });
          i += a.len;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return nodes;
}

const LOCAL_START = /[A-Za-z0-9._+-]/;

// Full code point before index i (undefined at the start).
function charBefore(src, i) {
  if (i <= 0) return undefined;
  let at = i - 1;
  const cc = src.charCodeAt(at);
  if (cc >= 0xDC00 && cc <= 0xDFFF && at > 0) at--;
  return String.fromCodePoint(src.codePointAt(at));
}
function charAfter(src, i) {
  if (i >= src.length) return undefined;
  return String.fromCodePoint(src.codePointAt(i));
}

function parseInlineText(src, refs) {
  return renderInlineNodes(inlineParse(src, refs, false));
}

// ---------------------------------------------------------------- blocks
//
// A line-based container parser in the style of commonmark.js, adjusted
// for marked's observable departures (blank line ends a blockquote,
// lazy lines only continue paragraphs when they don't start an
// interrupting block, tables and setext headings never form from lazy
// lines, looseness follows marked's raw-text model, and so on).
//
// Block node shapes:
//   root/quote/list/item : { t, kids, parent }
//   para                 : { t:'para', lines:[..] }
//   head                 : { t:'head', level, text }
//   hr                   : { t:'hr' }
//   fence                : { t:'fence', info, comp, lines:[..] }
//   code                 : { t:'code', lines:[..] }   (indented)
//   html                 : { t:'html', ht, htag, lines:[..], trailNl }
//   table                : { t:'table', header:[..], aligns:[..], rows:[[..]] }
// list also: { ordered, start, marker }  item also: { padding, blankInSpan, childrenSeparated }

const S = {
  lines: [],
  refs: null,
  root: null,
  tip: null,
  lineIdx: 0,
  // cursor on the current line: char offset, visual column, and the
  // number of columns left in a partially consumed tab.
  off: 0, col: 0, partial: 0,
  // post-container-match snapshot of the cursor
  oOff: 0, oCol: 0, oPartial: 0,
  // next-nonspace scan results for the current cursor position
  nextOff: 0, nextCol: 0, blank: true, indent: 0,
  matchedContainer: null,
  allMatched: true,
  pendingBlank: false,
  // marked's lexer state, shared by every inline string of one
  // document: an unclosed <a ...> tag suppresses bare autolinks
  // from then on, and text inside <pre>/<code>/<kbd>/<script>
  // inline spans renders raw
  inLinkTag: false,
  inRawBlock: false,
};

function curRest() {
  return (S.partial > 0 ? ' '.repeat(S.partial) : '') + S.lines[S.lineIdx].slice(S.off);
}

// curRest with the tabs of the leading whitespace run expanded to
// spaces from the cursor column. marked derives the text of
// container-processed lines from tab-expanded source (the J
// expansion in list items and after blockquote markers), so a tab
// that starts the content of such a line becomes spaces.
function curRestExpanded() {
  const rest = curRest();
  if (!rest.includes('\t')) return rest;
  let col = S.col - (S.prevFrameBase || 0);
  let out = '';
  let i = 0;
  while (i < rest.length) {
    const c = rest[i];
    if (c === ' ') { out += c; col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else break;
  }
  return out + rest.slice(i);
}

// Is this node (or any ancestor) inside a quote or list item?
function chainHasContainer(node) {
  let n = node;
  while (n) {
    if (n.t === 'quote' || n.t === 'item') return true;
    n = n.parent;
  }
  return false;
}
function restFromNext() {
  return S.lines[S.lineIdx].slice(S.nextOff);
}

function advanceCols(n) {
  const line = S.lines[S.lineIdx];
  while (n > 0) {
    if (S.partial > 0) {
      const take = Math.min(n, S.partial);
      S.partial -= take;
      S.col += take;
      n -= take;
      continue;
    }
    const ch = line[S.off];
    if (ch === ' ') { S.off++; S.col++; n--; }
    else if (ch === '\t') {
      const w = 4 - (S.col % 4);
      S.off++;
      if (w <= n) { S.col += w; n -= w; }
      else { S.partial = w - n; S.col += n; n = 0; }
    } else break;
  }
}

function computeNextNonspace() {
  const line = S.lines[S.lineIdx];
  let off = S.off;
  let col = S.col;
  if (S.partial > 0) col += S.partial;
  while (off < line.length) {
    const ch = line[off];
    if (ch === ' ') { off++; col++; }
    else if (ch === '\t') { off++; col += 4 - (col % 4); }
    else break;
  }
  S.nextOff = off;
  S.nextCol = col;
  S.blank = off >= line.length;
  S.indent = col - S.col - (S.partial > 0 ? 0 : 0);
  // indent counts columns from the cursor, including any partial tab rest
  S.indent = col - S.col;
}

// The string starting at the given absolute column of the current line,
// measured from the post-container-match cursor snapshot.
function sliceFromOriginColumn(targetCol) {
  const saved = { off: S.off, col: S.col, partial: S.partial };
  S.off = S.oOff; S.col = S.oCol; S.partial = S.oPartial;
  advanceCols(targetCol - S.oCol);
  const r = curRest();
  S.off = saved.off; S.col = saved.col; S.partial = saved.partial;
  return r;
}

// --- container matching ---

function tryMatchQuote() {
  const line = S.lines[S.lineIdx];
  let off = S.off;
  let lead = S.partial;
  while (line[off] === ' ') { lead++; off++; }
  if (lead > 3) return false;
  if (line[off] !== '>') return false;
  advanceCols(lead);
  S.off++; S.col++; // the '>' itself
  consumeQuoteRun();
  return true;
}

// marked derives a blockquote's text by expanding the whitespace
// run after each '>' in the parent frame (tab stops from the
// marker prefix) and stripping the marker plus one character of
// the expanded run. Consume the run accordingly: the cursor ends
// one virtual column past the run's start, with the rest of the
// expanded run held as partial (visible content indent).
function consumeQuoteRun() {
  const line = S.lines[S.lineIdx];
  if (line[S.off] !== ' ' && line[S.off] !== '\t') return;
  const vcol = S.col + S.partial;
  let col = vcol - (S.frameBase || 0);
  let w = 0;
  while (line[S.off] === ' ' || line[S.off] === '\t') {
    if (line[S.off] === ' ') { w++; col++; }
    else { const tw = 4 - (col % 4); w += tw; col += tw; }
    S.off++;
  }
  S.partial = w - 1;
  S.col = vcol + 1;
}

// Marked expands the leading tabs of list-item content lines to
// spaces before slicing at the item indent; a tab sitting exactly on
// the boundary is therefore consumed as its full space width.
function expandBoundaryTab() {
  const line = S.lines[S.lineIdx];
  if (S.partial === 0 && line[S.off] === '\t') {
    S.partial = 4 - (S.col % 4);
    S.off++;
  }
}

function tryMatchItem(item) {
  if (item.sealed) return false;
  computeNextNonspace();
  if (S.blank) return true;
  if (S.indent >= item.padding) {
    advanceCols(item.padding);
    expandBoundaryTab();
    return true;
  }
  return false;
}

function matchContainers() {
  let node = S.root;
  let failed = false;
  // frame bases for tab expansion: frameBase is the source column
  // of the current container frame's column 0; prevFrameBase is the
  // base of the frame the innermost container was matched in
  S.frameBase = 0;
  S.prevFrameBase = 0;
  while (true) {
    const last = node.kids[node.kids.length - 1];
    if (!last || !last.open) break;
    if (last.t === 'quote') {
      if (!tryMatchQuote()) { failed = true; break; }
      S.prevFrameBase = S.frameBase;
      S.frameBase = S.col + S.partial;
      node = last;
    } else if (last.t === 'item') {
      const ok = tryMatchItem(last);
      // whether this line is blank in the item's parent frame
      // (the text the item's list is lexed from) — the blankness
      // that decides if the item's raw ends with a blank line
      last.blankInParent = S.blank;
      if (!ok) { failed = true; break; }
      S.prevFrameBase = S.frameBase;
      S.frameBase = S.col + S.partial;
      node = last;
    } else if (last.t === 'list') {
      // a list is only as matched as its open item
      const item = last.kids[last.kids.length - 1];
      if (item && item.open) {
        const ok = tryMatchItem(item);
        item.blankInParent = S.blank;
        if (!ok) { failed = true; break; }
        S.prevFrameBase = S.frameBase;
        S.frameBase = S.col + S.partial;
        node = item;
      } else {
        node = last;
      }
    } else break;
  }
  S.matchedContainer = node;
  S.allMatched = !failed;
}

// --- tree mutation helpers ---

function finalizeNode(node) {
  node.open = false;
  if (node.t === 'code') {
    // trailing blank lines absorbed into an indented code block are not
    // content; if any are trimmed and a sibling follows inside an item,
    // they still separate blocks for looseness purposes.
    let trimmed = 0;
    while (node.lines.length && node.lines[node.lines.length - 1] === '') {
      node.lines.pop();
      trimmed++;
    }
    if (trimmed > 0) S.pendingBlank = true;
  }
  if (node.t === 'html' && !node.trailSet) {
    // Closed without consuming an end line (blank line, container
    // failure, or end of input): a trailing newline is only added
    // when the block runs to the end of a source that ends with one.
    node.trailNl = S.eofFinal ? !!S.srcEndsNl : false;
  }
}

function closeTip() {
  const t = S.tip;
  finalizeNode(t);
  S.tip = t.parent;
}

// Close every open block below (and not including) the given container.
function closeBlocksAbove(container) {
  // If the tip already sits at or above the container (the container
  // is in the tip's subtree but not on its chain — possible after an
  // earlier close set the tip to an ancestor), there is nothing on
  // the chain to close; walking up would finalize ancestors that
  // are still open for business (an outer item, most often).
  for (let p = container; p; p = p.parent) {
    if (p === S.tip) { S.tip = container; return; }
  }
  while (S.tip !== container && S.tip !== S.root && S.tip.parent) {
    // A list is not finalized by being walked past: in marked's
    // line collection a sibling item may still join it after its
    // last item's inner blocks (a quote, a fence) were closed by a
    // mismatched line. The list only dies when a sibling block
    // takes its place as the parent's last child, or a definition
    // intervenes (handled in openLeaf).
    if (S.tip.t === 'list') { S.tip = S.tip.parent; continue; }
    closeTip();
  }
  if (S.tip !== container) S.tip = container;
}

// Append a block to the right parent: an open paragraph is closed first,
// and a block can never be a direct child of a list (only items can).
function addBlock(node) {
  if (S.tip.t === 'para') closeTip();
  if (S.tip.t === 'list') closeTip();
  const parent = S.tip;
  node.parent = parent;
  node.open = true;
  if (parent.t === 'item') parent.trailingBlank = false;
  if (parent.kids.length > 0 && S.pendingBlank && parent.t === 'item') {
    parent.childrenSeparated = true;
  }
  S.pendingBlank = false;
  parent.kids.push(node);
  S.tip = node;
  return node;
}

function deepestContainer() {
  let n = S.tip;
  while (n.t !== 'root' && n.t !== 'quote' && n.t !== 'list' && n.t !== 'item') n = n.parent;
  return n;
}

// --- line-start pattern matchers (operate on the rest of the line) ---

const HR_RE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
function isThematicBreak(rest) {
  return HR_RE.test(rest);
}

function matchFenceStart(rest) {
  const c = rest[0];
  if (c !== '`' && c !== '~') return null;
  let run = 0;
  while (rest[run] === c) run++;
  if (run < 3) return null;
  const info = rest.slice(run);
  if (c === '`' && info.includes('`')) return null;
  return { ch: c, len: run, info };
}

const ATX_RE = /^(#{1,6})(?:[ \t]+(.*))?$/;
function matchAtx(rest) {
  const m = ATX_RE.exec(rest);
  if (!m) return null;
  let text = (m[2] || '').replace(/[ \t]+$/, '');
  // closing sequence: a run of #s preceded by whitespace, or all #s
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+$/, '').replace(/[ \t]+$/, '');
  return { level: m[1].length, text };
}

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
const HTML_T1_RE = /^<(script|pre|style|textarea)(?=[\s>]|$)/i;
const HTML_T7_OPEN_RE = /^<([a-z][a-z0-9-]*)((?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*)\s*\/?>[ \t]*$/i;
const HTML_T7_CLOSE_RE = /^<\/([a-z][a-z0-9-]*)\s*>[ \t]*$/i;

// Returns { ht, htag } if the line starts an HTML block, else null.
// Types 1-6 may interrupt a paragraph; type 7 may not.
function matchHtmlBlockStart(rest, tipIsPara) {
  if (rest[0] !== '<') return null;
  let m = HTML_T1_RE.exec(rest);
  if (m) return { ht: 1, htag: m[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { ht: 2, htag: '' };
  if (rest.startsWith('<?')) return { ht: 3, htag: '' };
  if (/^<![A-Z]/.test(rest)) return { ht: 4, htag: '' };
  if (rest.startsWith('<![CDATA[')) return { ht: 5, htag: '' };
  m = /^<\/?([a-z][a-z0-9-]*)(?=[ \t]|\n|\/>|>|$)/i.exec(rest);
  if (m && HTML_BLOCK_TAGS.has(m[1].toLowerCase())) return { ht: 6, htag: '' };
  if (!tipIsPara) {
    m = HTML_T7_OPEN_RE.exec(rest);
    if (m && !HTML_T1_RE.test(rest)) return { ht: 7, htag: '' };
    if (HTML_T7_CLOSE_RE.test(rest)) return { ht: 7, htag: '' };
  }
  return null;
}

function htmlBlockEnded(node, lineText) {
  switch (node.ht) {
    case 1: return lineText.toLowerCase().includes('</' + node.htag); // (sic) see below
    case 2: return lineText.includes('-->');
    case 3: return lineText.includes('?>');
    case 4: return lineText.includes('>');
    case 5: return lineText.includes(']]>');
    default: return false;
  }
}

// --- link reference definitions ---

// Strip the currently open containers from an arbitrary source line;
// returns the remaining text, or null when a container fails to match
// or the remainder is blank.
function stripContainersForLine(rawLine) {
  const saved = { off: S.off, col: S.col, partial: S.partial, idx: S.lineIdx };
  // temporarily point the cursor machinery at the given line
  const savedLine = S.lines[S.lineIdx];
  S.lines[S.lineIdx] = rawLine;
  S.off = 0; S.col = 0; S.partial = 0;
  let node = S.root;
  let ok = true;
  while (true) {
    const last = node.kids[node.kids.length - 1];
    if (!last || !last.open) break;
    if (last.t === 'quote') { if (!tryMatchQuote()) { ok = false; break; } node = last; }
    else if (last.t === 'item') { if (!tryMatchItem(last)) { ok = false; break; } node = last; }
    else if (last.t === 'list') node = last;
    else break;
  }
  let result = null;
  if (ok) {
    computeNextNonspace();
    if (!S.blank) result = restFromNext();
  }
  S.lines[S.lineIdx] = savedLine;
  S.off = saved.off; S.col = saved.col; S.partial = saved.partial; S.lineIdx = saved.idx;
  return result;
}

// Trailing-newline rule for delimiter-terminated HTML blocks: marked
// slices the block's raw from its frame text (the item text or quote
// chunk being lexed), so the newline survives iff the frame text has a
// following line that is not literally empty. Evaluate the next raw
// line through the block's enclosing containers to decide.
function htmlTrailNl(node, idx) {
  const next = S.lines[idx + 1];
  if (next === undefined) return !!S.srcEndsNl;
  let nested = false;
  for (let p = node.parent; p; p = p.parent) {
    if (p.t === 'quote' || p.t === 'item') { nested = true; break; }
  }
  if (!nested) return next !== '';
  const saved = { off: S.off, col: S.col, partial: S.partial, idx: S.lineIdx };
  const savedLine = S.lines[S.lineIdx];
  S.lines[S.lineIdx] = next;
  S.off = 0; S.col = 0; S.partial = 0;
  let n = S.root, ok = true;
  while (true) {
    const last = n.kids[n.kids.length - 1];
    if (!last || !last.open) break;
    if (last.t === 'quote') { if (!tryMatchQuote()) { ok = false; break; } n = last; }
    else if (last.t === 'item') { if (!tryMatchItem(last)) { ok = false; break; } n = last; }
    else if (last.t === 'list') n = last;
    else break;
  }
  const result = ok && curRest() !== '';
  S.lines[S.lineIdx] = savedLine;
  S.off = saved.off; S.col = saved.col; S.partial = saved.partial; S.lineIdx = saved.idx;
  return result;
}

// Attempt to parse a link reference definition starting at the current
// line (cursor already past containers, remainder = restFromNext()).
// Labels and titles may span lines, so parsing runs over a virtual
// text: the current remainder plus the container-stripped remainders
// of the following lines. On success registers the definition and
// returns the number of EXTRA lines consumed. Returns -1 on failure.
function tryParseDef() {
  const segs = [restFromNext()];
  for (let k = 1; k <= 12; k++) {
    const li = S.lineIdx + k;
    if (li >= S.lines.length) break;
    const seg = stripContainersForLine(S.lines[li]);
    if (seg === null) break;
    segs.push(seg);
  }
  const text = segs.join('\n');
  const lineStart = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStart.push(i + 1);
  }
  const lineOf = (pos) => {
    let lo = 0;
    for (let i = 0; i < lineStart.length; i++) {
      if (lineStart[i] <= pos) lo = i;
      else break;
    }
    return lo;
  };
  const lineEnd = (li) => (li + 1 < lineStart.length ? lineStart[li + 1] - 1 : text.length);

  let pos = 0;
  if (text[pos] !== '[') return -1;
  pos++;
  // label: escapes allowed, no unescaped '[', may span lines
  let label = '';
  let labelOk = false;
  while (pos < text.length) {
    const c = text[pos];
    if (c === '\\' && pos + 1 < text.length && isPunct(text[pos + 1])) {
      label += c + text[pos + 1];
      pos += 2;
      continue;
    }
    if (c === ']') { labelOk = true; break; }
    if (c === '[') return -1;
    label += c;
    pos++;
  }
  if (!labelOk) return -1;
  if (!/\S/.test(label)) return -1;
  pos++; // skip ']'
  if (text[pos] !== ':') return -1;
  pos++;
  // destination: after optional spaces / one line break
  const skipWsLine = () => {
    // skip spaces/tabs on this line; if at EOL, move to the next line
    // and skip its leading spaces/tabs too. Returns false if no next line.
    while (text[pos] === ' ' || text[pos] === '\t') pos++;
    if (pos >= text.length) return false;
    if (text[pos] === '\n') {
      pos++;
      while (text[pos] === ' ' || text[pos] === '\t') pos++;
    }
    return true;
  };
  if (!skipWsLine()) return -1;
  if (pos >= text.length) return -1;
  let dest;
  if (text[pos] === '<') {
    const gt = text.indexOf('>', pos);
    if (gt === -1) return -1;
    dest = text.slice(pos + 1, gt);
    if (dest.includes('\n')) return -1;
    pos = gt + 1;
  } else {
    let end = pos;
    while (end < text.length && text[end] !== ' ' && text[end] !== '\t' && text[end] !== '\n') end++;
    if (end === pos) return -1;
    dest = text.slice(pos, end);
    pos = end;
  }
  // optional title: requires at least one space/tab or a line break
  // between the destination and the title.
  let title = null;
  let endLine = lineOf(pos);
  {
    let p2 = pos;
    let sawSep = false;
    while (text[p2] === ' ' || text[p2] === '\t') { p2++; sawSep = true; }
    if (text[p2] === '\n') { sawSep = true; p2++; while (text[p2] === ' ' || text[p2] === '\t') p2++; }
    if (p2 < text.length && sawSep && (text[p2] === '"' || text[p2] === "'" || text[p2] === '(')) {
      const t = parseTitleAt(text, p2);
      if (t) {
        let p3 = t.end;
        while (text[p3] === ' ' || text[p3] === '\t') p3++;
        if (p3 >= text.length || text[p3] === '\n') {
          title = t.title;
          endLine = lineOf(p3);
        }
      }
    }
    if (title === null) {
      // no title: the definition must end at the destination's line end
      let p3 = pos;
      while (text[p3] === ' ' || text[p3] === '\t') p3++;
      if (!(p3 >= text.length || text[p3] === '\n')) return -1;
      endLine = lineOf(p3);
    }
  }
  const key = normalizeLabel(label);
  if (!S.refs.has(key)) {
    S.refs.set(key, { href: cleanUrl(resolveEscapes(dest)), title: title === null ? null : resolveEscapes(title) });
  }
  return endLine;
}

function parseTitleAt(str, pos) {
  const open = str[pos];
  let close;
  if (open === '"') close = '"';
  else if (open === "'") close = "'";
  else if (open === '(') close = ')';
  else return null;
  let i = pos + 1;
  let title = '';
  while (i < str.length) {
    const c = str[i];
    if (c === '\\' && i + 1 < str.length && isPunct(str[i + 1])) {
      title += str[i] + str[i + 1];
      i += 2;
      continue;
    }
    if (c === close) return { title, end: i + 1 };
    if (open === '(' && c === '(') return null;
    title += c;
    i++;
  }
  return null;
}

// --- tables ---

// Port of marked's cell splitting: a pipe preceded by an even number of
// backslashes is a separator; drop one empty cell at each end; every
// cell is trimmed and `\|` becomes `|`.
function splitCells(row, count) {
  let markedRow = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '|') {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && row[j] === '\\') { bs++; j--; }
      if (bs % 2 === 0) markedRow += ' |';
      else markedRow += '|';
    } else markedRow += row[i];
  }
  const cells = markedRow.split(' |');
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    while (cells.length < count) cells.push('');
    cells.length = count;
  }
  return cells.map(c => c.trim().replace(/\\\|/g, '|'));
}

const DELIM_CELL_RE = /^:?-+:?$/;
function tryTableFromParagraph(para, delimLine) {
  if (!delimLine.includes('|')) return false;
  const delimCells = splitCells(delimLine);
  if (delimCells.length === 0) return false;
  const aligns = [];
  for (const c of delimCells) {
    if (!DELIM_CELL_RE.test(c)) return false;
    aligns.push(c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
  }
  const headerLine = para.lines[para.lines.length - 1];
  const headerCells = splitCells(headerLine);
  if (headerCells.length !== delimCells.length) return false;
  const table = {
    t: 'table', parent: para.parent, open: true,
    header: headerCells, aligns, rows: [],
  };
  para.lines.pop();
  if (para.lines.length === 0) {
    const parent = para.parent;
    parent.kids[parent.kids.indexOf(para)] = table;
    finalizeNode(para);
    S.tip = table;
  } else {
    finalizeNode(para);
    const parent = para.parent;
    parent.kids.push(table);
    S.tip = table;
  }
  return true;
}

const TABLE_STOP_RE = /^(?: {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$| {0,3}#{1,6}(?:[ \t]+|$)| {0,3}>|(?: {4}| {0,3}\t)\S| {0,3}(?:`{3,}|~{3,})| {0,3}(?:[-*+]|1[.)])(?:[ \t]+|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ ]|$|\/?>)|<(?:script|pre|style|textarea)(?:[\s>]|$)|<!--|<\?|<![A-Za-z]|<!\[CDATA\[))/;
function tableRowEnds(line) {
  return TABLE_STOP_RE.test(line);
}

// --- list item start ---

const BULLET_RE = /^([-*+])([ \t]+|$)/;
const ORDERED_RE = /^(\d{1,9})([.)])([ \t]+|$)/;

// Parse a list item start at the current remainder (which begins at
// the marker). Returns null or { ordered, start, bulletChar,
// delimChar, padding, isEmpty } where padding is the frame-relative
// column of the item's content.
function matchListItemStart(rest) {
  let ordered = false;
  let start = 1;
  let bulletChar = null;
  let delimChar = null;
  let markerLen = 0;
  let m = /^([-*+])/.exec(rest);
  if (m) {
    bulletChar = m[1];
    markerLen = 1;
  } else {
    m = /^(\d{1,9})([.)])/.exec(rest);
    if (!m) return null;
    ordered = true;
    start = parseInt(m[1], 10);
    delimChar = m[2];
    markerLen = m[1].length + 1;
  }
  const afterMarker = rest.slice(markerLen);
  if (afterMarker !== '' && afterMarker[0] !== ' ' && afterMarker[0] !== '\t') return null;
  const base = S.nextCol - S.oCol;
  let col = S.nextCol + markerLen;
  let wsCols = 0;
  let i = 0;
  while (i < afterMarker.length && (afterMarker[i] === ' ' || afterMarker[i] === '\t')) {
    if (afterMarker[i] === ' ') { wsCols++; col++; }
    else { const w = 4 - (col % 4); wsCols += w; col += w; }
    i++;
  }
  const isEmpty = i >= afterMarker.length;
  let padding;
  if (isEmpty || wsCols >= 5) padding = base + markerLen + 1;
  else padding = base + markerLen + wsCols;
  return { ordered, start, bulletChar, delimChar, padding, isEmpty, markerLen };
}

// --- main line processing ---

const SETEXT_RE = /^(=+|-+)[ \t]*$/;

function markBlankInOpenItems() {
  let n = S.tip;
  while (n && n !== S.root) {
    if (n.t === 'item') n.blankInSpan = true;
    n = n.parent;
  }
}

// An item whose first line is blank is sealed (kept empty, closed to
// further content) when the very next line is blank as well.
function sealBlankItems() {
  let n = S.tip;
  while (n && n !== S.root) {
    if (n.t === 'item' && n.firstLineBlank && n.kids.length === 0 && S.lineIdx === n.createdAtLine + 1) {
      n.sealed = true;
    }
    n = n.parent;
  }
}

function paraHasItemAncestor() {
  let n = S.tip;
  while (n) {
    if (n.t === 'item') return true;
    n = n.parent;
  }
  return false;
}

// Does this line start a construct that interrupts a lazy paragraph
// continuation? (Setext underlines, definitions and table delimiters
// do NOT interrupt lazily; they are absorbed as paragraph text.)
function startsInterrupting(rest, ind) {
  if (ind > 3) return false;
  if (rest === '') return false;
  const c = rest[0];
  if (c === '>') return true;
  if (c === '`' || c === '~') return matchFenceStart(rest) !== null;
  if (c === '#') return matchAtx(rest) !== null;
  if (isThematicBreak(rest)) return true;
  if (c === '<') {
    const h = matchHtmlBlockStart(rest, true);
    return h !== null && h.ht <= 6;
  }
  const li = matchListItemStart(rest);
  if (li) {
    // a list start always breaks out of an enclosing list item's
    // paragraph; at the top level the usual interruption rules apply
    if (paraHasItemAncestor()) return true;
    if (li.isEmpty) return false;
    if (li.ordered && li.start !== 1) return false;
    return true;
  }
  return false;
}

// If the open paragraph's parent item is the first container that
// failed to match this line, return that item (marked's item-content
// loop then applies its clamped begin-check indent bound).
function firstFailedItem(para) {
  if (!para || !para.parent || para.parent.t !== 'item') return null;
  const item = para.parent;
  const set = new Set();
  let n = S.matchedContainer;
  while (n) { set.add(n); n = n.parent; }
  if (set.has(item)) return null;
  const listParent = item.parent && item.parent.parent;
  if (listParent && set.has(listParent)) return item;
  return null;
}

const SETEXT_ITEM_RE = /^ {0,3}(=+|-+) *$/;

function convertParaToHeading(para, level) {
  const text = para.lines.join('\n').trim();
  const head = { t: 'head', level, text, parent: para.parent, open: false };
  const parent = para.parent;
  parent.kids[parent.kids.indexOf(para)] = head;
  finalizeNode(para);
  S.tip = parent;
}

// Append a lazy continuation line to the open paragraph, following
// marked's container-specific rules: in a blockquote a setext-looking
// line is space-protected from the second lazy line on; in a list item
// it is protected only when the previous content line (marked's `m`,
// tracked as para.lastM) could form a setext heading with it —
// otherwise the paragraph really becomes a heading.
function appendLazyLine(para) {
  const parent = para.parent;
  const frameLine = curRest();
  if (parent && parent.t === 'item') {
    const rest = restFromNext();
    if (S.indent >= 4) {
      // an indented lazy line merges into the paragraph with four
      // columns stripped (marked's code-token merge)
      para.lines.push(sliceFromOriginColumn(S.oCol + 4));
    } else if (S.indent <= 3 && SETEXT_ITEM_RE.test(rest)) {
      if (para.lastM && /\S/.test(para.lastM)) {
        para.lines.push(rest);
      } else {
        convertParaToHeading(para, rest[0] === '=' ? 1 : 2);
        return;
      }
    } else {
      para.lines.push(frameLine);
    }
    para.lastM = frameLine.slice(parent.padding);
    para.lastWasLazy = true;
    return;
  }
  if (parent && parent.t === 'quote') {
    let text;
    if (S.indent >= 4) text = sliceFromOriginColumn(S.oCol + 4);
    else if (S.indent <= 3 && SETEXT_RE.test(restFromNext()) && para.lastWasLazy) text = '    ' + restFromNext();
    else text = frameLine;
    para.lines.push(text);
    para.lastWasLazy = true;
    return;
  }
  para.lines.push(restFromNext());
  para.lastWasLazy = true;
}

function incorporateLine(idx) {
  S.lineIdx = idx;
  S.off = 0; S.col = 0; S.partial = 0;
  matchContainers();
  S.oOff = S.off; S.oCol = S.col; S.oPartial = S.partial;
  computeNextNonspace();
  S.lineBlank = S.blank;
  let tip = S.tip;

  // (1) continuation of an open leaf block
  if (tip.t === 'fence') {
    if (!S.allMatched && !fenceAbsorbsLine(tip)) {
      // a line outside the fence's containers is not fence content
      closeTip();
      closeBlocksAbove(S.matchedContainer);
      tip = S.tip;
    } else {
      if (S.indent <= 3 && !S.blank) {
        const rest = restFromNext();
        if (rest[0] === tip.ch) {
          let run = 0;
          while (rest[run] === tip.ch) run++;
          if (run >= tip.len && /^ *$/.test(rest.slice(run))) {
            closeTip();
            return 0;
          }
        }
      }
      tip.lines.push(stripFenceComp(chainHasContainer(tip) ? curRestExpanded() : curRest(), tip.comp));
      return 0;
    }
  }
  if (tip.t === 'html') {
    if (!S.allMatched) {
      closeTip();
    } else if (tip.ht >= 6) {
      if (S.blank) closeTip();
      else { tip.lines.push(curRest()); return 0; }
    } else {
      tip.lines.push(curRest());
      if (htmlBlockEnded(tip, curRest())) {
        // marked keeps the block's trailing newline unless the
        // next line of its frame text is literally empty (a
        // whitespace-only line still counts as a following line)
        tip.trailNl = htmlTrailNl(tip, idx);
        tip.trailSet = true;
        closeTip();
      }
      return 0;
    }
  }
  if (tip.t === 'code') {
    if (!S.allMatched) closeTip();
    else if (S.blank) { tip.lines.push(sliceFromOriginColumn(S.oCol + 4)); return 0; }
    else if (S.indent >= 4) { tip.lines.push(sliceFromOriginColumn(S.oCol + 4)); return 0; }
    else closeTip();
  }
  if (tip.t === 'table') {
    // marked's table body ends at a line of spaces only (a line
    // holding nothing but a tab is a row of empty cells instead),
    // or at a line starting another block (tableRowEnds)
    if (!S.allMatched) closeTip();
    else if (!/^ *$/.test(curRest()) && !tableRowEnds(curRest())) {
      tip.rows.push(splitCells(restFromNext(), tip.header.length));
      return 0;
    } else closeTip();
  }

  tip = S.tip;
  // (2) blank line
  if (S.blank) {
    const rawBlank = !/[^ \t]/.test(S.lines[idx]);
    if (tip.t === 'para' && !rawBlank && curRest() !== '') {
      // a container line whose remainder is only whitespace (e.g.
      // ">  ") continues the paragraph with that whitespace
      const appended = curRest();
      tip.lines.push(appended);
      tip.lastWasLazy = false;
      tip.lastM = appended;
      return 0;
    }
    if (tip.t === 'para' && rawBlank && tip.parent === S.root && idx === S.lines.length - 1 && S.lines[idx] !== '') {
      // a whitespace-only final line still belongs to the paragraph
      // text (marked's paragraph capture runs to the end of input)
      const appended = curRest();
      tip.lines.push(appended);
      tip.lastWasLazy = false;
      tip.lastM = appended;
      return 0;
    }
    if (tip.t === 'para') closeTip();
    if (!S.allMatched) closeBlocksAbove(S.matchedContainer);
    markBlankInOpenItems();
    sealBlankItems();
    // a line that is blank in an item's parent frame (inside a
    // blockquote, a bare ">" line is such a blank) is "trailing"
    // for that item when it is the last line of its span
    {
      let n = S.tip;
      while (n && n !== S.root) {
        if (n.t === 'item' && n.blankInParent) n.trailingBlank = true;
        n = n.parent;
      }
    }
    S.pendingBlank = true;
    return 0;
  }

  // (3) lazy paragraph continuation
  if (!S.allMatched && tip.t === 'para') {
    let interrupting = startsInterrupting(restFromNext(), S.indent);
    if (interrupting) {
      const ffi = firstFailedItem(tip);
      if (ffi && S.indent > Math.min(3, ffi.padding - 1)) interrupting = false;
    }
    if (!interrupting) {
      appendLazyLine(tip);
      return 0;
    }
  }

  // (4) open new containers (blockquotes, then list items). Closing
  // the blocks above the matched container is deferred until we know
  // what this line opens: a sibling list item must keep its list open.
  let closedAbove = false;
  const ensureClosed = () => {
    if (!closedAbove) {
      if (!S.allMatched) closeBlocksAbove(S.matchedContainer);
      closedAbove = true;
    }
  };
  for (;;) {
    const rest = restFromNext();
    if (S.indent <= 3 && rest[0] === '>') {
      ensureClosed();
      const q = addBlock({ t: 'quote', kids: [] });
      S.tip = q;
      S.matchedContainer = q;
      S.off = S.nextOff + 1;
      S.col = S.nextCol + 1;
      S.partial = 0;
      consumeQuoteRun();
      computeNextNonspace();
      S.oOff = S.off; S.oCol = S.col; S.oPartial = S.partial;
      S.prevFrameBase = S.frameBase || 0;
      S.frameBase = S.col + S.partial;
      continue;
    }
    if (S.indent <= 3 && isThematicBreak(rest)) break;
    const itemStart = S.indent <= 3 ? matchListItemStart(rest) : null;
    if (!itemStart) break;
    // an empty item cannot interrupt a paragraph in its own
    // container; an ordered item not starting at 1 cannot interrupt
    // a top-level (root/blockquote) paragraph in its own container
    if (S.tip.t === 'para' && S.matchedContainer === S.tip.parent &&
        (itemStart.isEmpty ||
         (itemStart.ordered && itemStart.start !== 1 && S.tip.parent.t !== 'item'))) break;
    startItem(itemStart);
    closedAbove = true;
    // loop on: the item's first line may itself open containers
    // (a blockquote or a nested list on the same line)
  }

  ensureClosed();
  return openLeaf(idx);
}

// Create a new list item for the given start, either as a sibling in
// the open list at the matched level or in a fresh list.
function listMatches(list, itemStart) {
  return list.ordered === itemStart.ordered &&
    (itemStart.ordered ? list.delimChar === itemStart.delimChar
                       : list.bulletChar === itemStart.bulletChar);
}

function startItem(itemStart) {
  const M = S.matchedContainer;
  let list = null;
  if (M.t === 'list' && M.open && listMatches(M, itemStart)) {
    list = M;
  } else {
    const lastKid = M.kids[M.kids.length - 1];
    if (lastKid && lastKid.t === 'list' && lastKid.open && listMatches(lastKid, itemStart)) {
      list = lastKid;
    }
  }
  if (list) {
    const prev = list.kids[list.kids.length - 1];
    if (prev && prev.trailingBlank) prev.blankEnded = true;
    closeBlocksAbove(list);
  } else {
    closeBlocksAbove(M);
    const parent = M;
    list = {
      t: 'list', kids: [], parent, open: true,
      ordered: itemStart.ordered, start: itemStart.start,
      bulletChar: itemStart.bulletChar, delimChar: itemStart.delimChar,
      loose: false,
    };
    if (parent.kids.length > 0 && S.pendingBlank && parent.t === 'item') {
      parent.childrenSeparated = true;
    }
    S.pendingBlank = false;
    parent.kids.push(list);
  }
  const item = {
    t: 'item', kids: [], parent: list, open: true,
    padding: itemStart.padding, blankInSpan: false, childrenSeparated: false,
    blankEnded: false, sealed: false, firstLineBlank: false, createdAtLine: S.lineIdx,
  };
  list.kids.push(item);
  S.tip = item;
  S.matchedContainer = item;
  // move the cursor onto the marker, consume the marker characters,
  // then advance over whitespace up to the content column
  const line = S.lines[S.lineIdx];
  S.off = S.nextOff; S.col = S.nextCol; S.partial = 0;
  S.off += itemStart.markerLen;
  S.col += itemStart.markerLen;
  advanceCols(itemStart.padding - (S.nextCol - S.oCol) - itemStart.markerLen);
  expandBoundaryTab();
  computeNextNonspace();
  item.firstLineBlank = S.blank;
  S.oOff = S.off; S.oCol = S.col; S.oPartial = S.partial;
  S.prevFrameBase = S.frameBase || 0;
  S.frameBase = S.col + S.partial;
}

// A fence directly inside a list item keeps absorbing lines that
// fail the item match (marked collects them as lazy item content),
// unless the fence has no content line yet (the collection breaks
// right after a fence start) or the line starts a construct under
// the clamped begin-check indent bound.
function fenceAbsorbsLine(fence) {
  const item = fence.parent;
  if (!item || item.t !== 'item') return false;
  if (S.matchedContainer !== item.parent.parent) return false;
  if (fence.lines.length === 0) return false;
  let interrupting = startsInterrupting(restFromNext(), S.indent);
  if (interrupting && S.indent > Math.min(3, item.padding - 1)) interrupting = false;
  return !interrupting;
}

// Strip up to `comp` leading whitespace CHARACTERS from a fence
// content line (marked's indent compensation only removes whitespace).
function stripFenceComp(text, comp) {
  if (comp === 0) return text;
  let i = 0;
  while (i < text.length && i < comp && (text[i] === ' ' || text[i] === '\t')) i++;
  return text.slice(i);
}

function fenceCompensation() {
  const line = S.lines[S.lineIdx];
  // the partial columns are space characters in the derived text
  // (a partially consumed tab, or the tail of an expanded
  // blockquote whitespace run); each counts as one whitespace char
  let n = S.oPartial;
  for (let i = S.oOff; i < S.nextOff && i < line.length; i++) {
    if (line[i] === ' ' || line[i] === '\t') n++;
  }
  return n;
}

// Leaf-block starts and paragraph continuation for the current line.
// Returns the number of extra lines consumed (by a definition).
function openLeaf(idx) {
  const rest = restFromNext();
  const ind = S.indent;
  const tip = S.tip;

  if (S.blank) {
    // The line has no content past the containers that were just
    // opened (e.g. a bare ">" or "- "): it starts nothing. A paragraph
    // that is open still absorbs the line's trailing whitespace.
    if (tip.t === 'para' && curRest() !== '') {
      tip.lines.push(curRest());
      tip.lastWasLazy = false;
    }
    return 0;
  }

  if (tip.t === 'para') {
    if (ind <= 3 && SETEXT_RE.test(rest)) {
      convertParaToHeading(tip, rest[0] === '=' ? 1 : 2);
      return 0;
    }
    if (S.allMatched && tryTableFromParagraph(tip, rest)) return 0;
  }

  if (ind <= 3) {
    const f = matchFenceStart(rest);
    if (f) {
      const node = addBlock({
        t: 'fence', ch: f.ch, len: f.len,
        info: resolveEscapes(f.info.trim()),
        comp: f.ch === '`' ? fenceCompensation() : 0,
        lines: [],
      });
      S.tip = node;
      return 0;
    }
    const atx = matchAtx(rest);
    if (atx) {
      addBlock({ t: 'head', level: atx.level, text: atx.text });
      closeTip();
      return 0;
    }
    const hb = matchHtmlBlockStart(rest, tip.t === 'para');
    if (hb) {
      const node = addBlock({ t: 'html', ht: hb.ht, htag: hb.htag, lines: [curRest()], trailNl: false });
      S.tip = node;
      if (hb.ht <= 5 && htmlBlockEnded(node, curRest())) {
        node.trailNl = htmlTrailNl(node, idx);
        node.trailSet = true;
        closeTip();
      }
      return 0;
    }
    if (isThematicBreak(rest)) {
      addBlock({ t: 'hr' });
      closeTip();
      return 0;
    }
    if (tip.t !== 'para' && rest[0] === '[') {
      const extra = tryParseDef();
      if (extra >= 0) {
        // a definition adds no block node, but it does end a list
        // that directly precedes it at this level
        const sib = tip.kids[tip.kids.length - 1];
        if (sib && sib.t === 'list') sib.open = false;
        // a definition after a blank line inside a list item
        // separates the item's blocks (the list turns loose)
        let p = tip;
        while (p && p.t !== 'item') p = p.parent;
        if (p && p.kids.length > 0 && S.pendingBlank) {
          p.childrenSeparated = true;
          S.pendingBlank = false;
        }
        return extra;
      }
    }
  }

  if (tip.t !== 'para' && ind >= 4) {
    const node = addBlock({ t: 'code', lines: [sliceFromOriginColumn(S.oCol + 4)] });
    S.tip = node;
    return 0;
  }

  if (tip.t === 'para') {
    let appended;
    if (tip.parent && tip.parent.t === 'item' && ind >= 4) {
      appended = sliceFromOriginColumn(S.oCol + 4);
    } else {
      appended = chainHasContainer(tip) ? curRestExpanded() : curRest();
    }
    tip.lines.push(appended);
    tip.lastWasLazy = false;
    tip.lastM = appended;
    return 0;
  }

  const firstLine = chainHasContainer(tip) ? curRestExpanded() : curRest();
  const para = addBlock({ t: 'para', lines: [firstLine], lastWasLazy: false, lastM: firstLine });
  S.tip = para;
  return 0;
}

// --- rendering ---

// Trim trailing whitespace off the deepest trailing paragraph of an
// item subtree (marked trimEnds each list's last item text).
function trimItemTail(node) {
  if (!node.kids || !node.kids.length) return;
  const last = node.kids[node.kids.length - 1];
  if (last.t === 'para') {
    while (last.lines.length && !/[^ \t]/.test(last.lines[last.lines.length - 1])) last.lines.pop();
    if (last.lines.length) {
      const li = last.lines.length - 1;
      last.lines[li] = last.lines[li].replace(/[ \t]+$/, '');
    }
    if (!last.lines.length) node.kids.pop();
  } else if (last.t === 'quote') {
    trimItemTail(last);
  }
}

function computeLooseness(node) {
  if (node.kids) for (const k of node.kids) computeLooseness(k);
  if (node.t === 'list') {
    let loose = false;
    node.kids.forEach((item, i) => {
      if (item.childrenSeparated) loose = true;
      if (item.blankEnded && i < node.kids.length - 1) loose = true;
    });
    node.loose = loose;
    // marked trimEnds the text of each list's last item; the visible
    // effect lands on the deepest trailing paragraph
    const lastItem = node.kids[node.kids.length - 1];
    if (lastItem) trimItemTail(lastItem);
  }
}

function fenceLang(info) {
  if (!info) return '';
  const m = /^\S+/.exec(info);
  return m ? m[0] : '';
}

const TASK_RE = /^\[( |x|X)\][ \t]+\S/;

function renderBlocks(kids, tightPara) {
  let out = '';
  for (const b of kids) out += renderBlock(b, tightPara);
  return out;
}

function renderBlock(b, tightPara) {
  switch (b.t) {
    case 'para': {
      const inner = parseInlineText(b.lines.join('\n'), S.refs);
      return tightPara ? inner : '<p>' + inner + '</p>\n';
    }
    case 'head':
      return '<h' + b.level + '>' + parseInlineText(b.text, S.refs) + '</h' + b.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'fence': {
      const j = b.lines.join('\n');
      const content = j === '' ? '' : (j.endsWith('\n') ? j : j + '\n');
      const lang = fenceLang(b.info);
      return '<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' +
        escapeCode(content) + '</code></pre>\n';
    }
    case 'code':
      return '<pre><code>' + escapeCode(b.lines.join('\n') + '\n') + '</code></pre>\n';
    case 'html': {
      let s = b.lines.join('\n');
      if (b.trailNl) s += '\n';
      return s;
    }
    case 'quote':
      return '<blockquote>\n' + renderBlocks(b.kids, false) + '</blockquote>\n';
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const startAttr = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let s = '<' + tag + startAttr + '>\n';
      for (const item of b.kids) s += renderItem(item, b);
      return s + '</' + tag + '>\n';
    }
    case 'table':
      return renderTable(b);
    default:
      return '';
  }
}

function renderItem(item, list) {
  let s = '<li>';
  const kids = item.kids;
  if (kids.length && kids[0].t === 'para') {
    const text = kids[0].lines.join('\n');
    const m = TASK_RE.exec(text);
    if (m) {
      const checked = m[1] !== ' ';
      const checkbox = checked
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      const stripped = text.replace(/^\[[ xX]\][ \t]+/, '');
      const inner = checkbox + parseInlineText(stripped, S.refs);
      s += list.loose ? '<p>' + inner + '</p>\n' : inner;
      for (let i = 1; i < kids.length; i++) s += renderBlock(kids[i], !list.loose);
      return s + '</li>\n';
    }
  }
  s += renderBlocks(kids, !list.loose);
  return s + '</li>\n';
}

function renderTable(b) {
  let s = '<table>\n<thead>\n<tr>\n';
  for (let i = 0; i < b.header.length; i++) {
    s += '<th' + (b.aligns[i] ? ' align="' + b.aligns[i] + '"' : '') + '>' +
      parseInlineText(b.header[i], S.refs) + '</th>\n';
  }
  s += '</tr>\n</thead>\n';
  if (b.rows.length) {
    s += '<tbody>';
    for (const row of b.rows) {
      s += '<tr>\n';
      for (let i = 0; i < row.length; i++) {
        s += '<td' + (b.aligns[i] ? ' align="' + b.aligns[i] + '"' : '') + '>' +
          parseInlineText(row[i], S.refs) + '</td>\n';
      }
      s += '</tr>\n';
    }
    s += '</tbody>';
  }
  return s + '</table>\n';
}

// --- entry point ---

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  S.srcEndsNl = src.endsWith('\n');
  S.lines = src.split('\n');
  // A trailing newline produces a final empty line that is not a real
  // source line; drop exactly one.
  if (S.lines.length > 1 && S.lines[S.lines.length - 1] === '') S.lines.pop();
  S.refs = new Map();
  S.root = { t: 'root', kids: [], parent: null, open: true };
  S.tip = S.root;
  S.pendingBlank = false;
  S.inLinkTag = false;
  S.inRawBlock = false;
  for (let i = 0; i < S.lines.length; i++) {
    i += incorporateLine(i);
    // an item's raw "ends with a blank line" only if the last line
    // that fell inside it was blank in the item's parent frame: a
    // line with content there clears the trailing-blank flag
    {
      let n = S.tip;
      while (n && n !== S.root) {
        if (n.t === 'item' && !n.blankInParent) n.trailingBlank = false;
        n = n.parent;
      }
    }
  }
  S.eofFinal = true;
  while (S.tip !== S.root) closeTip();
  S.eofFinal = false;
  computeLooseness(S.root);
  return renderBlocks(S.root.kids, false);
}
