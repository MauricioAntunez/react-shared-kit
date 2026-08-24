// The sharp-free verification subpath. Unlike ./node, this must never import sharp: it exists so
// deploy-chain gates can measure images and check object-fit with zero native binaries installed.

export type { ImageManifest, ManifestEntry, Rung, RungFiles } from '../types.ts';
export type { IntrinsicSize } from './dimensions.ts';
export { intrinsicSize, sameAspect } from './dimensions.ts';
export { isSameEntryModule, makeEntryPointCheck } from './entry.ts';
export type {
  HtmlImageProblem,
  ImgTag,
  VerifyHtmlImagesOptions,
  VerifyHtmlImagesResult,
} from './html.ts';
export { extractImgTags, hasObjectFit, verifyHtmlImages } from './html.ts';
export type { MetadataLeak } from './metadata.ts';
export { scanMetadataLeaks } from './metadata.ts';
export type { ObjectFit } from './objectFit.ts';
export { isDistortingFit, NON_DISTORTING_FITS } from './objectFit.ts';
export type {
  TreeIssue,
  TreeIssueKind,
  VerifyImageTreeOptions,
  VerifyImageTreeResult,
} from './tree.ts';
export { verifyImageTree } from './tree.ts';
