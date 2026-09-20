import { describe, expect, it } from 'vitest';
import { stripHtmlComments } from './text.ts';

/**
 * Differential harness for the raw-text tokenizer in `text.ts` (`rawTextSpan`, `blankRawText`,
 * `stepAtLessThan`, `isScriptOpenAt`, `isEscapeEndAt`). Spec: `docs/superpowers/specs/
 * 2026-09-03-rawtext-tokenizer-design.md`, sections 3.1-3.3.
 *
 * ORACLE METHOD: `referenceRawTextSpan` / `referenceBlankRawText` below are written FROM THE SPEC
 * TEXT ONLY — the WHATWG state tables in §3.1/§3.2 and the end-tag rule in §3.3 — never by reading
 * `text.ts`'s implementation. An oracle derived from the implementation would agree with the
 * implementation's own bugs and prove nothing.
 *
 * GENERATOR CONSTRAINT (real harness limitation, not hidden): `stripHtmlComments` runs the raw-text
 * blanking pass and THEN strips HTML comments found in the remaining (non-raw-text) document. To
 * compare directly against a raw-text-only oracle, the generator below NEVER emits `<!--`/`-->` at
 * document level — only ever inside a script/style body it is composing. With no document-level
 * comment, the comment-stripping stage is a no-op, so `stripHtmlComments(input, { blankStyleBodies:
 * true }).text` equals `referenceBlankRawText(input, true)` exactly.
 */

// ---------------------------------------------------------------------------------------------
// 1. Reference oracle, from the spec state tables (§3.1 RAWTEXT, §3.2 SCRIPT DATA ladder, §3.3
//    end-tag recognition). Parametrized by two flags so the SAME state machine can also produce
//    the two KNOWN, DOCUMENTED divergences from §5 / `rawTextSpan`'s doc comment — that lets the
//    fuzz harness (§4 below) recognize a divergence by EQUIVALENCE to the documented bug's own
//    output, rather than by guessing at a regex shape.
// ---------------------------------------------------------------------------------------------

type CloseResult = { bodyEnd: number; tagEnd: number };

interface CloseTagOptions {
  /** §3.3: locate the closer `>` quote-aware. False reproduces divergence #1 (plain `indexOf`). */
  quoteAwareClose: boolean;
  /** §3.3: require whitespace/`/`/`>` right after the matched name. False reproduces divergence
   * #2 (name match alone is treated as an appropriate end tag). */
  requireDelimiter: boolean;
}

const SPEC_CONFORMANT: CloseTagOptions = { quoteAwareClose: true, requireDelimiter: true };

function isAsciiAlpha(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
}

function isDelimiter(char: string): boolean {
  return (
    char === '' ||
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\f' ||
    char === '\r' ||
    char === '/' ||
    char === '>'
  );
}

/** Index just past the closing quote matching `source.charAt(i)`, or EOF when none is found. */
function skipQuotedValue(source: string, i: number): number {
  const quote = source.charAt(i);
  let k = i + 1;
  while (k < source.length && source.charAt(k) !== quote) k++;
  return k < source.length ? k + 1 : source.length;
}

/** Quote-aware search for the `>` that closes a tag whose name starts at `nameStart` (spec §3.3 —
 * modelled on `openingTagEnd`'s own quote handling). Returns the index just past that `>`, or -1
 * if none is found before EOF. */
function findQuoteAwareTagEnd(source: string, nameStart: number): number {
  let k = nameStart;
  while (k < source.length) {
    const char = source.charAt(k);
    if (char === '"' || char === "'") {
      k = skipQuotedValue(source, k);
      continue;
    }
    if (char === '>') return k + 1;
    k++;
  }
  return -1;
}

/** Plain (non-quote-aware) search for the closer `>`, reproducing divergence #1. */
function findPlainTagEnd(source: string, nameStart: number): number {
  const idx = source.indexOf('>', nameStart);
  return idx === -1 ? -1 : idx + 1;
}

/** A real HTML tag name character: ASCII letter, digit, or hyphen (custom elements) — the same
 * charset a shared `tagNameAt`-style helper bounds itself to (verified black-box: `</styleSTYLE`
 * does NOT match `style` — the greedy name run is `styleSTYLE`, not a `style` prefix — while
 * `</style<foo>` DOES, its run stopping cleanly at `style`). */
