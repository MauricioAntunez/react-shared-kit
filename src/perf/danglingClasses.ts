import { readFileSync } from 'node:fs';
import {
  assertStringOption,
  execHashPatternBounded,
  MAX_HASH_PATTERN_TOKEN_LENGTH,
  testHashPatternBounded,
} from './errors.ts';
import { stripComments, stripHtmlComments } from './text.ts';

/**
 * `findDanglingClasses` — detects a CSS-Modules selector that compiles cleanly and matches
 * NOTHING in any built page, on both faces this gate exists for (performance first, since that
 * is why the check lives under `./perf` rather than in a lint rule):
 *
 * PERFORMANCE: CSS Modules renames every class PER FILE, embedding a hash of the source file
 * (`page.module.css .hiwViz -> _hiwViz_18mh8_533`; the SAME logical name in `home.module.css`
 * hashes to `_hiwViz_1o51b_39` — a different file, a different hash). A rule that joins a class
 * from module A to a class from module B therefore targets a selector no element anywhere
 * carries. That rule still ships: it is parsed, held in the render tree, and evaluated against
 * every element on every route that loads the chunk, for zero effect. It is the same "remove
 * unused CSS" waste `verifyCssBudget` already measures — just arriving from a different cause.
 *
 * CORRECTNESS: because the rule never matches, whatever it was written to fix is silently live in
 * production. The motivating defect — a cross-module selector, syntactically valid, build exit 0,
 * 2391/2391 tests green, four other gates passing — cost one element 465px of width. It was caught
 * only by a browser probe against a pre-change baseline, well after ship.
 *
 * THE CHECK: a hashed class name (matching `hashPattern`) that appears in a stylesheet in
 * `cssFiles` but on no element's `class` attribute across any file in `htmlFiles` is dangling.
 * Only HASHED names are examined — an ordinary global class (`.container`) is out of scope; this
 * gate exists for the specific silent-failure shape a per-file content hash creates, not as a
 * general unused-CSS linter.
 *
 * THE FALSE-POSITIVE CLASS, AND WHY `allowlist` EXISTS: not every dangling name is a defect. Run
 * naively, this reports every RUNTIME-CONDITIONAL variant a component applies dynamically —
 * `loading && styles.loading`, `dark && styles.dark`, `styles[align]` (a COMPUTED key, invisible
 * to any static analysis). Those are absent from prerendered HTML because no current page passes
 * those props, not because the rule is broken. Against the motivating consumer, a naive version
 * of this check reported 51 such hits on day one — a check that noisy gets switched off and then
 * provides nothing, which is worse than not having it.
 *
 * `allowlist` entries are matched against the class's LOGICAL name — the hash-independent part
 * `hashPattern`'s capture group extracts (`hiwViz` out of `_hiwViz_18mh8_533`), never the hashed
 * name itself. A hash is unstable across rebuilds; a logical name is not — so
 * `allowlist: [/^(loading|dark|error|indeterminate)$/]` keeps working after the next build
 * reshuffles every hash in the file. If `hashPattern` has no capture group, matching falls back to
 * the full hashed name (documented on `hashPattern` below). `allowlist` patterns must not carry
 * the `g`/`y` flag — a stateful `RegExp.test` advances `lastIndex` across calls and would silently
 * skip alternating matches.
 *
 * DEFAULT BEHAVIOUR IS THE STRICT ONE, DELIBERATELY: with no `allowlist`, every dangling hashed
 * class is reported, runtime variants included. That is noisy on a real component library, but it
 * is the same choice `immutablePrefixes`/`htmlPatterns` make elsewhere in this module — an
 * unpopulated allowlist is never treated as "everything is fine," because that is indistinguishable
 * from a consumer who has not looked yet. The consumer opts INTO quiet by naming what it expects;
 * the gate never guesses.
 *
 * Inherits this module's boundary-validation and fail-closed rules verbatim (see `./index.ts` and
 * `./errors.ts`): `htmlFiles`/`cssFiles` elements are validated as strings at the boundary via
 * `assertStringOption`, an unreadable file is a reported problem rather than a thrown exception,
 * and each `try` wraps exactly the one `readFileSync` call it guards. An empty `htmlFiles` or
 * `cssFiles` is `empty-input`, never a vacuous pass — computing "dangling" against zero known
 * elements would flag every hashed class in every stylesheet, drowning the real signal (nothing
 * was examined) in noise that looks like the check ran when it did not.
 *
 * LIMIT, same as the rest of `./perf`: this is static analysis over bytes, not a browser. It
 * cannot see a class applied via `className={cx(...)}` string concatenation it cannot statically
 * resolve, nor can it tell a rule is unreachable for a reason OTHER than the class never
 * appearing (e.g. a parent selector that never matches). It catches the specific, silent,
 * cross-module-hash failure mode described above — pair it with a browser layout sweep for
 * anything beyond that, per this module's oracle-problem note.
 */

