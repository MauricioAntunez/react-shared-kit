/**
 * Pure text transforms shared across `./perf` gates. INTERNAL ONLY — not re-exported from
 * `./index.ts`'s barrel (same convention as `./errors.ts`).
 *
 * Lives here, rather than on `fontChain.ts` (their original home) or `danglingClasses.ts`, because
 * both modules need them and neither should depend on the other for a domain reason it doesn't
 * have. `fontChain.ts` re-exports them through its own `internal` test-seam object (see that
 * file) so its existing round-5 substitution tests keep working; `danglingClasses.ts` imports
 * these plain functions directly, not through `fontChain.ts`'s seam (a production module must not
 * depend on a sibling module's test-only indirection point — see the K3 fix in
 * docs/superpowers/plans/2026-08-30-perf-gates-review-fixes.md).
 *
 * HARDENED 2026-09-01 by merging in a char-walked implementation from a sibling project's
 * `boufin/scripts/verify-font-preload.ts` (a build-time font-preload gate with the exact same
 * "is this markup live or dead" problem). The plain-regex versions both had a shared defect class:
 * a regex has no notion of "inside a string" or "inside a script body", so `/*` or `<!--`
 * appearing inside a quoted CSS string, a quoted HTML attribute value, or a `<script>`/`<style>`
 * body could open a comment that was never live to a browser — deleting real CSS between two
 * unrelated tokens, or (worse) leaving a JS/CSS string literal that merely LOOKS like a comment
 * opener untouched so it goes on to be misread as a real tag by a later regex-based scanner. Every
 * behaviour this file's callers (`fontChain.ts`, `danglingClasses.ts`) already depended on and
 * documented — the non-quadratic HTML scan, abrupt-closing comment forms, and `unterminated`
 * reporting — is preserved; see each function's doc comment for how.
 */

/** Index just past the end of a quoted string that OPENS at `source[start - 1]` (the quote
 * character itself), honouring backslash escapes so `\"` does not end a `"` string. Returns
 * `source.length` for an unterminated string — there is no valid close to report, and the caller
 * treats "ran off the end" as "the rest of the source is inside this string": nothing after an
 * unterminated string can be a comment opener either. Shared by the CSS string-awareness below and
 * the HTML in-tag quote-awareness in `stripHtmlComments`. */
function stringEnd(source: string, start: number, quote: string): number {
  let i = start;
  while (i < source.length) {
    const char = source.charAt(i);
    if (char === '\\') {
      i += 2; // skip the escaped character too, quote or not
      continue;
    }
    if (char === quote) return i + 1;
    i++;
  }
  return source.length;
}

/** Strips `/* ... *\/` comments so a commented-out `@import`/`@font-face`/CSS-Modules selector is
 * never treated as live.
 *
 * STRING-AWARE, CHAR-WALKED (merged from boufin's `stripCssComments`): a `/*` inside a quoted
 * string literal (e.g. `content: "/* not a comment";`) is NOT a comment opener. The prior plain
 * regex (`css.replace(/\/\*[\s\S]*?\*\//g, '')`) had no way to know it was inside a string — one
 * such literal anywhere in a file could open a "comment" that a later, unrelated `*\/` then
 * closed, silently deleting everything between, whole `@font-face` blocks included.
 *
 * UNTERMINATED `/*` STRIPS TO EOF, matching how a browser parses broken CSS — this is a behaviour
 * CHANGE from the prior version, which left an unterminated `/*` in the output untouched (a regex
 * with no match makes no replacement). A declaration after an unclosed `/*` genuinely does not
 * apply in a real stylesheet, so leaving it in place understated the damage of a truncated build
 * artifact.
 *
 * Stays linear even on a pathological unterminated-opener input: its 3-char opener (`/*`) and
 * closer (`*\/`) share no characters, so — unlike the HTML comment scan below — there is no
 * overlap for a naive implementation to re-scan. Char-walking here is not a performance fix, only
 * the string-awareness is; see `stripHtmlComments`'s doc comment for the scan that DOES need the
 * non-regex rewrite for performance reasons. */