function isTagNameChar(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '-'
  );
}

/** Greedily reads the run of tag-name characters starting at `start`, lowercased. */
function readTagNameRun(source: string, start: number): string {
  let k = start;
  while (k < source.length && isTagNameChar(source.charAt(k))) k++;
  return source.slice(start, k).toLowerCase();
}

/** True when `source[nameStart..]` is an appropriate end tag for `tagName` under `opts`: the
 * GREEDY tag-name-char run starting at `nameStart` equals `tagName` EXACTLY (so `styleSTYLE` never
 * matches `style` — it is a longer run, not a prefix match) and, when `requireDelimiter`, the
 * character right after that run is whitespace, `/`, `>`, or EOF (spec §3.3's appropriate-end-tag
 * rule). With `requireDelimiter: false` (the real, documented divergence #2), any non-tag-name-char
 * boundary is accepted — not spec's narrower whitespace/`/`/`>` set. */
function matchesEndTagName(
  source: string,
  nameStart: number,
  tagName: string,
  opts: CloseTagOptions,
): boolean {
  const name = readTagNameRun(source, nameStart);
  if (name !== tagName) return false;
  if (!opts.requireDelimiter) return true;
  return isDelimiter(source.charAt(nameStart + tagName.length));
}

function findTagEnd(source: string, nameStart: number, opts: CloseTagOptions): number {
  return opts.quoteAwareClose
    ? findQuoteAwareTagEnd(source, nameStart)
    : findPlainTagEnd(source, nameStart);
}

/** §3.1 RAWTEXT state machine — used for `<style>`. No escape ladder: the only exit is an
 * appropriate `</style` end tag. */
function referenceRawTextSpanStyle(source: string, i: number, opts: CloseTagOptions): CloseResult {
  let j = i;
  while (j < source.length) {
    if (source.charAt(j) === '<' && source.charAt(j + 1) === '/') {
      const nameStart = j + 2;
      if (matchesEndTagName(source, nameStart, 'style', opts)) {
        const tagEnd = findTagEnd(source, nameStart, opts);
        if (tagEnd !== -1) return { bodyEnd: j, tagEnd };
      }
    }
    j++;
  }
  return { bodyEnd: source.length, tagEnd: source.length };
}

/** §3.2 SCRIPT DATA ladder — used for `<script>`. States named as the spec names them:
 * 'data' | 'escaped' | 'escaped-dash' | 'escaped-dash-dash' |
 * 'double-escaped' | 'double-escaped-dash' | 'double-escaped-dash-dash'.
 * An appropriate `</script` end tag closes the element from 'data' or any 'escaped*' state, but
 * NEVER from any 'double-escaped*' state (the load-bearing consequence of §3.2) — there, an
 * appropriate name match is "double escape end": it walks the state back to 'escaped' without
 * closing. Entry to 'double-escaped' happens only via "double escape start": from an 'escaped*'
 * state, `<` followed by an ASCII alpha run that spells exactly "script" then a delimiter. */
type ScriptState =
  | 'data'
  | 'escaped'
  | 'escaped-dash'
  | 'escaped-dash-dash'
  | 'double-escaped'
  | 'double-escaped-dash'
  | 'double-escaped-dash-dash';

type ScriptStep = { close?: CloseResult; state: ScriptState; j: number };

function isDoubleEscapedFamily(s: ScriptState): boolean {
  return s.startsWith('double-escaped');
}

function isEscapedFamily(s: ScriptState): boolean {
  return s === 'escaped' || s === 'escaped-dash' || s === 'escaped-dash-dash';
}

/** `-` transition: walks the dash-count for whichever ladder family `state` is currently in. */
function dashTransition(state: ScriptState): ScriptState {
  if (state === 'escaped') return 'escaped-dash';
  if (state === 'escaped-dash') return 'escaped-dash-dash';
  if (state === 'double-escaped') return 'double-escaped-dash';
  if (state === 'double-escaped-dash') return 'double-escaped-dash-dash';
  return state; // 'data', 'escaped-dash-dash', 'double-escaped-dash-dash': stay.
}

/** `>` transition: both "...dash dash" states fall all the way back to 'data' (spec table); a
 * lone dash state just loses its dash count. */