export type DanglingClassProblemKind =
  | 'empty-input'
  | 'unreadable-html'
  | 'unterminated-html-comment'
  | 'unreadable-css'
  | 'dangling-class'
  | 'oversized-class-name'
  | 'unmatched-allowlist-file';

export type DanglingClassProblem =
  | { kind: 'empty-input'; input: 'htmlFiles' | 'cssFiles'; detail: string }
  | { kind: 'unreadable-html'; html: string; detail: string }
  /** A genuinely unterminated `<!--` in `html` (round-2 review MUST-FIX #2, `fontChain.ts`'s
   * sibling finding applied here too): every byte from that point to end of file was stripped as
   * "inside the comment" and never scanned for `class="..."` attributes — a truncated build
   * artifact must not silently read as "no dangling classes found" here either. */
  | { kind: 'unterminated-html-comment'; html: string; detail: string }
  | { kind: 'unreadable-css'; css: string; detail: string }
  | { kind: 'dangling-class'; css: string; className: string; detail: string }
  | { kind: 'oversized-class-name'; css: string; className: string; detail: string }
  | { kind: 'unmatched-allowlist-file'; file: string; detail: string };

/**
 * An allowlist entry scoped to one specific `cssFiles` entry (matched by exact string equality —
 * the same string the caller passed in `cssFiles`). Use this when a logical name is a legitimate
 * runtime-conditional variant in ONE stylesheet but must keep failing everywhere else — a bare
 * `RegExp` entry cannot express that: it excuses the logical name globally, so allowlisting a
 * genuine `hiwViz` variant in `nav.module.css` would also silence a real cross-module `hiwViz`
 * bug in `page.module.css` (reproduced; see IMPORTANT 4 in the review-fixes plan).
 *
 * `file` must be spelled IDENTICALLY to its `cssFiles` entry — `findDanglingClasses` validates
 * this up front (`unmatchedAllowlistFileProblems`) and reports `unmatched-allowlist-file` loudly
 * when it isn't, rather than letting an absolute-vs-relative (or any other) spelling mismatch
 * make the entry silently inert (IMPORTANT review finding, 2026-08-30).
 */
export interface ScopedAllowlistEntry {
  /** Logical-name pattern, matched exactly as a bare `RegExp` entry would be. */
  pattern: RegExp;
  /** The one `cssFiles` entry this pattern is allowed to excuse, compared by exact string
   * equality against the path passed in `cssFiles`. */
  file: string;
}

/**
 * A bare `RegExp` keeps today's GLOBAL meaning (documented public shape — must keep working
 * unchanged): it excuses the logical name in every stylesheet. A `ScopedAllowlistEntry` narrows
 * the excuse to one `cssFiles` entry.
 */
export type AllowlistEntry = RegExp | ScopedAllowlistEntry;

export interface FindDanglingClassesOptions {
  /** Built HTML files to scan for `class="..."` tokens. */
  htmlFiles: string[];
  /** Built stylesheets to scan for hashed class selectors. */
  cssFiles: string[];
  /**
   * Patterns matched against a dangling class's LOGICAL name (see module doc comment) that are
   * expected to be legitimately absent from every built HTML file — a runtime-conditional variant
   * a component applies dynamically. Default `[]`: nothing is pre-excused (see "default behaviour
   * is the strict one" above). A bare `RegExp` excuses the name globally, across every file in
   * `cssFiles`; wrap it as a `ScopedAllowlistEntry` (`{ pattern, file }`) to restrict the excuse to
   * one specific stylesheet, so it cannot also excuse a same-named bug in a different file.
   */
  allowlist?: readonly AllowlistEntry[];
  /**
   * Filename shape a CSS-Modules-generated class name matches. Default is CSS Modules' own
   * convention: `_<logicalName>_<hash>_<line>`, e.g. `_hiwViz_18mh8_533`. Capture group 1, if
   * present, is the LOGICAL name used for `allowlist` matching; a pattern with no capture group
   * falls back to matching the full hashed name. Must not carry the `g`/`y` flag (matches
   * `verifyHeaders`'s `hashPattern` contract: used with `.test()`/`.exec()` against one string at
   * a time, never to scan for repeated matches in a larger text).
   */
  hashPattern?: RegExp;
}

