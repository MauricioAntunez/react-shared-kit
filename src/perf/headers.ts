/**
 * `verifyHeaders` — validates a static-host `_headers` file (Cloudflare Pages / Netlify format)
 * against BUILT output, never a hardcoded list, so it cannot go stale relative to what the bundler
 * actually emitted.
 *
 * Ported and generalised from boufin's `scripts/verify-headers.ts` (plan 069 T1, proven with three
 * RED mutation runs 2026-08-30). Every value that script hardcoded for one project — the assets
 * directory, the immutable-eligible prefixes, the content-hash shape, the HTML-like paths — is a
 * parameter here, with that script's boufin values kept as the documented default.
 *
 * Four checks, per design doc §3.1:
 *   1. `headersFile` exists and is readable.
 *   2. Every file under `assetsDir`, RECURSIVELY (Vite's `assets/[ext]/[name]-[hash][extname]`
 *      layout nests by extension), carries a content hash (matches `hashPattern`).
 *   3. No rule in `headersFile` grants `immutable` to a path outside `immutablePrefixes`, matched
 *      at a path BOUNDARY (`/assets` must not also authorise `/assets2` or `/assets-legacy`).
 *   4. No rule matches one of `htmlPatterns` — HTML must stay revalidated or deploys never surface.
 *
 * Check 3 is safety-critical (design §3.1): `immutable` on an unhashed path is cache poisoning —
 * the file changes, the URL does not, and clients hold a stale copy for up to a year. FAIL CLOSED:
 * an unrecognised or unparseable rule is a problem, never a pass. A prefix test without a boundary
 * check is the same bug class OWASP flags for Origin-header validation (`example.org.attacker.com`
 * passing a naive `startsWith` test) — fixed here by requiring the matched prefix be followed by
 * either nothing or a `/`, never by another path-segment character.
 *
 * Anti-vacuity, per plan §2 constraint 4 ("fail closed... never a silent pass"): a readable
 * `assetsDir` with 0 files, or a `headersFile` that parses to 0 rules, means nothing was actually
 * examined. Both report `empty-input` rather than the vacuous `ok: true` an empty build would
 * otherwise produce. An UNREADABLE `assetsDir` or `headersFile` (missing, a directory where a file
 * was expected, a permissions error, a TOCTOU race between `existsSync` and the read) is a
 * DIFFERENT fact from "empty" and gets its own kind, so a consumer aggregating by kind is not told
 * "1 unhashed asset" when the truth is "the assets directory could not be read at all".
 *
 * Deliberately does NOT: read `sharp` or any native binary (ruling 6.3), touch the DOM, or author a
 * `_headers` file — it only measures one a consumer already built. Reuses `../image/check/walk.ts`'s
 * `walkFiles` for the recursive directory scan rather than writing a second walker (project CLAUDE.md's
 * "3+ occurrences: MUST refactor" rule, applied in reverse — don't create occurrence #1 of a new one).
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { walkFiles } from '../image/check/walk.ts';
import { assertStringOption } from './errors.ts';

export type HeadersProblemKind =
  | 'missing-headers-file'
  | 'unreadable-headers-file'
  | 'unreadable-assets-dir'
  | 'empty-input'
  | 'unhashed-asset'
  | 'invalid-immutable-prefix'
  | 'unauthorized-immutable'
  | 'html-rule';

export interface HeadersProblem {
  kind: HeadersProblemKind;
  /**
   * What `path` means varies by `kind` — it is never a single consistent shape (round 3 review
   * finding, mirroring `FontChainProblem.subject`'s per-kind doc):
   *   - `missing-headers-file`, `unreadable-headers-file` — `headersFile`, the built file itself.
   *   - `unreadable-assets-dir` — `assetsDir`, a DIRECTORY, not a file.
   *   - `empty-input` — either `assetsDir` (the readable-but-empty-directory case) or
   *     `headersFile` (the parses-to-0-rules case); which one fired determines which this is.
   *   - `unhashed-asset` — `${assetsDir}/${relPath}`, one FILE under `assetsDir`.
   *   - `invalid-immutable-prefix` — the raw, as-passed `immutablePrefixes` OPTION STRING that
   *     was rejected, not a filesystem path at all.
   *   - `unauthorized-immutable`, `html-rule` — `rule.path`, a RULE PATH parsed out of
   *     `headersFile` (e.g. `/assets/*`), not a path on disk.
   */
  path: string;
  detail: string;
}

export interface VerifyHeadersOptions {
  /** Path to the built `_headers` file. */
  headersFile: string;
  /** Directory whose files must ALL be content-hashed (e.g. a built `assets/` dir). */
  assetsDir: string;
  /** Rule path prefixes permitted to grant `Cache-Control: immutable`. */
  immutablePrefixes: readonly string[];
  /**
   * Filename shape a content-hashed asset must match. Default is Vite's convention: an 8-char
   * base64url hash, hyphen-joined, immediately before the extension.
   */
  hashPattern?: RegExp;
  /** Rule paths that must never appear in `headersFile` — HTML must stay revalidated. */
  htmlPatterns?: readonly string[];
}

