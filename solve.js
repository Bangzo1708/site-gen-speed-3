// site-gen-speed-3: a fast drop-in for makefun-site 1.0.0.
// Strategy: regex-driven inline rendering (one C++ scan jumps between markup
// characters, one escape per text run, never per character), a fused
// single-pass line classifier, memoised slugify/longDate, words counted once
// per source, and a template tree-walk (under --no-opt the codegen's
// `new Function` compile cost is not repaid, so the tree walk wins).
// Semantics follow the vendor reference
// (baselines/makefun-site/vendor/makefun-site/) exactly.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ------------------------------------------------------------------ escaping

// Escape &, <, >, " and ' with one native regex replace per chunk: the
// scan runs in C++ and the callback only fires on a character that is
// actually special, so plain text costs one fast pass.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
// A native test first (one C++ scan, no allocation when there is nothing to
// escape), then one replace when a special character is actually present.
function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC_MAP[c]) : s;
}

// ------------------------------------------------------------------ slugs

const SLUG_MAX = 64;
const slugCache = new Map();
const dateCache = new Map();

// Slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run of
// characters other than a-z and 0-9 one "-", none at either end, at most 64
// characters (a "-" left at the cut dropped), "untitled" when nothing is left.
// One pass for ASCII text (the common case); a non-ASCII character restarts
// on the reference's own NFKD loop.
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) {
      const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
      out = '';
      gap = false;
      for (const ch of plain) {
        let keep = null;
        if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
        else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
        if (keep === null) {
          gap = out.length > 0;
          continue;
        }
        if (gap) out += '-';
        gap = false;
        out += keep;
      }
      break;
    }
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  while (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  const res = out === '' ? 'untitled' : out;
  slugCache.set(text, res);
  return res;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDate(date) {
  let hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const y = date.slice(0, 4);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  hit = d + ' ' + MONTHS[m - 1] + ' ' + y;
  dateCache.set(date, hit);
  return hit;
}

// Count the words of `text`: runs of characters other than whitespace.
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 ||
      c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f ||
      c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// `rel` from the directory `dir` of a source, or null when it climbs out.
// Resolutions repeat (the same directory and target across many pages), so
// they are memoised in `cache`, which lives for one case only.
function resolvePath(cache, dir, rel) {
  const key = dir + '\0' + rel;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  let res = null;
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) {
        cache.set(key, null);
        return null;
      }
      parts.pop();
    } else parts.push(seg);
  }
  res = parts.join('/');
  cache.set(key, res);
  return res;
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
        mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
        d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function parseFrontMatter(text) {
  // The source must open on the line "---". Only the front-matter lines are
  // ever inspected, so they are scanned with indexOf and the body is taken
  // as one slice: the whole text is never split into lines or re-joined.
  // Like the reference, the closing line is found first: an unclosed front
  // matter reports "not closed" even when a line inside it is malformed.
  if (text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45 ||
      (text.length > 3 && text.charCodeAt(3) !== 10)) {
    if (text !== '---') return { error: 'no front matter' };
  }
  if (text === '---') return { error: 'the front matter is not closed' };
  const fmLines = [];
  let pos = 4; // just past the opening "---\n"
  let closePos = -1;
  while (true) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) {
      if (text.slice(pos) === '---') closePos = text.length;
      else return { error: 'the front matter is not closed' };
      break;
    }
    if (text.slice(pos, nl) === '---') {
      closePos = nl + 1;
      break;
    }
    fmLines.push(text.slice(pos, nl));
    pos = nl + 1;
  }
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: 'line ' + (i + 2) + ' is not "key: value"' };
    let keyOk = true;
    for (let k = 0; k < colon; k++) if (!isKeyChar(line.charCodeAt(k))) { keyOk = false; break; }
    const rest = line.slice(colon + 1);
    if (!keyOk || (rest !== '' && rest.charCodeAt(0) !== 32)) return { error: 'line ' + (i + 2) + ' is not "key: value"' };
    const key = line.slice(0, colon);
    const raw = rest === '' ? '' : rest.slice(1).replace(/[ \t]+$/, '');
    if (KEYS.indexOf(key) === -1) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closePos >= text.length ? '' : text.slice(closePos) };
}