function gtTransition(state: ScriptState): ScriptState {
  if (state === 'escaped-dash-dash' || state === 'double-escaped-dash-dash') return 'data';
  if (state === 'escaped-dash') return 'escaped';
  if (state === 'double-escaped-dash') return 'double-escaped';
  return state; // 'data', 'escaped', 'double-escaped': stay (no special '>' row for these).
}

/** Any other character: a dash state loses its dash count; anything else stays put. */
function otherTransition(state: ScriptState): ScriptState {
  if (state === 'escaped-dash' || state === 'escaped-dash-dash') return 'escaped';
  if (state === 'double-escaped-dash' || state === 'double-escaped-dash-dash')
    return 'double-escaped';
  return state;
}

/** "double escape start": from an escaped-family state, `<` + an ASCII alpha run that spells
 * exactly "script" then a delimiter enters 'double-escaped'. Returns the index just past the
 * matched run, or null when the run doesn't spell "script". */
function tryDoubleEscapeStart(source: string, j: number): number | null {
  const start = j + 1;
  let end = start;
  while (end < source.length && isAsciiAlpha(source.charAt(end))) end++;
  const word = source.slice(start, end).toLowerCase();
  return word === 'script' && isDelimiter(source.charAt(end)) ? end : null;
}

/** "</" shape: end tag open (may close) or, from a double-escaped state, double-escape-end (walks
 * back to 'escaped', never closes — the load-bearing rule of §3.2). */
function handleEndTagOpen(
  source: string,
  j: number,
  opts: CloseTagOptions,
  state: ScriptState,
): ScriptStep {
  const nameStart = j + 2;
  if (!matchesEndTagName(source, nameStart, 'script', opts)) {
    return { state, j: j + 1 }; // Not appropriate: ordinary content, reconsume one character.
  }
  if (isDoubleEscapedFamily(state)) {
    return { state: 'escaped', j: nameStart + 'script'.length };
  }
  const tagEnd = findTagEnd(source, nameStart, opts);
  if (tagEnd !== -1) return { close: { bodyEnd: j, tagEnd }, state, j };
  return { state, j: source.length }; // No '>' anywhere before EOF: runs to EOF (invariant §3.4).
}

function handleLessThan(
  source: string,
  j: number,
  opts: CloseTagOptions,
  state: ScriptState,
): ScriptStep {
  const next = source.charAt(j + 1);
  if (next === '/') return handleEndTagOpen(source, j, opts, state);
  if (isEscapedFamily(state) && isAsciiAlpha(next)) {
    const matchedEnd = tryDoubleEscapeStart(source, j);
    return matchedEnd === null ? { state, j: j + 1 } : { state: 'double-escaped', j: matchedEnd };
  }
  // "escape start": only from 'data', and only the literal `<!--` opener enters the ladder (spec:
  // escape start -> on '-' -> escape start dash -> on '-' -> escaped-dash-dash).
  if (state === 'data' && next === '!' && source.startsWith('<!--', j)) {
    return { state: 'escaped-dash-dash', j: j + 4 };
  }
  return { state, j: j + 1 }; // Anything else: reconsume as an ordinary character.
}

/** States the last `referenceRawTextSpanScript` walk visited. Instrumentation for the coverage
 * floor below — the oracle is the only thing here that actually knows which ladder states an input
 * reaches, so it is what gets asked. Reset per call; read immediately after. */
let lastStatesSeen = new Set<ScriptState>();

function referenceRawTextSpanScript(source: string, i: number, opts: CloseTagOptions): CloseResult {
  let state: ScriptState = 'data';
  let j = i;
  lastStatesSeen = new Set<ScriptState>([state]);

  while (j < source.length) {
    lastStatesSeen.add(state);
    const char = source.charAt(j);

    if (char === '<') {
      const step = handleLessThan(source, j, opts, state);
      if (step.close) return step.close;
      state = step.state;
      j = step.j;
      continue;
    }

    if (char === '-') {
      state = dashTransition(state);
    } else if (char === '>') {
      state = gtTransition(state);
    } else {
      state = otherTransition(state);
    }
    j++;
  }

  return { bodyEnd: source.length, tagEnd: source.length };
}

