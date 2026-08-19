/** One usage class: the width ladder it may generate, and the master width it requires. */
export interface ImageClassDef {
  /** Ascending, non-empty. The largest rung must equal `masterMin`. */
  widths: readonly number[];
  /** Minimum intrinsic width a master must have to serve this class honestly. */
  masterMin: number;
}

export type ImageClasses<K extends string = string> = Record<K, ImageClassDef>;

/** Emitted filenames for one rung, relative to the master's directory. */
export interface RungFiles {
  avif: string;
  webp: string;
  jpeg: string;
}

/** One emitted rung. `w` is the MEASURED output width, never the requested one (D10). */
export interface Rung {
  w: number;
  files: RungFiles;
}

export interface ManifestEntry {
  /** Master intrinsic width. */
  w: number;
  /** Master intrinsic height. */
  h: number;
  class: string;
  rungs: Rung[];
}

/** Keyed by full source path INCLUDING extension — `foo.png` and `foo.webp` are distinct. */
export type ImageManifest = Record<string, ManifestEntry>;

/** One entry of a `sizes` attribute. The final entry must have no `minWidth`. */
export interface SizeEntry {
  minWidth?: string | undefined;
  value: string;
}
