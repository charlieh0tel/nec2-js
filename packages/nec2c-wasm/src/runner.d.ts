/** Resolves a runtime asset (currently only `nec2c.wasm`) to a URL or path. */
export type LocateFile = (path: string, scriptDirectory: string) => string;

export interface RunNecOptions {
  /**
   * Overrides how `nec2c.wasm` is located. Defaults to resolution relative to
   * the glue module's own URL, which is correct under Node and any bundler
   * that emits the two files together.
   */
  locateFile?: LocateFile;
}

/** Thrown when nec2c exits non-zero. */
export declare class Nec2cError extends Error {
  name: "Nec2cError";
  /** Process exit code reported by nec2c. */
  exitCode: number;
  /** The deck that was submitted, for diagnosis without re-running. */
  deck: string;
  stdout: string;
  stderr: string;
  /**
   * Whatever nec2c wrote to its output file before failing. This is normally
   * where the real explanation is ("GEOMETRY DATA CARD ERROR" and similar);
   * stdout and stderr are frequently both empty on a failed run. Empty if
   * nec2c aborted before opening the file.
   */
  output: string;
  constructor(
    exitCode: number,
    deck: string,
    stdout: string,
    stderr: string,
    output: string,
  );
}

/**
 * Runs one nec2c job on an in-memory filesystem and resolves to the full text
 * of its output file. A fresh WebAssembly instance is created per call, since
 * nec2c keeps file-scope global state and the module tears its runtime down
 * when `main()` returns.
 *
 * @throws {Nec2cError} if nec2c exits non-zero.
 */
export declare function runNec(
  deckText: string,
  options?: RunNecOptions,
): Promise<string>;
