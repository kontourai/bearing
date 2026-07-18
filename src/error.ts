export type BearingErrorCode =
  | "INVALID_OBSERVATION"
  | "UNSUPPORTED_SCHEMA"
  | "DUPLICATE_OBSERVATION"
  | "INVALID_COMPILE_OPTIONS";

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