// ------------------------------------------------------------------ Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isSpaceTab(c) {
  return c === 32 || c === 9;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && isSpaceTab(line.charCodeAt(a))) a++;
  while (b > a && isSpaceTab(line.charCodeAt(b - 1))) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// The first index from `from` where `s` holds `what` outside a backslash
// escape, or -1. Mirrors the reference's findUnescaped.
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// The first single * from `from` (one whose run is not **), outside an
// escape, or -1. Mirrors the reference's findSingleStar.
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// `s` rendered inline; `env.link(target)` is a link's href. One shared
// global regex jumps from one markup character to the next in C++, so long
// plain runs cost one slice + one escape instead of a JavaScript loop per
// character. The regex's lastIndex is reset at each call and set explicitly
// after every recursive call, so the shared state is safe across recursion.
// Fast path: one combined scan first — a run with neither markup nor a
// character to escape is pushed as-is, with no escape scan at all.
const SPECIAL_RE = /[\\`*[]/g;
const ANY_SPECIAL_RE = /[\\`*&<>"'[]/g;
function inline(s, env, out) {
  const n = s.length;
  ANY_SPECIAL_RE.lastIndex = 0;
  if (ANY_SPECIAL_RE.exec(s) === null) {
    out.push(s);
    return;
  }
  SPECIAL_RE.lastIndex = 0;
  let plainStart = 0;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const j = m.index;
    const c = s[j];
    if (c === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      if (j > plainStart) out.push(esc(s.slice(plainStart, j)));
      out.push(esc(s[j + 1]));
      plainStart = j + 2;
      SPECIAL_RE.lastIndex = j + 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plainStart) out.push(esc(s.slice(plainStart, j)));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        plainStart = k + 1;
        SPECIAL_RE.lastIndex = k + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > plainStart) out.push(esc(s.slice(plainStart, j)));
          out.push('<strong>');
          inline(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          plainStart = k + 2;
          SPECIAL_RE.lastIndex = k + 2;
        } else {
          // No closer: the reference writes "**" as itself and moves past
          // both stars; skipping only one would let the second star open a
          // strong of its own.
          SPECIAL_RE.lastIndex = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > plainStart) out.push(esc(s.slice(plainStart, j)));
        out.push('<em>');
        inline(s.slice(j + 1, k), env, out);
        out.push('</em>');
        plainStart = k + 1;
        SPECIAL_RE.lastIndex = k + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const q = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = q === -1 ? '' : s.slice(k + 2, q);
      let hasWs = false;
      for (let t = 0; t < target.length; t++) {
        const tc = target.charCodeAt(t);
        if (tc === 32 || tc === 9 || tc === 10 || tc === 11 || tc === 12 || tc === 13) { hasWs = true; break; }
      }
      if (target !== '' && !hasWs) {
        if (j > plainStart) out.push(esc(s.slice(plainStart, j)));
        out.push('<a href="', esc(env.link(target)), '">');
        inline(s.slice(j + 1, k), env, out);
        out.push('</a>');
        plainStart = q + 1;
        SPECIAL_RE.lastIndex = q + 1;
      }
      continue;
    }
  }
  if (n > plainStart) out.push(esc(s.slice(plainStart, n)));
}

// Line kinds, computed once per line and reused by both the block loop and
// the paragraph/list continuation tests (the reference re-runs its regexes
// for every test, so the same line is classified several times).
const K_BLANK = 0, K_FENCE = 1, K_HEADING = 2, K_HR = 3, K_QUOTE = 4, K_BULLET = 5, K_ORDERED = 6, K_CONT = 7, K_PLAIN = 8;