export interface FindDanglingClassesResult {
  ok: boolean;
  problems: DanglingClassProblem[];
}

/** CSS Modules' own naming convention: `_<name>_<hash>_<line>`. Group 1 is the logical name. */
const DEFAULT_HASH_PATTERN = /^_([A-Za-z0-9]+)_[a-z0-9]+_\d+$/;

/** Class selector tokens in CSS source text: a `.` followed by a CSS identifier. Scanned across
 * the whole stylesheet rather than only inside selector blocks — deliberately simple, since
 * `hashPattern` (a distinctive, unusual shape) is what filters this down to real hits, the same
 * division of labour `checkAssetsHashed` in `headers.ts` uses for filenames. */
const CLASS_SELECTOR_TOKEN = /\.(-?[A-Za-z_][\w-]*)/g;

/** `class="..."` / `class='...'` tokens in built HTML, split on whitespace into individual class
 * names. Built output only — no JSX, no `className`, no template-literal `cx()` calls to resolve
 * (see the LIMIT note in the module doc comment). */
const HTML_CLASS_ATTR = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function extractHtmlClasses(html: string): Set<string> {
  const classes = new Set<string>();
  for (const match of html.matchAll(HTML_CLASS_ATTR)) {
    const value = match[1] ?? match[2] ?? '';
    for (const token of value.split(/\s+/)) {
      if (token !== '') classes.add(token);
    }
  }
  return classes;
}

/** Every hashed class name (per `hashPattern`) that appears as a selector token anywhere in `css`,
 * deduplicated.
 *
 * `hashPattern` is CONSUMER-SUPPLIED (HIGH 3 review finding, 2026-08-30): tested here via
 * `testHashPatternBounded` rather than a bare `hashPattern.test(...)`, so a selector token over
 * `MAX_HASH_PATTERN_TOKEN_LENGTH` is never handed to an arbitrary regex. An over-cap token is
 * reported as `oversized-class-name` and excluded from the returned set — NOT silently dropped
 * (that would make it vanish from this gate's attention with no record) and NOT treated as a
 * match (it was never actually verified against `hashPattern`). See ./errors.ts. */
function extractHashedClasses(
  css: string,
  hashPattern: RegExp,
  cssFile: string,
  problems: DanglingClassProblem[],
): string[] {
  const found = new Set<string>();
  for (const match of css.matchAll(CLASS_SELECTOR_TOKEN)) {
    const name = match[1];
    if (name === undefined) continue;
    const result = testHashPatternBounded(hashPattern, name);
    if (result === 'oversized') {
      problems.push({
        kind: 'oversized-class-name',
        css: cssFile,
        className: name,
        detail:
          `a selector token in "${cssFile}" is ${name.length} characters — over the ` +
          `${MAX_HASH_PATTERN_TOKEN_LENGTH}-character cap this gate enforces before testing a ` +
          'token against hashPattern (an arbitrary, consumer-supplied regex, which is never safe ' +
          'to run against an unbounded string). This selector was never actually checked for a ' +
          'dangling match.',
      });
      continue;
    }
    if (result === 'match') found.add(name);
  }
  return [...found];
}

/** The hash-independent part of a hashed class name, per `hashPattern`'s capture group — falls
 * back to the full name when the pattern has none. Bounded the same way as
 * `extractHashedClasses` (HIGH 3): its only current caller passes a class name already
 * cap-checked by `extractHashedClasses` (which never adds an oversized name to what it returns),
 * so the `'oversized'` branch is unreachable today — kept so this function cannot become a second,
 * unguarded path to the same regex if it is ever called with unchecked input later. Falling back
 * to the raw `className` on that branch mirrors the existing no-capture-group fallback: it only
 * ever degrades allowlist precision, it never hides a dangling class from being reported. */
function logicalName(className: string, hashPattern: RegExp): string {
  const result = execHashPatternBounded(hashPattern, className);
  if (result === 'oversized' || result === null) return className;
  return result[1] ?? className;
}