export function stripComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const char = css.charAt(i);
    if (char === '"' || char === "'") {
      const end = stringEnd(css, i + 1, char);
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (char === '/' && css.charAt(i + 1) === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/** Result of `stripHtmlComments`: the comment-stripped text, plus whether the input contained an
 * unterminated `<!--` that forced everything from that point on to be stripped to end of string.
 * Callers MUST check `unterminated` and report it as its own explicit problem (round-2 review
 * MUST-FIX #2) — see the function doc comment below for why silence here is itself a defect. */
export interface StripHtmlCommentsResult {
  text: string;
  unterminated: boolean;
}

/** Lowercases one ASCII letter without a regex. `toLowerCase()` on a single char is fine, but the
 * caller builds a tag name char by char and a named helper reads better than inlining the
 * arithmetic. */
function toLowerAscii(char: string): string {
  const code = char.charCodeAt(0);
  return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char;
}

/** A real HTML tag name character: ASCII letter, digit, or hyphen (custom elements). Bounding
 * `tagNameAt` to this charset — rather than "anything but whitespace/`/`/`>`" — is load-bearing
 * for performance, not just correctness: an input like `'<!--'.repeat(20000)` has no `>` anywhere,
 * so an unbounded scan starting after each `<` would run to end-of-string on EVERY `<!--`
 * encountered, making the raw-text pre-pass below (`blankRawText`, called once per character)
 * quadratic on exactly the pathological shape `stripHtmlComments` exists to stay linear on. */
function isTagNameChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 45
  );
}

/** The tag name starting at `i` (just after `<` or `</`), lowercased, read up to the first
 * character that is not a valid tag-name character (see `isTagNameChar`). No regex — walked char
 * by char, same style as the rest of this file. */
function tagNameAt(source: string, i: number): string {
  let name = '';
  let j = i;
  while (j < source.length) {
    const char = source.charAt(j);
    if (!isTagNameChar(char)) break;
    name += toLowerAscii(char);
    j++;
  }
  return name;
}

/** `'script' | 'style'` if the tag OPENING at `ltIndex` (i.e. `source[ltIndex] === '<'`, not
 * `</...>`) is a raw-text element THIS CALL treats as blankable, else `null`. Case-insensitive
 * (`<SCRIPT>`, `<Style>`), matching how browsers parse tag names.
 *
 * `blankStyleBodies` gates whether `<style>` counts here at all — `<script>` always does (see
 * `blankRawText`'s doc comment for why the two are no longer symmetric). When `blankStyleBodies`
 * is `false`, a `<style>` tag returns `null` here, i.e. it is not treated as raw text at all:
 * `blankRawText` then falls through to its ordinary char-by-char copy for it, leaving the tag and
 * its real CSS body completely untouched (including any `<!--` inside it, which flows on to the
 * ordinary comment scan in `stripHtmlComments` exactly as it did before this file's raw-text
 * blanking existed).
 *
 * Split out purely to keep `blankRawText`'s own branch count under the lint complexity budget. */
function rawTextTagName(
  source: string,
  ltIndex: number,
  blankStyleBodies: boolean,
): 'script' | 'style' | null {
  if (source.charAt(ltIndex + 1) === '/') return null; // a close tag never OPENS a raw-text element
  const name = tagNameAt(source, ltIndex + 1);
  if (name === 'script') return 'script';
  if (name === 'style' && blankStyleBodies) return 'style';
  return null;
}

/** Index just past the `>` that closes the OPENING tag starting at `ltIndex`, quote-aware so a `>`
 * inside a quoted attribute value (e.g. `<script data-x="a>b">`) does not end the tag early. Used
 * only to find where a `<script>`/`<style>` opening tag ends, so `blankRawText` knows where that
 * element's body begins. */
function openingTagEnd(source: string, ltIndex: number): number {
  let i = ltIndex + 1;
  while (i < source.length) {
    const char = source.charAt(i);
    if (char === '"' || char === "'") {
      i = stringEnd(source, i + 1, char);
      continue;
    }
    if (char === '>') return i + 1;
    i++;
  }
  return source.length;
}