// Classify every line of `lines` once: kinds plus, for the kinds that need
// it, the heading's depth/text, the fence's language and a list item's text
// and start number. One fused loop with direct char-code checks, so no
// helper is called per line and no line is classified twice.
function classifyLines(lines) {
  const n = lines.length;
  const kind = new Uint8Array(n);
  const aux = new Array(n);
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    const len = line.length;
    let j = 0;
    while (j < len) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) break;
      j++;
    }
    if (j === len) { kind[i] = K_BLANK; continue; }
    const c0 = line.charCodeAt(0);
    // Fence: ``` + language chars + spaces/tabs only.
    if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      let lang = '';
      let k = 3;
      let ok = true;
      for (; k < len; k++) {
        const c = line.charCodeAt(k);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) lang += line[k];
        else break;
      }
      for (; k < len; k++) {
        const c = line.charCodeAt(k);
        if (c !== 32 && c !== 9) { ok = false; break; }
      }
      if (ok) { kind[i] = K_FENCE; aux[i] = lang; continue; }
    }
    // Heading: 1-6 '#', a space/tab, non-empty text.
    if (c0 === 35) {
      let h = 0;
      while (h < len && line.charCodeAt(h) === 35) h++;
      if (h >= 1 && h <= 6 && h < len) {
        const ch = line.charCodeAt(h);
        if (ch === 32 || ch === 9) {
          let s = h;
          while (s < len && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
          let e = len;
          while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
          if (e > s) { kind[i] = K_HEADING; aux[i] = { depth: h, text: line.slice(s, e) }; continue; }
        }
      }
    }
    // Thematic break: --- or *** then spaces/tabs only.
    if ((c0 === 45 || c0 === 42) && len >= 3 && line.charCodeAt(1) === c0 && line.charCodeAt(2) === c0) {
      let ok = true;
      for (let k = 3; k < len; k++) {
        const c = line.charCodeAt(k);
        if (c !== 32 && c !== 9) { ok = false; break; }
      }
      if (ok) { kind[i] = K_HR; continue; }
    }
    // Blockquote.
    if (c0 === 62) { kind[i] = K_QUOTE; continue; }
    // Bullet: "- " or "* ".
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) { kind[i] = K_BULLET; aux[i] = line.slice(2); continue; }
    // Ordered: 1-9 digits + ". ".
    if (c0 >= 48 && c0 <= 57) {
      let k = 0;
      let num = 0;
      while (k < 9 && k < len) {
        const c = line.charCodeAt(k);
        if (c < 48 || c > 57) break;
        num = num * 10 + (c - 48);
        k++;
      }
      if (k > 0 && !(k < len && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) &&
          line.charCodeAt(k) === 46 && line.charCodeAt(k + 1) === 32) {
        kind[i] = K_ORDERED; aux[i] = { ordered: true, start: num, text: line.slice(k + 2) }; continue;
      }
    }
    // Continued: two or more spaces, then a non-whitespace character.
    if (c0 === 32 && line.charCodeAt(1) === 32) {
      let k = 0;
      while (k < len && line.charCodeAt(k) === 32) k++;
      if (k >= 2 && k < len) {
        const c = line.charCodeAt(k);
        const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 ||
          c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f ||
          c === 0x205f || c === 0x3000 || c === 0xfeff;
        if (!ws) { kind[i] = K_CONT; continue; }
      }
    }
    kind[i] = K_PLAIN;
  }
  return { kind, aux };
}