/** Validates every `ScopedAllowlistEntry.file` against `cssFiles` up front (IMPORTANT review
 * finding, 2026-08-30): `isAllowlisted` below matches `entry.file` against `cssFile` by exact
 * string equality — whatever spelling the caller happens to pass. Reproduced: `cssFiles:
 * [resolve(f)]` (absolute) against `allowlist: [{ pattern, file: 'nav.module.css' }]` (relative)
 * makes the entry match nothing, ever; the class it was meant to excuse keeps reporting as
 * dangling, with a message that tells the consumer to add it to `allowlist` — exactly what they
 * already did. A config entry that can silently no-op is the failure class this entire gate
 * exists to catch, so a spelling mismatch is reported here as its own LOUD, explicit problem
 * (`unmatched-allowlist-file`) rather than left to manifest indirectly as an unrelated
 * `dangling-class` finding that gives no hint the allowlist was ever involved. Chosen over
 * normalizing both sides with `path.resolve` (which would only narrow absolute-vs-relative, not
 * catch an outright typo in the filename) or comparing basenames (which would silently widen the
 * match to any same-named file in a different directory) — validating that the entry as-typed
 * matches SOMETHING in `cssFiles` catches the typo class this bug is, not just one shape of it. */
function unmatchedAllowlistFileProblems(
  allowlist: readonly AllowlistEntry[],
  cssFiles: readonly string[],
): DanglingClassProblem[] {
  const knownCssFiles = new Set(cssFiles);
  const problems: DanglingClassProblem[] = [];
  for (const entry of allowlist) {
    if (entry instanceof RegExp) continue;
    if (knownCssFiles.has(entry.file)) continue;
    problems.push({
      kind: 'unmatched-allowlist-file',
      file: entry.file,
      detail:
        `allowlist entry { pattern: ${String(entry.pattern)}, file: ${JSON.stringify(entry.file)} } ` +
        'does not match any element of cssFiles (compared by exact string equality) — this entry ' +
        'can never excuse a dangling class and will silently no-op. Likely an absolute/relative ' +
        `path spelling mismatch. cssFiles: ${JSON.stringify(cssFiles)}.`,
    });
  }
  return problems;
}

function isAllowlisted(
  className: string,
  hashPattern: RegExp,
  allowlist: readonly AllowlistEntry[],
  cssFile: string,
): boolean {
  const name = logicalName(className, hashPattern);
  return allowlist.some((entry) => {
    if (entry instanceof RegExp) return entry.test(name);
    return entry.file === cssFile && entry.pattern.test(name);
  });
}

/** Boundary validation (see ./errors.ts): a caller passing a non-string element in either array
 * is a contract violation and must crash loudly here, naming the index, rather than flow into
 * readFileSync and surface as a misclassified unreadable-html/unreadable-css finding. */
function assertFileLists(htmlFiles: string[], cssFiles: string[]): void {
  for (const [index, file] of htmlFiles.entries()) assertStringOption(file, `htmlFiles[${index}]`);
  for (const [index, file] of cssFiles.entries()) assertStringOption(file, `cssFiles[${index}]`);
}

/** Fail closed (plan §2 constraint 4): nothing to examine must never read as a clean pass. Both
 * lists are checked (not short-circuited) so a caller misconfiguring both sees both problems. */
function emptyInputProblems(htmlFiles: string[], cssFiles: string[]): DanglingClassProblem[] {
  const problems: DanglingClassProblem[] = [];
  if (htmlFiles.length === 0) {
    problems.push({
      kind: 'empty-input',
      input: 'htmlFiles',
      detail: 'htmlFiles is empty — nothing was examined; did the build run or the glob resolve?',
    });
  }
  if (cssFiles.length === 0) {
    problems.push({
      kind: 'empty-input',
      input: 'cssFiles',
      detail: 'cssFiles is empty — nothing was examined; did the build run or the glob resolve?',
    });
  }
  return problems;
}

/** Every class named on any element across `htmlFiles`. An unreadable file is reported and
 * skipped — never abandons classes already collected from files already read. */