/** `bodyEnd`: index where a raw-text element's content ends — just before its closing tag, or EOF
 * when there is none. `tagEnd`: index just past that closing tag (equal to `bodyEnd` when there is
 * none — an unclosed element has no close tag to be "past"). Everything from `i` to `bodyEnd` is
 * OPAQUE: inside `<script>`/`<style>`, `<!--` and `-->` are ordinary characters to a browser's HTML
 * tokenizer, not a comment opener (the ECMA-262 Annex B `<!--` line-comment idiom, and any
 * decrement-compare like `i-->0`, both rely on exactly this) — so the caller BLANKS this span
 * rather than copying it verbatim (see `blankRawText`): copying it through would let a
 * `<link ...>`-shaped JS or CSS string literal register as a real tag to a later regex-based
 * scanner reading the stripped output — the same class of false match this file exists to close.
 * A close tag is matched case-insensitively. No close tag found means the element runs to EOF, the
 * same way a browser's tokenizer treats an unclosed `<script>` as consuming the rest of the
 * document.
 *
 * NOT "the first `</script>` wins" — that was this function's behaviour until 2026-09-03 and it
 * was a live bypass. `<!--` inside script data enters the WHATWG SCRIPT-DATA-ESCAPED state, and a
 * `<script` inside THAT enters SCRIPT-DATA-DOUBLE-ESCAPED, in which `</script>` does NOT close the
 * element — a second one is required. `level` below tracks exactly those three states (0 script
 * data, 1 escaped, 2 double escaped); `-->` returns to 0 from either escaped state. Reading
 * `<script><!--<script></script>--><link rel=preload as=font href=/x.woff2></script>` the old way
 * ended the body at the FIRST `</script>`, emitting a `<link rel=preload>` that is script CONTENT
 * to a browser as a live tag into the stripped output. That is the false-EXEMPTION direction: a
 * later regex scanner counts it as a real preload, so a font gate can report a document compliant
 * on the strength of a preload that does not exist in the DOM.
 *
 * KNOWN, DELIBERATE DIVERGENCES from a full spec tokenizer — both PRE-DATE the 2026-09-03 fix and
 * both are pinned as enumerated divergences in `text.differential.test.ts`, not accidents:
 *   1. the `>` ending a close tag is found with `indexOf`, so `</script foo="a>b">` ends early;
 *   2. a close tag is not required to be followed by whitespace/`/`/`>`, so `</script"` matches.
 * Both are the same false-exemption direction as the bug above. Widening this function to the full
 * ~18-state ladder was considered and deferred: the differential harness is what bounds the risk
 * either way, and a fix pass over these gates has a measured history of introducing more defects
 * than it closes. Do not close either one without re-running that harness. */
/** The characters that may FOLLOW a tag name and still leave it a real tag name: whitespace, `/`,
 * `>`. WHATWG uses this same delimiter set on both sides of the distinction — it is what makes an
 * end tag "appropriate", and what terminates the name run in double-escape-start. The only call
 * site here is the latter (`isScriptOpenAt`, matching an OPENING `<script`); the close branch in
 * `stepAtLessThan` deliberately does NOT consult it, which is enumerated divergence #2. Named
 * after the spec concept rather than extracted to satisfy a lint budget. */
function isTagNameDelimiter(char: string): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\f' ||
    char === '\r' ||
    char === '/' ||
    char === '>'
  );
}

function isScriptOpenAt(source: string, lt: number): boolean {
  return tagNameAt(source, lt + 1) === 'script' && isTagNameDelimiter(source.charAt(lt + 7));
}

/** How deeply a `<script>` body is nested in the WHATWG script-data escape ladder. The full spec
 * has ~18 states; only these three are observable in `{ bodyEnd, tagEnd }`, because the dash and
 * dash-dash sub-states are recoverable by `isEscapeEndAt`'s literal `-->` scan. `</script>` closes
 * from `data` and `escaped`, and NEVER from `doubleEscaped`. */
type ScriptDataLevel = 'data' | 'escaped' | 'doubleEscaped';

/** Either the raw-text element ends here, or scanning continues at `next` with `level`. A union,
 * not a record with a `close` flag: on the closing arm there is no meaningful `level` or `next`,
 * and the type is what stops a later edit from reading one. */