export interface VerifyHeadersResult {
  ok: boolean;
  problems: HeadersProblem[];
}

/** Vite's default content-hash naming: `<name>-<8 base64url chars>.<ext>`. */
const DEFAULT_HASH_PATTERN = /^.+-[A-Za-z0-9_-]{8}\.[^./]+$/;

/** Paths that must never get their own rule — HTML must stay revalidated (`max-age=0,
 * must-revalidate`) or a deploy has no way to surface. */
const DEFAULT_HTML_PATTERNS: readonly string[] = ['/', '/*.html', '/*', '/index.html'];

interface HeaderRule {
  path: string;
  lines: string[];
}

/**
 * Parses a Cloudflare-Pages-style `_headers` file into path -> rule-line blocks. Minimal on
 * purpose: this is not a general `_headers` parser, only enough to extract a rule's path and the
 * indented lines under it (the format both Cloudflare Pages and Netlify share).
 */
function parseHeaderRules(contents: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | undefined;
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      current = { path: line.trim(), lines: [] };
      rules.push(current);
    } else if (current) {
      current.lines.push(line.trim());
    }
  }
  return rules;
}

function checkAssetsHashed(
  assetsDir: string,
  hashPattern: RegExp,
  problems: HeadersProblem[],
): void {
  let walkedFiles: string[];
  try {
    // Recursive: Vite's documented `assetFileNames: 'assets/[ext]/[name]-[hash][extname]'` layout
    // nests by extension. A non-recursive `readdirSync` would test the SUBDIRECTORY NAME (e.g.
    // "fonts") against `hashPattern` instead of the files inside it — reporting a nonsense problem
    // while the real unhashed file underneath goes unexamined. `onReaddirError: 'throw'` (the
    // default) is what we want here: propagate so the outer catch reports `unreadable-assets-dir`.
    //
    // UNCONDITIONAL catch, NARROWED to exactly this call (round 4 then round 5 review redesign):
    // assetsDir is validated to be a real string on entry to verifyHeaders (assertStringOption),
    // so whatever walkFiles/readdirSync raises about it is a fact about the build, not a caller
    // bug. Round 3 tried to keep classifying the error here (isFsError) after already having been
    // too broad (round 2) and too broad again in a different way (round 3's own ERR_ prefix
    // exclusion, then a narrow allowlist that was simultaneously too inclusive AND too exclusive)
    // — see ./errors.ts for why validating the input at the boundary instead makes this catch
    // simple and correct. The `.map(relative)` below runs OUTSIDE this try, deliberately: it is a
    // pure path computation over strings already known valid, not an fs fact, and lumping it in
    // would be the exact try-too-wide shape round 5 found in cssBudget.ts/fontChain.ts.
    walkedFiles = walkFiles(assetsDir);
  } catch (error) {
    problems.push({
      kind: 'unreadable-assets-dir',
      path: assetsDir,
      detail: `could not read "${assetsDir}": ${String(error)}`,
    });
    return;
  }
  const assetFiles = walkedFiles.map((abs) => relative(assetsDir, abs));

  if (assetFiles.length === 0) {
    // Fail closed (plan §2 constraint 4): a readable-but-empty assetsDir means the build produced
    // nothing to verify. Reporting `ok: true` here would read as "every asset is hashed" when in
    // fact zero assets were ever checked — the exact silent-pass-on-vacuous-input shape this gate
    // exists to rule out.
    problems.push({
      kind: 'empty-input',
      path: assetsDir,
      detail:
        `"${assetsDir}" contains 0 files — there is nothing to verify was hashed, and that is ` +
        'being reported rather than treated as a pass. Did the build actually run?',
    });
    return;
  }

  // Matched against the FILENAME only (not the nested relative path) — the hash pattern describes
  // one path segment (`<name>-<hash>.<ext>`), and a directory component like `fonts/` must never
  // participate in the hash test.
  const unhashed = assetFiles.filter(
    (relPath) => !hashPattern.test(relPath.split('/').pop() ?? relPath),
  );
  for (const relPath of unhashed) {
    problems.push({
      kind: 'unhashed-asset',
      path: `${assetsDir}/${relPath}`,
      detail:
        `"${relPath}" under "${assetsDir}" does not carry a content hash — an immutable rule ` +
        'covering this path would cache it forever with no way to bust the cache.',
    });
  }
}

/**
 * Boundary-aware prefix match: `path` is authorised by `prefix` only if it EQUALS `prefix` or
 * continues immediately with `/`. A bare `startsWith` lets `/assets` authorise `/assets2/evil.js`
 * or `/assets-legacy/*` — the same bug class OWASP flags for Origin-header checks
 * (`example.org.attacker.com` passing a naive prefix test). No trailing slash is required on
 * `prefix` itself: `/assets` and `/assets/` behave identically here, so the option's type does not
 * need to forbid the unsafe-looking shape to also be safe.
 */