/** §3.1/§3.2/§3.3 dispatcher: the oracle for `rawTextSpan`, parametrized by `CloseTagOptions` so
 * the same machine can also stand in for the two documented divergences (see §3 below). */
function referenceRawTextSpan(
  source: string,
  i: number,
  tagName: 'script' | 'style',
  opts: CloseTagOptions = SPEC_CONFORMANT,
): CloseResult {
  return tagName === 'style'
    ? referenceRawTextSpanStyle(source, i, opts)
    : referenceRawTextSpanScript(source, i, opts);
}

/** Oracle for `blankRawText`'s contract: walk the document; at a `<script` opening tag (always) or
 * a `<style` opening tag (only when `blankStyleBodies`), keep the opening tag verbatim, emit ONE
 * space for the body, keep the closing tag verbatim, continue after it. Everything else is copied
 * character by character. Quote-aware for the opening tag's own `>`, mirroring `openingTagEnd`
 * (opening-tag quote-awareness is not part of either documented divergence, so it is not
 * parametrized). */
/** Boundary for "is this the start of a <script>/<style> ELEMENT" is a tag-NAME-char boundary
 * (not a tag-name-char, e.g. not alpha/digit/hyphen) — not the narrower §3.3 whitespace/`/`/`>`
 * set used for END-tag appropriateness. Verified black-box: `<script<foo>` opens (boundary at `<`,
 * a non-name-char), `<scriptX>` does not (X continues the name). This is a property of the shared
 * top-level tag-name scan, not of `rawTextSpan`'s close-tag logic — out of this harness's §3 scope
 * per spec §7 ("divergences the harness surfaces outside rawTextSpan's contract"), so the oracle
 * matches it rather than fighting it. */
function detectRawTextTagName(
  source: string,
  i: number,
  blankStyleBodies: boolean,
): 'script' | 'style' | null {
  const rest = source.slice(i + 1);
  if (/^script(?![A-Za-z0-9-])/i.test(rest)) return 'script';
  if (blankStyleBodies && /^style(?![A-Za-z0-9-])/i.test(rest)) return 'style';
  return null;
}

/** Blanks one `<script>`/`<style>` element starting at `i`: opening tag verbatim, body replaced by
 * one space, closing tag verbatim. Even when the OPENING tag itself never finds its `>` (an
 * unterminated quoted attribute consumes to EOF, per `findQuoteAwareTagEnd`/`openingTagEnd`'s own
 * contract), the body step still unconditionally runs: `openingTagEnd` defaults to EOF,
 * `rawTextSpan` then sees an empty already-exhausted range and reports an empty unclosed span, and
 * the single blanking space is still appended — verified black-box: an opening tag with an
 * unmatched quote still ends the output with a trailing blank, not with the raw opening-tag text
 * alone. */
function blankOneRawTextElement(
  source: string,
  i: number,
  tagName: 'script' | 'style',
  opts: CloseTagOptions,
): { text: string; next: number } {
  const openEnd = findQuoteAwareTagEnd(source, i + 1);
  const openingTagEnd = openEnd === -1 ? source.length : openEnd;
  const { bodyEnd, tagEnd } = referenceRawTextSpan(source, openingTagEnd, tagName, opts);
  const text = `${source.slice(i, openingTagEnd)} ${source.slice(bodyEnd, tagEnd)}`;
  return { text, next: tagEnd };
}

/** Oracle for `blankRawText`'s contract: walk the document; at a `<script` opening tag (always) or
 * a `<style` opening tag (only when `blankStyleBodies`), keep the opening tag verbatim, emit ONE
 * space for the body, keep the closing tag verbatim, continue after it. Everything else is copied
 * character by character. Quote-aware for the opening tag's own `>`, mirroring `openingTagEnd`
 * (opening-tag quote-awareness is not part of either documented divergence, so it is not
 * parametrized). */