type RawTextStep = { close: true } | { close: false; level: ScriptDataLevel; next: number };

function stepAtLessThan(
  source: string,
  lt: number,
  tagName: 'script' | 'style',
  level: ScriptDataLevel,
): RawTextStep {
  if (source.charAt(lt + 1) === '/' && tagNameAt(source, lt + 2) === tagName) {
    return level === 'doubleEscaped'
      ? { close: false, level: 'escaped', next: lt + 2 }
      : { close: true };
  }
  if (tagName === 'script' && level === 'escaped' && isScriptOpenAt(source, lt)) {
    return { close: false, level: 'doubleEscaped', next: lt + 7 };
  }
  if (tagName === 'script' && level === 'data' && source.startsWith('<!--', lt)) {
    // Resume at the FIRST dash, not past all four characters: the spec's escape-start-dash /
    // escaped-dash-dash states mean the very next `>` still returns to script data, so the abrupt
    // forms `<!-->` and `<!--->` must reset the ladder. Skipping to `lt + 4` hid those dashes from
    // `isEscapeEndAt` and left the level stuck at escaped, where a later `<script` promoted to
    // double-escaped and swallowed the rest of the document.
    return { close: false, level: 'escaped', next: lt + 2 };
  }
  return { close: false, level, next: lt + 1 };
}

/** `-->` ends BOTH escaped states, returning all the way to `data` — not to `escaped`. Landing in
 * `escaped` instead would let a following `<script` re-promote to `doubleEscaped`, after which
 * `</script>` stops closing and the rest of the document is blanked (pinned by a named case in
 * `text.differential.test.ts`; the seeded generator does not reach that shape on its own). */
function isEscapeEndAt(source: string, j: number, level: ScriptDataLevel): boolean {
  return level !== 'data' && source.charAt(j) === '-' && source.startsWith('-->', j);
}

function rawTextSpan(
  source: string,
  i: number,
  tagName: 'script' | 'style',
): { bodyEnd: number; tagEnd: number } {
  const eof = { bodyEnd: source.length, tagEnd: source.length };
  let level: ScriptDataLevel = 'data';
  let j = i;
  while (j < source.length) {
    const char = source.charAt(j);
    if (char === '<') {
      const step = stepAtLessThan(source, j, tagName, level);
      if (step.close) {
        const gt = source.indexOf('>', j);
        return gt === -1 ? eof : { bodyEnd: j, tagEnd: gt + 1 };
      }
      level = step.level;
      j = step.next;
      continue;
    }
    if (isEscapeEndAt(source, j, level)) {
      level = 'data';
      j += 3;
      continue;
    }
    j++;
  }
  return eof;
}

/** Pre-pass run BEFORE comment stripping: blanks the BODY of every raw-text element this call
 * treats as blankable (see `rawTextSpan`'s doc comment for why a blanked body must not be copied
 * through), while leaving the opening tag, the closing tag, and everything else in the document
 * untouched. Doing this as a separate pass — rather than folding raw-text detection into the
 * comment/quote state machine in `stripHtmlComments` — keeps that machine's own branch count
 * small: raw-text handling has no interaction with comment or quote state, so it does not belong
 * nested inside that loop's branches.
 *
 * `<script>` ALWAYS BLANKS (`blankStyleBodies` does not affect it): `var x = "<!--";` inside a
 * `<script>` body, scanned by the comment loop directly with no pre-pass, opens what looks like a
 * real HTML comment at the quote's `<!--` and swallows everything up to the next unrelated `-->`
 * — including a genuine `<link rel="preload">` that follows it. No kit gate has a legitimate
 * reason to read a script body as markup or as CSS, so there is no view that ever needs it
 * unblanked.
 *
 * `<style>` blanks ONLY WHEN `blankStyleBodies` IS `true` — see `stripHtmlComments`'s doc comment
 * for the two consumers this serves and why they disagree. */