// Render one source's body: HTML, table of contents, excerpt and word count.
// `tmp` and `blocks` are reused across sources (rendering is single-threaded
// and neither escapes this function).
const MD_TMP = [];
const MD_BLOCKS = [];
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const { kind, aux } = classifyLines(lines);
  const ids = new Set();
  const blocks = MD_BLOCKS;
  blocks.length = 0;
  const toc = [];
  let excerpt = null;
  const tmp = MD_TMP;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const k = kind[i];
    if (k === K_BLANK) {
      i++;
      continue;
    }
    if (k === K_FENCE) {
      const lang = aux[i];
      const body = [];
      i++;
      while (i < n && !(kind[i] === K_FENCE && aux[i] === '')) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ' class="language-' + esc(lang) + '"';
      // Escaping the joined block once is the same as escaping each line:
      // '\n' is never an escaped character, so the boundaries do not matter.
      blocks.push('<pre><code' + cls + '>' + (body.length === 0 ? '' : esc(body.join('\n') + '\n')) + '</code></pre>');
      continue;
    }
    if (k === K_HEADING) {
      const heading = aux[i];
      const id = uniqueSlug(slugify(heading.text), ids);
      tmp.length = 0;
      inline(heading.text, env, tmp);
      const html = tmp.join('');
      blocks.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (k === K_HR) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (k === K_QUOTE) {
      const body = [];
      while (i < n && kind[i] === K_QUOTE) {
        const l = lines[i++];
        body.push(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (let q = 0; q < body.length; q++) {
        const t = trimLine(body[q]);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else {
        tmp.length = 0;
        inline(kept.join('\n'), env, tmp);
        blocks.push('<blockquote>\n<p>' + tmp.join('') + '</p>\n</blockquote>');
      }
      continue;
    }
    if (k === K_BULLET || k === K_ORDERED) {
      const isOrdered = k === K_ORDERED;
      const items = [];
      let start = 1;
      let first = true;
      while (i < n) {
        if (kind[i] === k) {
          if (first) {
            start = isOrdered ? aux[i].start : 1;
            first = false;
          }
          items.push([trimLine(isOrdered ? aux[i].text : aux[i])]);
          i++;
        } else if (kind[i] === K_CONT) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      let html = open + '\n';
      for (let q = 0; q < items.length; q++) {
        tmp.length = 0;
        inline(items[q].join('\n'), env, tmp);
        html += '<li>' + tmp.join('') + '</li>\n';
      }
      blocks.push(html + '</' + tag + '>');
      continue;
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break (any other line, quote, bullet,
    // ordered or continued, is paragraph text).
    const body = [trimLine(lines[i])];
    i++;
    while (i < n) {
      const kk = kind[i];
      if (kk === K_BLANK || kk === K_FENCE || kk === K_HEADING || kk === K_HR) break;
      body.push(trimLine(lines[i++]));
    }
    tmp.length = 0;
    inline(body.join('\n'), env, tmp);
    const html = tmp.join('');
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  let html = '';
  for (let q = 0; q < blocks.length; q++) html += blocks[q] + '\n';
  return { html, toc, excerpt: excerpt === null ? '' : excerpt, words: wordsOf(src) };
}

// ------------------------------------------------------------------ templates

class TemplateError extends Error {}

function isPathName(s) {
  if (s.length === 0) return false;
  const c0 = s.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) return false;
  for (let i = 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) return false;
  }
  return true;
}

function pathOf(name, text) {
  const parts = text.split('.');
  for (let k = 0; k < parts.length; k++) {
    if (!isPathName(parts[k])) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  }
  return parts;
}

function isWsOnly(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isWsOnly(src, lineStart, open) && isWsOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseFor(name, tag) {
  // {% for x in path %}: x a name, path any non-space run.
  if (!tag.startsWith('for ')) return null;
  const rest = tag.slice(4);
  const sp = rest.indexOf(' ');
  if (sp === -1) return null;
  const v = rest.slice(0, sp);
  if (!isPathName(v)) return null;
  if (!rest.slice(sp + 1).startsWith('in ')) return null;
  const p = rest.slice(sp + 4);
  if (p === '' || /\s/.test(p)) return null;
  return { name: v, path: pathOf(name, p) };
}

function parseIf(name, tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '' || /\s/.test(rest)) return null;
  return { not, path: pathOf(name, rest) };
}

function parseInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"')) return null;
  const inner = tag.slice(9, -1);
  if (inner.length === 0) return null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = parseFor(name, tag)) !== null) {
        const node = { kind: 'for', name: m.name, path: m.path, body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = parseIf(name, tag)) !== null) {
        const node = { kind: 'if', not: m.not, path: m.path, then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
      } else if ((m = parseInclude(tag)) !== null) body.push({ kind: 'include', name: m });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out += ', ';
      out += textOf(v[k]);
    }
    return out;
  }
  return '';
}