function referenceBlankRawText(
  source: string,
  blankStyleBodies: boolean,
  opts: CloseTagOptions = SPEC_CONFORMANT,
): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const char = source.charAt(i);
    const tagName = char === '<' ? detectRawTextTagName(source, i, blankStyleBodies) : null;
    if (tagName) {
      const { text, next } = blankOneRawTextElement(source, i, tagName, opts);
      out += text;
      i = next;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/** Full-pipeline oracle mirroring `stripHtmlComments` itself: raw-text blanking (above), then a
 * comment-stripping pass over the RESULT — quote-aware inside tags, unterminated `<!--` truncates
 * to end-of-string. This second stage is explicitly OUT OF SCOPE for this harness (spec §7: "any
 * change to `stripComments`... untouched") and is modelled here only because it is unavoidably
 * OBSERVABLE: a raw-text-blanking divergence can turn body content that was never meant to reach
 * this stage into document-level text, so a document-level `<!--` can appear from the DIVERGENT
 * path even when the generator's own constraint (no document-level comment in the SOURCE) holds —
 * comparing post-blanking-only output would then misattribute a stage-2 artifact of the known
 * divergence as a brand-new defect. Modelled from `stripHtmlComments`'s own (public, exported)
 * body — reading that export is within the harness's bounds; only `rawTextSpan`/`stepAtLessThan`/
 * `isScriptOpenAt`/`isEscapeEndAt`/`blankRawText` were off-limits. */
type CommentStripStep = { chunk: string; next: number; inTag: boolean; unterminated?: true };

/** One step of the comment-stripping stage: a quoted attribute value (inside a tag) is copied
 * through whole, an unquoted `<!--` either skips to its `-->` or truncates the whole rest of the
 * document as unterminated, and any other character just tracks `inTag` and is copied through. */
function stripCommentsStep(source: string, i: number, inTag: boolean): CommentStripStep {
  const char = source.charAt(i);
  if (inTag && (char === '"' || char === "'")) {
    const end = skipQuotedValue(source, i);
    return { chunk: source.slice(i, end), next: end, inTag };
  }
  if (!inTag && source.startsWith('<!--', i)) {
    const closeIndex = source.indexOf('-->', i + 2);
    if (closeIndex === -1) return { chunk: '', next: source.length, inTag, unterminated: true };
    return { chunk: '', next: closeIndex + 3, inTag };
  }
  const nextInTag = char === '<' ? true : char === '>' ? false : inTag;
  return { chunk: char, next: i + 1, inTag: nextInTag };
}

function referenceStripHtmlComments(
  html: string,
  blankStyleBodies: boolean,
  opts: CloseTagOptions,
): { text: string; unterminated: boolean } {
  const source = referenceBlankRawText(html, blankStyleBodies, opts);
  let result = '';
  let i = 0;
  let inTag = false;
  while (i < source.length) {
    const step = stripCommentsStep(source, i, inTag);
    if (step.unterminated) return { text: result, unterminated: true };
    result += step.chunk;
    i = step.next;
    inTag = step.inTag;
  }
  return { text: result, unterminated: false };
}

// ---------------------------------------------------------------------------------------------
// 2. Seeded PRNG + generator.
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260903;
const CASE_COUNT = 2200;

// Document-level comment markers are deliberately absent: see the GENERATOR CONSTRAINT note above
// the oracle. `<!--` / `-->` appear only inside `SCRIPT_ONLY_TOKENS`, used exclusively while
// composing a script body.
const COMMON_TOKENS = [
  '<script>',
  '<style>',
  '</script',
  '</style',
  '>',
  '/',
  '"',
  "'",
  ' ',
  '\n',
  'a',
  'ab',
  'abc',
  'Script',
  'STYLE',
  '<link rel=preload as=font href=/decoy.woff2>',
];

/** `<!--` and `<script` as separate tokens enter double-escaped only when the generator happens
 * to draw them in that order, which measured at 3.1% of script bodies — too thin for the one state
 * this whole module exists to get right, and it is why the `-->`-from-double-escaped gap needed a
 * hand-written case instead of being fuzzed out. These compounds enter the ladder in a single
 * draw. The coverage floor below is what keeps this honest if the alphabet is ever edited. */
const SCRIPT_ONLY_TOKENS = [
  '<!--',
  '-->',
  '<script',
  'script',
  '<!--<script>',
  '<!--<script ',
  '<!--<script></script>',
  '<!--<script>-->',
];

function pick<T>(rand: () => number, arr: readonly T[]): T {
  const idx = Math.floor(rand() * arr.length);
  return arr[Math.min(idx, arr.length - 1)] as T;
}

/** Generates one candidate document: a `<script>...</script>` (or unclosed) wrapper whose BODY may
 * draw from the full alphabet including `<!--`/`-->`, plus arbitrary decoy/document text around
 * it drawn only from `COMMON_TOKENS` (no comment markers at document level, preserving the
 * constraint above). */
function generateCase(rand: () => number): string {
  const useStyle = rand() < 0.15;
  const preludeCount = Math.floor(rand() * 3);
  let prelude = '';
  for (let k = 0; k < preludeCount; k++) prelude += pick(rand, COMMON_TOKENS);

  const bodyTokenCount = 1 + Math.floor(rand() * 8);
  let body = '';
  const alphabet = useStyle ? COMMON_TOKENS : [...COMMON_TOKENS, ...SCRIPT_ONLY_TOKENS];
  for (let k = 0; k < bodyTokenCount; k++) {
    // The abrupt escape-end forms `<!-->` / `<!--->` are DELIBERATELY reachable here. An earlier
    // revision of this generator steered around them because they were neither of the two
    // documented divergences; that made the harness unable to fail for a real defect it was
    // sitting on (the ladder stayed escaped, a later `<script` promoted to double-escaped, and the
    // rest of the document was swallowed to EOF). The implementation was fixed instead. Do not
    // reintroduce a guard here: a shape the generator cannot produce is a shape this harness
    // cannot protect.
    body += pick(rand, alphabet);
  }

  const closed = rand() < 0.85;
  const openTag = useStyle ? '<style>' : '<script>';
  const closeTag = useStyle ? '</style>' : '</script>';

  const trailCount = Math.floor(rand() * 3);
  let trail = '';
  for (let k = 0; k < trailCount; k++) trail += pick(rand, COMMON_TOKENS);

  return prelude + openTag + body + (closed ? closeTag : '') + trail;
}

// ---------------------------------------------------------------------------------------------
// 3. Intentional divergences (spec §5, `rawTextSpan`'s own doc comment).
// ---------------------------------------------------------------------------------------------

interface Divergence {
  name: string;
  input: string;
  why: string;
}

const INTENTIONAL_DIVERGENCES: Divergence[] = [
  {
    name: 'close-tag-gt-found-with-indexOf',
    input: '<script></script foo="a><script>real</script>b">AFTER',
    why:
      "the `>` ending a close tag is found with indexOf, so the quoted attribute's own literal " +
      '`>` (inside `foo="a>...`) ends the close tag early; the leftover `<script>real</script>` ' +
      'is then re-scanned as a brand-new script element and its body gets blanked too ' +
      '(pre-dates the 2026-09-03 fix; pinned in rawTextSpan doc comment divergence #1)',
  },
  {
    name: 'close-tag-not-delimiter-bound',
    input: '<script>x</script"more>y</script>AFTER',
    why:
      'a close tag is not required to be followed by whitespace/`/`/`>`, so the first ' +
      '`</script"` (not spec-appropriate — `"` is not a delimiter) is still treated as closing, ' +
      'ending the body early and leaving `more>y</script>AFTER` to be re-parsed as ordinary text ' +
      '(pre-dates the 2026-09-03 fix; pinned in rawTextSpan doc comment divergence #2)',
  },
];

const DOCUMENTED_BUGGY: CloseTagOptions = { quoteAwareClose: false, requireDelimiter: false };

/** Recognizes a generated input as hitting one of the two documented, intentional divergences by
 * EQUIVALENCE rather than by guessing at a textual shape: if replaying the FULL pipeline (blanking
 * + comment strip) with the exact two documented bugs (plain `indexOf` for the closer, no
 * delimiter requirement after the matched name) reproduces the same output the real implementation
 * gave, this input is exercising one — or both, indistinguishably — of the two enumerated
 * divergences, not a new defect. */
function isKnownDivergenceShape(input: string, actual: string): boolean {
  return referenceStripHtmlComments(input, true, DOCUMENTED_BUGGY).text === actual;
}

// ---------------------------------------------------------------------------------------------
// 4. The differential assertion.
// ---------------------------------------------------------------------------------------------

describe('raw-text tokenizer differential harness', () => {
  it('pinned intentional divergences actually diverge (sanity check on the exemption list)', () => {
    for (const d of INTENTIONAL_DIVERGENCES) {
      const actual = stripHtmlComments(d.input, { blankStyleBodies: true }).text;
      const expected = referenceStripHtmlComments(d.input, true, SPEC_CONFORMANT).text;
      expect(
        actual,
        `expected divergence "${d.name}" to actually diverge for input ${JSON.stringify(
          d.input,
        )} (${d.why})`,
      ).not.toBe(expected);
    }
  });

  it('matches the spec oracle on 2000+ seeded generated cases (or is a known divergence)', () => {
    const rand = mulberry32(SEED);
    for (let n = 0; n < CASE_COUNT; n++) {
      const input = generateCase(rand);
      const actual = stripHtmlComments(input, { blankStyleBodies: true }).text;
      const expected = referenceStripHtmlComments(input, true, SPEC_CONFORMANT).text;
      if (actual !== expected) {
        if (isKnownDivergenceShape(input, actual)) continue;
        expect(
          actual,
          `seed=${SEED} case#=${n} input=${JSON.stringify(input)}\n` +
            `actual=${JSON.stringify(actual)}\n` +
            `expected=${JSON.stringify(expected)}\n` +
            `Not a recognized entry in INTENTIONAL_DIVERGENCES — either the implementation has a ` +
            `new bug, the oracle is wrong, or this shape needs its own divergence entry.`,
        ).toBe(expected);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Named non-generated cases.
// ---------------------------------------------------------------------------------------------

describe('harness self-checks', () => {
  /** A differential harness is only worth its runtime if the generator REACHES the states the
   * implementation gets wrong. Two blind spots in this file were found by hand rather than by the
   * fuzzer (the `<!-->` abrupt-close shape, which an earlier generator actively steered around,
   * and `-->` returning from double-escaped), both because double-escaped was reached by only
   * ~3% of cases. This test fails if that coverage regresses: a shape the generator cannot produce
   * is a shape this harness cannot protect. Raise the floor, never lower it to make it pass. */
  it('the generator actually reaches the double-escaped ladder often enough to matter', () => {
    const rand = mulberry32(SEED);
    let scriptCases = 0;
    let reachedEscaped = 0;
    let reachedDoubleEscaped = 0;
    for (let n = 0; n < CASE_COUNT; n++) {
      const input = generateCase(rand);
      if (!input.includes('<script')) continue;
      scriptCases++;
      referenceRawTextSpan(input, input.indexOf('<script>') + '<script>'.length, 'script');
      const seen = [...lastStatesSeen];
      if (seen.some((st) => st.startsWith('escaped'))) reachedEscaped++;
      if (seen.some((st) => st.startsWith('double-escaped'))) reachedDoubleEscaped++;
    }
    const escapedPct = (reachedEscaped / scriptCases) * 100;
    const doublePct = (reachedDoubleEscaped / scriptCases) * 100;
    expect(
      doublePct,
      `double-escaped reach ${doublePct.toFixed(1)}% of ${scriptCases} script cases (escaped ${escapedPct.toFixed(1)}%)`,
    ).toBeGreaterThan(25);
    expect(escapedPct).toBeGreaterThan(40);
  });
});

describe('raw-text tokenizer named cases', () => {
  it('does not leak the decoy preload out of a double-escaped script body (spec §1)', () => {
    const input =
      '<script><!--<script></script>--><link rel=preload as=font href=/decoy.woff2></script>AFTER';
    const { text } = stripHtmlComments(input, { blankStyleBodies: true });
    expect(text).not.toContain('decoy.woff2');
    expect(text).toBe(referenceStripHtmlComments(input, true, SPEC_CONFORMANT).text);
  });

  it('closes at the first </script> once --> returns to script data, so the trailing link is live', () => {
    const input = '<script><!--<script>--></script><link rel=preload href=/x.woff2></script>AFTER';
    const { text } = stripHtmlComments(input, { blankStyleBodies: true });
    expect(text).toContain('/x.woff2');
    expect(text).toBe(referenceStripHtmlComments(input, true, SPEC_CONFORMANT).text);
  });

  it('--> from DOUBLE-escaped returns to script data, not merely to escaped', () => {
    // Regression pin for a harness BLIND SPOT found 2026-09-03, not for a shipped bug. Mutating
    // `level = 0` to `level = level === 2 ? 1 : 0` in the `isEscapeEndAt` branch left every test
    // in this file green, because the seeded generator never produced `<!--<script>-->` followed
    // by another `<script>`. The two differ observably: landing in escaped instead of script data
    // lets the following `<script` promote to double-escaped, after which `</script>` no longer
    // closes and the rest of the document is swallowed to EOF. Per WHATWG, script-data-double-
    // escaped-dash-dash on `>` goes to SCRIPT DATA, not to escaped.
    const input = '<script><!--<script>--><script></script>AFTER';
    const { text } = stripHtmlComments(input, { blankStyleBodies: true });
    expect(text).toBe('<script> </script>AFTER');
    expect(text).toBe(referenceStripHtmlComments(input, true, SPEC_CONFORMANT).text);
  });

  it('a bare < before <script (the JS left-shift shape) still promotes to double-escaped', () => {
    // Regression pin for a harness blind spot found 2026-09-03 by an independent mutation hunt.
    // `stepAtLessThan`'s fallback arm MUST advance exactly one character: on `<<script`, the first
    // `<` is ordinary content and the second is what triggers the double-escape promotion. An
    // advance of 2 skips the second `<` entirely, the promotion never fires, and the following
    // `</script>` closes an element that is really double-escaped — leaking everything after it as
    // live markup (false EXEMPTION, the same direction as the spec §1 bug). `<<` is unreachable by
    // token concatenation in the generator — every token containing `<` has more characters after
    // it — so no coverage percentage can produce this shape; it needs a named case.
    // Realistic in the wild: `<<` is the JS left-shift operator inside a script body.
    const input =
      '<script><!--a<<script></script><link rel=preload as=font href=/decoy.woff2></script>AFTER';
    const { text } = stripHtmlComments(input, { blankStyleBodies: true });
    expect(text).not.toContain('decoy.woff2');
    expect(text).toBe(referenceStripHtmlComments(input, true, SPEC_CONFORMANT).text);
  });

  it('Annex B: <!-- hidden line-comment idiom does not end the script body', () => {
    const input = '<script><!-- hidden\n</script>AFTER';
    const { text } = stripHtmlComments(input, { blankStyleBodies: true });
    expect(text).toBe(referenceStripHtmlComments(input, true, SPEC_CONFORMANT).text);
    expect(text.endsWith('AFTER')).toBe(true);
  });

  it('Annex B: a decrement-compare i-->0 does not end the script body early', () => {
    const input = '<script>for(i=10;i-->0;){}</script>AFTER';
    const { text } = stripHtmlComments(input, { blankStyleBodies: true });
    expect(text).toBe(referenceStripHtmlComments(input, true, SPEC_CONFORMANT).text);
    expect(text.endsWith('AFTER')).toBe(true);
  });

  it('<style> is unaffected by the script escape ladder', () => {
    const input = '<style><!--<script></style>AFTER';
    const { text } = stripHtmlComments(input, { blankStyleBodies: true });
    expect(text).toBe(referenceStripHtmlComments(input, true, SPEC_CONFORMANT).text);
    expect(text).toContain('AFTER');
  });

  it('an unclosed <script> consumes to EOF', () => {
    const input = '<script>abc<!--<script>def';
    const { text } = stripHtmlComments(input, { blankStyleBodies: true });
    expect(text).toBe(referenceStripHtmlComments(input, true, SPEC_CONFORMANT).text);
    expect(text).toBe('<script> ');
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Linearity guard — explicit timeout (this repo has been bitten by flaky untimed perf tests).
// ---------------------------------------------------------------------------------------------

describe('raw-text tokenizer linearity', () => {
  it('stays linear on a long <!--<script> run', () => {
    const input = '<!--<script>'.repeat(20000);
    const start = performance.now();
    stripHtmlComments(input, { blankStyleBodies: true });
    expect(performance.now() - start).toBeLessThan(2000);
  }, 10000);

  it('stays linear on a long <!-- run', () => {
    const input = '<!--'.repeat(20000);
    const start = performance.now();
    stripHtmlComments(input, { blankStyleBodies: true });
    expect(performance.now() - start).toBeLessThan(2000);
  }, 10000);
});