function blankRawText(source: string, blankStyleBodies: boolean): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const tagName = source.charAt(i) === '<' ? rawTextTagName(source, i, blankStyleBodies) : null;
    if (tagName === null) {
      out += source.charAt(i);
      i++;
      continue;
    }
    const openEnd = openingTagEnd(source, i);
    const { bodyEnd, tagEnd: closeEnd } = rawTextSpan(source, openEnd, tagName);
    out += source.slice(i, openEnd);
    out += ' ';
    out += source.slice(bodyEnd, closeEnd);
    i = closeEnd;
  }
  return out;
}

/** `<` opens a tag, `>` closes it — the only two characters that change `inTag` state. Split out
 * purely to keep `stripHtmlComments`'s own branch count under the lint complexity budget. */
function nextTagState(inTag: boolean, char: string): boolean {
  if (char === '<') return true;
  if (char === '>') return false;
  return inTag;
}

/** Strips `<!-- ... -->` comments so a commented-out `<link rel="preload">`/`<link
 * rel="stylesheet">`/inline `<style>`/`class="..."` attribute is never treated as live (CRITICAL 1
 * finding, review round 2026-08-30). Applied to the whole document text before any HTML is
 * scanned for classes, preload links, or inline `@font-face` blocks — leftover debug markup
 * silencing a real defect is the same error class these gates exist to catch.
 *
 * MANUAL SCAN, NOT A REGEX (HIGH review finding, 2026-08-30): `html.replace(/<!--[\s\S]*?-->/g,
 * '')` is quadratic on an unterminated `<!--` — the opener (4 chars: `<`, `!`, `-`, `-`) shares
 * its last two characters with the 3-char closer (`-->`), so after each failed match the lazy
 * quantifier re-scans overlapping tail content looking for a `-->` that never arrives. Measured:
 * 160,000 repeats of `<!--` (~640KB) took over 18 SECONDS; ~4MB of the same shape extrapolates to
 * hours. This runs on FILE CONTENT, not consumer config — a broken template emitting a stray
 * `<!--` (a template engine bug, a truncated build artifact) is an accident, not an attacker, and
 * it must not be able to hang the build with no cap and no escape. The char-walk below (like the
 * `blankRawText` pre-pass and the quote-tracking it adds) is still linear: each position is
 * visited once, with no re-scanning of overlapping tail content, which is what "not quadratic"
 * actually requires — it is not specific to the original indexOf-only shape.
 *
 * TWO LAYERS MERGED HERE:
 *
 * 1. RAW-TEXT BLANKING (`blankRawText`, run first): a `<!--` inside a `<script>`/`<style>` BODY
 *    is not a comment opener to a browser's HTML tokenizer at all (see `rawTextSpan`'s doc
 *    comment) — the body is blanked, not scanned, so a JS string shaped like `"<!--"` can never
 *    swallow real markup that follows it.
 * 2. QUOTE-AWARE, IN-TAG ONLY (the loop below): a `<!--` inside a quoted attribute value BETWEEN
 *    `<` and `>` (e.g. `<div data-x="<!--">`) opens no comment either — only `<!--` in ordinary
 *    document text, outside any tag, is a real comment opener. A stray quote character in
 *    ordinary text must not suppress it, which is why quote-tracking is scoped to `inTag` only.
 *
 * `options.blankStyleBodies` (default `false`) — BLANKING IS A PROPERTY OF THE SCAN, NOT OF THE
 * DOCUMENT, because this package has two callers that need two different views of the SAME
 * `<style>` body, and neither view is "more correct" in general:
 *
 *   - `fontChain.ts` reads REAL CSS out of an inline `<style>` block (its
 *     `extractInlineFontFaceUrls` looks for an actual `@font-face { ... }` declared in the
 *     document head, which is one of the two shapes that legitimately exempts a font from
 *     `deep-font` — see that module's doc comment). Blanking the body would destroy the very
 *     content that call exists to read: an inline `@font-face` for `/x.woff2` would vanish, and a
 *     font correctly exempted today would wrongly start reporting `deep-font`. This is EXACTLY the
 *     regression this default guards — reproduced and reverted before landing this behaviour
 *     (2026-09-01).
 *   - A caller that only ever hunts `<link ...>`-shaped tags in HTML (the forthcoming
 *     `verifyFontPreload` gate, and boufin's own `verify-font-preload.ts` this file was merged
 *     from) never reads inline CSS, so for it a `<link rel="preload" ...>`-SHAPED STRING LITERAL
 *     sitting in a `<style>` body (e.g. `content: "<link rel=preload as=font href=/fake.woff2>"`)
 *     is a pure liability: left unblanked, that text would survive into the stripped output and
 *     get misread by a later regex-based `<link>` scanner as a real preload tag. That caller MUST
 *     pass `{ blankStyleBodies: true }`.
 *
 * `<script>` has no such split — no kit gate ever has a legitimate reason to read a script body as
 * markup or as CSS — so it is blanked unconditionally regardless of this option (see
 * `blankRawText`'s doc comment).
 *
 * DO NOT "simplify" this back to one behaviour for both tags: doing so either breaks
 * `fontChain.ts`'s inline-style font detection (if you default to blanking `<style>`) or reopens
 * the `<link>`-shaped-string-literal false-match this merge exists to close for a preload-only
 * scanner (if you never blank it). Each caller must state which view it needs.
 *
 * CLOSER SEARCH STARTS AT `openIndex + 2`, NOT `+ 4` (round-2 review MUST-FIX #1 — `+ 4` skipped
 * past the HTML spec's ABRUPT-CLOSING comment forms `<!-->` and `<!--->`, complete and harmless
 * per the HTML Standard's "Comments" section, and browsers accept them as such). `<!--` occupies
 * offsets 0-3 of the opener; the closer `-->` of `<!-->` sits at offsets 1-3 — INSIDE those same
 * four characters, reusing the comment's own two dashes. Starting the closer search at `+ 4`
 * therefore never even looks at the position where the closer legally begins, finds no `-->`
 * anywhere later in a document that has nothing else, and falls into "unterminated" — silently
 * stripping every byte after the stray `<!-->` to the end of the string. Starting at `+ 2` (past
 * only the two literal dashes that the closer is allowed to reuse) finds both abrupt-closing forms
 * correctly: `<!-->` closes at relative index 2 → an empty comment; `<!--->` closes at relative
 * index 3 → also an empty comment (its extra `-` is inside the comment body, not part of the
 * closer); `<!---> stuff -->` closes the SAME way at index 3, so the comment is exactly `<!--->`
 * and ` stuff -->` remains as ordinary text following it.
 *
 * BEHAVIOUR ON AN UNTERMINATED TRAILING `<!--`: strips to the end of the string, same choice as
 * before — this matches how a real browser parses an unterminated HTML comment. This is no longer
 * silent: `result.unterminated` is `true`, so a caller can report a genuinely truncated document
 * as a build defect rather than let it read as a clean pass (round-2 review MUST-FIX #2) — the
 * reference implementation this scan was merged from strips silently and does NOT report this;
 * that silence is deliberately NOT carried over here, since it would regress a MUST-FIX this
 * package's own callers (`fontChain.ts`, `danglingClasses.ts`) already depend on. A browser's job
 * is to render something reasonable for broken markup; this package's job is the opposite — catch
 * the build defect before it ships — so matching the renderer's silence past this point would be
 * modelling the wrong system.
 */
export function stripHtmlComments(
  html: string,
  options?: { blankStyleBodies?: boolean },
): StripHtmlCommentsResult {
  const { blankStyleBodies = false } = options ?? {};
  const source = blankRawText(html, blankStyleBodies);
  let result = '';
  let i = 0;
  let inTag = false;
  while (i < source.length) {
    const char = source.charAt(i);
    if (inTag && (char === '"' || char === "'")) {
      const end = stringEnd(source, i + 1, char);
      result += source.slice(i, end);
      i = end;
      continue;
    }
    if (!inTag && source.startsWith('<!--', i)) {
      const closeIndex = source.indexOf('-->', i + 2);
      if (closeIndex === -1) {
        // Unterminated: the rest of the document is inside the comment (see doc comment above).
        // Reported to the caller via `unterminated`, never silently — see StripHtmlCommentsResult.
        return { text: result, unterminated: true };
      }
      i = closeIndex + 3;
      continue;
    }
    inTag = nextTagState(inTag, char);
    result += char;
    i++;
  }
  return { text: result, unterminated: false };
}
