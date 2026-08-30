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
 *   1. `headersFile` exists.
 *   2. Every file under `assetsDir` carries a content hash (matches `hashPattern`).
 *   3. No rule in `headersFile` grants `immutable` to a path outside `immutablePrefixes`.
 *   4. No rule matches one of `htmlPatterns` — HTML must stay revalidated or deploys never surface.
 *
 * Check 3 is safety-critical (design §3.1): `immutable` on an unhashed path is cache poisoning —
 * the file changes, the URL does not, and clients hold a stale copy for up to a year. FAIL CLOSED:
 * an unrecognised or unparseable rule is a problem, never a pass.
 *
 * Anti-vacuity, per plan §2 constraint 4 ("fail closed... never a silent pass"): a readable
 * `assetsDir` with 0 files, or a `headersFile` that parses to 0 rules, means nothing was actually
 * examined. Both report `empty-input` rather than the vacuous `ok: true` an empty build would
 * otherwise produce.
 *
 * Deliberately does NOT: read `sharp` or any native binary (ruling 6.3), touch the DOM, or author a
 * `_headers` file — it only measures one a consumer already built.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

export type HeadersProblemKind =
  | 'missing-headers-file'
  | 'empty-input'
  | 'unhashed-asset'
  | 'unauthorized-immutable'
  | 'html-rule';

export interface HeadersProblem {
  kind: HeadersProblemKind;
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
  let assetFiles: string[];
  try {
    assetFiles = readdirSync(assetsDir);
  } catch {
    // Fail closed: an unreadable assets dir is a problem, not a vacuous pass — there is nothing to
    // confirm every file is hashed, so the check cannot claim it passed.
    problems.push({
      kind: 'unhashed-asset',
      path: assetsDir,
      detail: `could not read "${assetsDir}" — did the build run?`,
    });
    return;
  }

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

  const unhashed = assetFiles.filter((name) => !hashPattern.test(name));
  for (const name of unhashed) {
    problems.push({
      kind: 'unhashed-asset',
      path: `${assetsDir}/${name}`,
      detail:
        `"${name}" under "${assetsDir}" does not carry a content hash — an immutable rule on ` +
        'this directory would cache it forever with no way to bust the cache.',
    });
  }
}

function checkRule(
  rule: HeaderRule,
  immutablePrefixes: readonly string[],
  htmlPatterns: readonly string[],
  problems: HeadersProblem[],
): void {
  const grantsImmutable = rule.lines.some((line) => /immutable/i.test(line));
  if (grantsImmutable && !immutablePrefixes.some((prefix) => rule.path.startsWith(prefix))) {
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

  const contents = readFileSync(headersFile, 'utf8');
  const rules = parseHeaderRules(contents);

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
    checkRule(rule, immutablePrefixes, htmlPatterns, problems);
  }

  return { ok: problems.length === 0, problems };
}