// A template `{{ }}` value as escaped text. Numbers and booleans never hold
// a character to escape, so they skip the escape scan entirely; only strings
// and arrays go through it.
function varText(v) {
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return esc(textOf(v));
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Tree-walk renderer for the parsed template nodes. Under --no-opt the
// codegen's `new Function` compile cost is not repaid (no TurboFan to make
// the generated code fast), so the tree walk wins: no per-template compile,
// the same helpers, and the same semantics as the reference's renderNodes.
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(varText(lookup(scope, n.path)));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ the build

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date === undefined ? '' : s.data.date, date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date === undefined ? '' : s.data.date,
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary === undefined ? '' : s.data.summary,
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s, cards) {
  // A post's card is already in the cards map; reuse it instead of building
  // the same card a second time.
  const c = s.post ? { ...cards.get(s) } : cardOf(s);
  c.slug = s.slug;
  c.content = s.html;
  c.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  c.newer = linkOf(s.newer === undefined ? null : s.newer);
  c.older = linkOf(s.older === undefined ? null : s.older);
  c.is_post = s.post;
  return c;
}

export function run(input) {
  slugCache.clear();
  dateCache.clear();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const b = {
    input,
    base,
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. Sources, sorted by path in code-unit order; line ends made "\n".
  // The input is this run's own parsed copy, so it may be sorted in place.
  const files = input.files.sort((x, y) => byCodeUnits(x.path, y.path));
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    if (f.path.endsWith('.md')) {
      b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in source order.
  const kept = [];
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      b.report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Permalinks.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = b.base + '/' + s.outDir + '/';
    b.bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set();
  for (let k = 0; k < b.statics.length; k++) staticPaths.add(b.statics[k].path);
  const pathCache = new Map();
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        // Scheme? [A-Za-z][A-Za-z0-9+.-]*:  or starts with / or #.
        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35) return target;
        if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
          for (let q = 1; q < target.length; q++) {
            const c = target.charCodeAt(q);
            if (c === 58) return target;
            if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) break;
          }
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(pathCache, dir, rel);
        // One Map lookup: get() returns undefined for a path that is not a
        // source, so has() + get() would pay the lookup twice per link.
        const hit = path === null ? undefined : b.bySource.get(path);
        if (hit !== undefined) return hit.url + frag;
        if (path !== null && staticPaths.has(path)) return b.base + '/' + path + frag;
        b.broken.add('broken-link ' + s.path + ' -> ' + target);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags === undefined ? [] : s.data.tags;
    for (let k = 0; k < tags.length; k++) {
      const name = tags[k];
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (let k = 0; k < b.posts.length; k++) {
    const p = b.posts[k];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: b.base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    if (s.post) continue;
    const names2 = ownTags(s);
    s.tagRefs = [];
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      const tag = bySlug.get(slug);
      s.tagRefs.push(tag !== undefined ? tag : { name, slug, url: '', posts: [] });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page, index and tag page through its template.
  for (let k = 0; k < b.posts.length; k++) b.cards.set(b.posts[k], cardOf(b.posts[k]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates };
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    // Every render passes one of {page}, {posts, pager}, {tag} or {}: the
    // four keys are set literally (undefined where absent), which reads the
    // same through lookup as spreading only the given keys.
    const rootVars = { site, tags: allTags, recent, page: vars.page, posts: vars.posts, pager: vars.pager, tag: vars.tag };
    const out = [];
    renderNodes(nodes, { vars: rootVars, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    b.output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s, b.cards) });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? b.base + '/' : b.base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let k = 0; k < b.tags.length; k++) {
    const t = b.tags[k];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) } });
    if (html !== null) b.output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (let k = 0; k < b.statics.length; k++) {
    const f = b.statics[k];
    if (Object.hasOwn(b.output, f.path)) b.report.push('shadowed ' + f.path + ': a built page has its path');
    else b.output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let k = 0; k < b.sources.length; k++) if (!b.sources[k].post) pageCount++;
  lines.push('built ' + pageCount + ' pages, ' + b.posts.length + ' posts, ' + b.tags.length + ' tags and ' + b.statics.length + ' static files');
  b.output['build-report.txt'] = lines.join('\n') + '\n';
  return b.output;
}
