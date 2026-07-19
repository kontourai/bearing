export type BearingErrorCode =
  | "INVALID_OBSERVATION"
  | "UNSUPPORTED_SCHEMA"
  | "DUPLICATE_OBSERVATION"
  | "INVALID_COMPILE_OPTIONS"
  | "INVALID_CATALOG"
  | "UNSUPPORTED_CATALOG_SCHEMA"
  | "INVALID_RANK_REQUEST"
  | "INVALID_SOURCE_SNAPSHOT"
  | "INVALID_SOURCE_MANIFEST"
  | "INVALID_SOURCE_DISCOVERY";

export class BearingError extends Error {
  readonly code: BearingErrorCode;
  readonly path: string;

  constructor(code: BearingErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "BearingError";
    this.code = code;
    this.path = path;
  }
}