function collectHtmlClasses(htmlFiles: string[], problems: DanglingClassProblem[]): Set<string> {
  const htmlClasses = new Set<string>();
  for (const htmlFile of htmlFiles) {
    let html: string;
    try {
      // UNCONDITIONAL catch, NARROWED to exactly this call (see ./errors.ts): htmlFile is already
      // validated to be a real string above, so whatever readFileSync raises about it is a fact
      // about the build, not a caller bug.
      html = readFileSync(htmlFile, 'utf8');
    } catch (error) {
      problems.push({
        kind: 'unreadable-html',
        html: htmlFile,
        detail: `could not read "${htmlFile}": ${String(error)}`,
      });
      continue;
    }
    // stripHtmlComments runs OUTSIDE the try above, deliberately (plan §3.2, CRITICAL 1 class
    // half): a commented-out `<div class="_hiwViz_18mh8_533">` is not live markup, and without
    // stripping it launders a genuinely dangling class to a clean pass.
    //
    // ROUND-2 REVIEW MUST-FIX #2: an unterminated `<!--` is reported, not silently swallowed. A
    // truncated document would otherwise have every class after the stray `<!--` vanish from
    // `htmlClasses` with no record — a class that genuinely IS used later in the file would then
    // report as `dangling-class`, or worse, a real defect the truncation happened to hide would
    // simply never surface. Collection continues on the visible (pre-truncation) portion either
    // way, same reasoning as `fontChain.ts`'s sibling fix.
    const strippedHtml = stripHtmlComments(html);
    if (strippedHtml.unterminated) {
      problems.push({
        kind: 'unterminated-html-comment',
        html: htmlFile,
        detail:
          `"${htmlFile}" contains an unterminated <!-- HTML comment — every byte from that ` +
          'point to the end of the file was treated as inside the comment and never scanned ' +
          'for class="..." attributes. A truncated build artifact must not read as a clean pass.',
      });
    }
    for (const className of extractHtmlClasses(strippedHtml.text)) htmlClasses.add(className);
  }
  return htmlClasses;
}

/** Reports every hashed class in `cssFile` that is neither present in `htmlClasses` nor
 * allowlisted. An unreadable file is reported and skipped, same as `collectHtmlClasses`. */
function checkCssFile(
  cssFile: string,
  htmlClasses: Set<string>,
  allowlist: readonly AllowlistEntry[],
  hashPattern: RegExp,
  problems: DanglingClassProblem[],
): void {
  let css: string;
  try {
    css = readFileSync(cssFile, 'utf8');
  } catch (error) {
    problems.push({
      kind: 'unreadable-css',
      css: cssFile,
      detail: `could not read "${cssFile}": ${String(error)}`,
    });
    return;
  }
  // stripComments runs OUTSIDE the try above, deliberately (see module doc comment / plan §3.2):
  // it is a pure transform over text already read successfully, so a failure in it is a bug in
  // this module, not a build defect to misreport as unreadable-css.
  const stripped = stripComments(css);
  for (const className of extractHashedClasses(stripped, hashPattern, cssFile, problems)) {
    if (htmlClasses.has(className)) continue;
    if (isAllowlisted(className, hashPattern, allowlist, cssFile)) continue;
    problems.push({
      kind: 'dangling-class',
      css: cssFile,
      className,
      detail:
        `"${className}" in "${cssFile}" matches no element in any built HTML file — a rule ` +
        'joining a class from one CSS-Modules-generated file to a name hashed by another ' +
        'compiles cleanly but matches nothing, since each file hashes its class names ' +
        'independently. If this is a runtime-conditional variant no current page happens to ' +
        'pass, add its logical name to `allowlist` rather than treating this as a false alarm.',
    });
  }
}

export function findDanglingClasses(
  options: FindDanglingClassesOptions,
): FindDanglingClassesResult {
  const { htmlFiles, cssFiles, allowlist = [], hashPattern = DEFAULT_HASH_PATTERN } = options;

  assertFileLists(htmlFiles, cssFiles);

  const emptyProblems = emptyInputProblems(htmlFiles, cssFiles);
  // Processing stops here on either empty list: computing "dangling" against zero known HTML
  // classes would flag every hashed class in every stylesheet, burying the real empty-input
  // signal in that noise.
  if (emptyProblems.length > 0) return { ok: false, problems: emptyProblems };

  const problems: DanglingClassProblem[] = unmatchedAllowlistFileProblems(allowlist, cssFiles);
  const htmlClasses = collectHtmlClasses(htmlFiles, problems);
  for (const cssFile of cssFiles) {
    checkCssFile(cssFile, htmlClasses, allowlist, hashPattern, problems);
  }

  return { ok: problems.length === 0, problems };
}
