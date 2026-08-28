import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { intrinsicSize, sameAspect } from './dimensions.ts';
import { isDistortingFit } from './objectFit.ts';
import { walkFiles } from './walk.ts';

/**
 * Every rendered `<img>` states its box, and that box does not distort the picture (D17).
 *
 * Ported from two independent tools that both hit the same gap: web-usa's presence-only check
 * (missing width/height reserves no space, so the page reflows as bytes arrive) and boufin's
 * superset (a box whose ratio is not the file's ratio ships a squashed image even though it
 * reserved the right AREA). `resolveAsset` is the switch between the two: omit it for the web-usa
 * subset, provide it to opt into the boufin ratio + `object-fit` escape-hatch checks.
 *
 * Runs against BUILT html, never source: a component can render a dynamic `src`, so scanning
 * `.tsx` would miss everything the build actually produced.
 */

/** One `<img>` tag's attributes, as rendered. */
export interface ImgTag {
  src?: string;
  width?: number;
  height?: number;
  classes: string[];
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match?.[1];
}

/** A present-but-empty or non-numeric value reserves no space, so it reads as absent. */
function numericAttr(tag: string, name: string): number | undefined {
  const raw = attr(tag, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function extractImgTags(html: string): ImgTag[] {
  return [...html.matchAll(/<img\s[^>]*>/g)].map((match) => {
    const tag = match[0] as string;
    const src = attr(tag, 'src');
    const width = numericAttr(tag, 'width');
    const height = numericAttr(tag, 'height');
    // exactOptionalPropertyTypes forbids `prop: undefined` — spread in only what is present.
    return {
      ...(src !== undefined && { src }),
      ...(width !== undefined && { width }),
      ...(height !== undefined && { height }),
      classes: (attr(tag, 'class') ?? '').split(/\s+/).filter(Boolean),
    };
  });
}

/**
 * Does any built stylesheet give one of `classes` an `object-fit` that reshapes rather than
 * stretches?
 *
 * Reads the stylesheet as TEXT — a real limitation (spec "Known limitations" 1): it cannot resolve
 * specificity, cascade layers or `@media`. This matcher has been defeated four times in review
 * (comment, descendant selector, two attribute-value shapes), each fixed and now a regression
 * test in `html.test.ts`. It stays the FAST first line, never the authority; a consumer that needs
 * the authority runs a browser-based `getComputedStyle` check of its own, which the kit
 * deliberately does not provide (no DOM environment here).
 */
export function hasObjectFit(classes: string[], css: string): boolean {
  // Comments stripped FIRST: defeat #1 was `.photo { /* TODO: object-fit: cover */ }`, prose about
  // a fit read as a fit. Production CSS is minified so comments do not survive today — but a gate
  // correct only because of a build setting it does not control is not correct.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');

  return classes.some((cls) => {
    const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const onElement = new RegExp(`\\.${escaped}(?![\\w-])`);

    for (const match of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const fit = /object-fit\s*:\s*([a-z-]+)/.exec(match[2] ?? '');
      if (!fit || isDistortingFit(fit[1] ?? '')) continue;

      // The class must be on the SUBJECT of the selector — the rightmost compound — not merely
      // present anywhere in it. Defeat #2: `.wrap .img { object-fit: cover }` gives the fit to
      // `.img`, but a naive read attributed it to `.wrap`, excusing every element carrying it.
      //
      // Attribute VALUES are blanked before splitting, ESCAPE-AWARE. Defeat #3:
      // `.unrelated[title=" .photo"]` splits on the space INSIDE the quoted value, producing a
      // fake trailing compound `.photo"]` that matched. Defeat #4: the first fix blanked
      // `\[[^\]]*\]`, which stops at the first literal `]`, so `[data-x="a\]b .photo"]` — where
      // that `]` is backslash-escaped and does not end the value — slipped through. `(?:\\.|[^\]\\])*`
      // consumes an escape pair as one unit, matching what CSS actually specifies.
      const selectors = (match[1] ?? '').replace(/\[(?:\\.|[^\]\\])*\]/g, '[]').split(',');
      const onSubject = selectors.some((sel) =>
        onElement.test(
          sel
            .split(/[\s>+~]+/)
            .filter(Boolean)
            .pop() ?? '',
        ),
      );
      if (onSubject) return true;
    }
    return false;
  });
}

/** Recursively lists every file under `dir` whose name ends with `extension`. Follows symlinks
 * (see `walk.ts` doc comment for why that is this module's original, preserved behaviour). */
function findFiles(dir: string, extension: string): string[] {
  return walkFiles(dir, { filter: (name) => name.endsWith(extension), followSymlinks: true });
}

export interface HtmlImageProblem {
  html: string;
  src: string;
  message: string;
}

export interface VerifyHtmlImagesOptions {
  dir: string;
  /**
   * Omit for presence-only mode (web-usa): only width/height presence is checked. Provide to opt
   * into full mode (boufin): each resolved image is measured and must match its declared ratio, or
   * carry a non-distorting `object-fit`. The sandbox against path traversal is this callback's
   * responsibility (boufin `resolveAsset` semantics) — this gate only honours `undefined` as
   * "unresolvable, skip"; it never resolves a `src` itself.
   */
  resolveAsset?: (src: string, dir: string) => string | undefined;
  /** `sameAspect` tolerance. Default 0.01 (1%). */
  tolerance?: number;
  /** Anti-vacuity floor: fewer images than this is itself a failure. Default 0 = off. */
  minImages?: number;
}

export interface VerifyHtmlImagesResult {
  ok: boolean;
  problems: HtmlImageProblem[];
  imagesChecked: number;
  htmlFiles: number;
}

/**
 * The verdict on ONE image: its problem message, or `undefined` if it is fine.
 *
 * Presence is checked unconditionally; the ratio/object-fit escape hatch only runs when
 * `resolveAsset` is supplied and actually resolves the `src` — an unresolved `src` is skipped
 * because whether a reference resolves at all is a different gate's job, not this one's.
 */
function checkImage(
  img: ImgTag,
  dir: string,
  css: string,
  tolerance: number,
  resolveAsset?: (src: string, dir: string) => string | undefined,
): string | undefined {
  if (img.width === undefined || img.height === undefined) {
    return 'has no width/height attributes — the browser reserves no space for it';
  }
  if (resolveAsset === undefined || img.src === undefined) return undefined;

  const file = resolveAsset(img.src, dir);
  if (file === undefined) return undefined;

  const intrinsic = intrinsicSize(file);
  if (intrinsic === undefined) {
    // Unreadable is NOT passing — a format this gate cannot measure is a gap in the reader, and
    // staying silent is how a whole format quietly stops being checked.
    return 'could not be measured — add its format to src/image/check/dimensions.ts';
  }

  const declared = { width: img.width, height: img.height };
  if (sameAspect(declared, intrinsic, tolerance) || hasObjectFit(img.classes, css)) {
    return undefined;
  }

  return (
    `declared ${img.width}x${img.height} but the file is ${intrinsic.width}x${intrinsic.height} ` +
    'it cannot fill that box. Either state the real ratio, or set `object-fit` on it.'
  );
}

export function verifyHtmlImages(options: VerifyHtmlImagesOptions): VerifyHtmlImagesResult {
  const { dir, resolveAsset, tolerance = 0.01, minImages = 0 } = options;
  const htmlPaths = findFiles(dir, '.html');
  // CSS is only relevant to the object-fit escape hatch, so it stays unread in presence-only mode.
  const css =
    resolveAsset === undefined
      ? ''
      : findFiles(dir, '.css')
          .map((file) => readFileSync(file, 'utf8'))
          .join('\n');

  const problems: HtmlImageProblem[] = [];
  let imagesChecked = 0;

  for (const htmlFile of htmlPaths) {
    const relHtml = relative(dir, htmlFile);
    for (const img of extractImgTags(readFileSync(htmlFile, 'utf8'))) {
      imagesChecked += 1;
      const message = checkImage(img, dir, css, tolerance, resolveAsset);
      if (message !== undefined) {
        problems.push({ html: relHtml, src: img.src ?? '(no src)', message });
      }
    }
  }

  // Unconditional (web-usa): a refactor that stops this gate seeing any HTML must fail loudly,
  // never report success over nothing it actually looked at.
  if (htmlPaths.length === 0) {
    problems.push({
      html: '(all)',
      src: '(none)',
      message: `no HTML found under ${dir} — run the build first`,
    });
  }

  // Opt-in (boufin): a lower floor than "at least one" for consumers who know their expected scale.
  if (minImages > 0 && imagesChecked < minImages) {
    problems.push({
      html: '(all)',
      src: '(none)',
      message:
        `only ${imagesChecked} image(s) checked, expected at least ${minImages} — ` +
        'this gate is not seeing the pages',
    });
  }

  return { ok: problems.length === 0, problems, imagesChecked, htmlFiles: htmlPaths.length };
}