function isUnderPrefix(path: string, prefix: string): boolean {
  const boundary = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === boundary || path.startsWith(`${boundary}/`);
}

/**
 * `''` and `'/'` are not scoping prefixes at all — every boundary in `isUnderPrefix` collapses to
 * the empty string, so `startsWith('')` is trivially true for any absolute rule path and every
 * `immutable` rule (including one on an unhashed path) would pass. This is the exact
 * cache-poisoning shape check 3 exists to stop, so an entry this broad is refused outright rather
 * than silently authorising everything OR silently being dropped without telling the caller — both
 * of those would still leave a config that looks accepted but is not doing what was intended.
 */
function isTooBroadPrefix(prefix: string): boolean {
  return prefix === '' || prefix === '/';
}

function checkRule(
  rule: HeaderRule,
  immutablePrefixes: readonly string[],
  htmlPatterns: readonly string[],
  problems: HeadersProblem[],
): void {
  const grantsImmutable = rule.lines.some((line) => /immutable/i.test(line));
  if (grantsImmutable && !immutablePrefixes.some((prefix) => isUnderPrefix(rule.path, prefix))) {
    problems.push({
      kind: 'unauthorized-immutable',
      path: rule.path,
      detail:
        `rule "${rule.path}" grants immutable but only paths starting with one of ` +
        `[${immutablePrefixes.join(', ')}] may — unhashed paths must stay revalidated.`,
    });
  }
  if (htmlPatterns.includes(rule.path)) {
    problems.push({
      kind: 'html-rule',
      path: rule.path,
      detail:
        `rule "${rule.path}" matches HTML — HTML must stay revalidated ` +
        '(max-age=0, must-revalidate) or deploys will not surface.',
    });
  }
}

export function verifyHeaders(options: VerifyHeadersOptions): VerifyHeadersResult {
  const {
    headersFile,
    assetsDir,
    immutablePrefixes,
    hashPattern = DEFAULT_HASH_PATTERN,
    htmlPatterns = DEFAULT_HTML_PATTERNS,
  } = options;
  const problems: HeadersProblem[] = [];

  // Boundary validation (round 4 review redesign), same principle as a resolver's return in the
  // sibling gates: headersFile/assetsDir are declared as strings. A caller violating that at
  // runtime must crash loudly here, naming the option, rather than flow into existsSync/
  // readFileSync/walkFiles and surface as a misclassified filesystem finding downstream.
  assertStringOption(headersFile, 'headersFile');
  assertStringOption(assetsDir, 'assetsDir');

  if (!existsSync(headersFile)) {
    problems.push({
      kind: 'missing-headers-file',
      path: headersFile,
      detail: `expected "${headersFile}" to exist, but it does not.`,
    });
    // Fail closed but do not attempt the remaining checks against a file that is not there — there
    // is nothing meaningful left to parse.
    return { ok: false, problems };
  }

  checkAssetsHashed(assetsDir, hashPattern, problems);

  // `existsSync` above only proves something was there at that instant — it returns true for a
  // directory, and there is a TOCTOU window between the check and this read. Guarded independently
  // so an unreadable path is a reported problem, never an uncaught throw breaking this function's
  // pure `{ ok, problems }` contract.
  let contents: string;
  try {
    contents = readFileSync(headersFile, 'utf8');
  } catch (error) {
    problems.push({
      kind: 'unreadable-headers-file',
      path: headersFile,
      detail: `could not read "${headersFile}": ${String(error)}`,
    });
    return { ok: false, problems };
  }
  const rules = parseHeaderRules(contents);

  // Fail closed on the option itself (round-2 review, MUST-FIX 1): an empty or root prefix
  // authorises every path once it reaches `isUnderPrefix`, defeating check 3 entirely. Reported
  // once per offending entry, then EXCLUDED from the authorisation set below — never silently
  // used, never silently dropped without telling the caller.
  const validImmutablePrefixes = immutablePrefixes.filter((prefix) => !isTooBroadPrefix(prefix));
  for (const prefix of immutablePrefixes) {
    if (!isTooBroadPrefix(prefix)) continue;
    problems.push({
      kind: 'invalid-immutable-prefix',
      path: prefix,
      detail:
        `immutablePrefixes entry "${prefix}" is empty or root — it would authorise "immutable" ` +
        'on every path, including unhashed ones. Refusing to use it; pass a specific prefix ' +
        'such as "/assets" instead.',
    });
  }

  if (rules.length === 0) {
    // Fail closed (plan §2 constraint 4): the file exists but parses to 0 rules — nothing was
    // verified. A truncated write, a build step that emitted an empty file, or a format this
    // parser cannot read must never look identical to "reviewed and clean".
    problems.push({
      kind: 'empty-input',
      path: headersFile,
      detail:
        `"${headersFile}" exists but parses to 0 rules — there is nothing to verify, and that is ` +
        'being reported rather than treated as a pass. Did it parse correctly?',
    });
  }

  for (const rule of rules) {
    checkRule(rule, validImmutablePrefixes, htmlPatterns, problems);
  }

  return { ok: problems.length === 0, problems };
}
