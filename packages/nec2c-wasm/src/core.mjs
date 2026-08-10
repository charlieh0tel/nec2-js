// Shared implementation behind both entry points. The only difference between
// them is which Emscripten factory they hand to createRunner: the one whose
// .wasm sits beside it as a separate file, or the SINGLE_FILE build with the
// wasm embedded.
//
// nec2c is a file-in/file-out CLI. We run it against an in-memory (MEMFS)
// filesystem: write the input deck, invoke main() with -i/-o, read the output.
//
// The module is built with EXIT_RUNTIME=1, so the runtime is torn down when
// main() returns and an instance cannot be reused. nec2c also keeps extensive
// file-scope global state. Both facts point to the same design: instantiate a
// fresh module for every call. The factory (from MODULARIZE) is imported once
// and is cheap to re-invoke; only the per-call instance holds run state.

const INPUT_PATH = "in.nec";
const OUTPUT_PATH = "out.txt";

// Thrown when nec2c exits non-zero. Carries everything needed to diagnose the
// run without re-executing it.
//
// nec2c reports most input problems by writing a message into its *output
// file* ("GEOMETRY DATA CARD ERROR" and friends) rather than to stderr, so
// `output` is usually where the real explanation is; stdout and stderr are
// often both empty on a failed run.
export class Nec2cError extends Error {
  /**
   * @param {number} exitCode status nec2c exited with
   * @param {string} deck the submitted input deck
   * @param {string} stdout captured stdout, often empty on failure
   * @param {string} stderr captured stderr, often empty on failure
   * @param {string} output nec2c's output file, empty if never opened
   */
  constructor(exitCode, deck, stdout, stderr, output) {
    const detail = stderr.trim() || diagnosticLine(output) || stdout.trim();
    super(`nec2c exited with code ${exitCode}${detail ? `: ${detail}` : ""}`);
    this.name = "Nec2cError";
    this.exitCode = exitCode;
    this.deck = deck;
    this.stdout = stdout;
    this.stderr = stderr;
    this.output = output;
  }
}

// nec2c's complaint is an uppercase line near the end of the output file, but
// the very last line is often a half-formatted data row, so match on the
// wording rather than taking the tail.
/**
 * @param {string} output text of nec2c's output file
 * @returns {string} the complaint line, or "" if none is recognizable
 */
function diagnosticLine(output) {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/ERROR|ABORT|CANNOT|FAULT/i.test(lines[i])) return lines[i];
  }
  return "";
}

/**
 * Builds a runNec bound to one Emscripten factory.
 *
 * @param {(args: object) => Promise<any>} createNec2c MODULARIZE factory
 * @returns {(deckText: string, options?: {locateFile?: (path: string, scriptDirectory: string) => string}) => Promise<string>}
 */
export function createRunner(createNec2c) {
  /**
   * @param {string} deckText NEC input deck
   * @param {{locateFile?: (path: string, scriptDirectory: string) => string}} [options]
   * @returns {Promise<string>} text of nec2c's output file
   */
  return async function runNec(deckText, options = {}) {
    const stdout = [];
    const stderr = [];
    // With EXIT_RUNTIME=1, callMain returns the exit status directly and also
    // reports it through onExit. Module.quit is NOT an override point in
    // current Emscripten -- supplying one silently does nothing, which is an
    // easy way to mistake a failed run for a successful one.
    let exitCode = 0;

    const moduleArgs = {
      noInitialRun: true,
      onExit: (code) => {
        exitCode = code;
      },
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    };
    if (options.locateFile) moduleArgs.locateFile = options.locateFile;

    const module = await createNec2c(moduleArgs);

    module.FS.writeFile(INPUT_PATH, deckText);

    // Under Node, Emscripten's exit path assigns process.exitCode, so a failed
    // nec2c run would leave the host process exiting non-zero even though the
    // failure is reported here as an exception. Restore whatever the caller
    // had; the exit status of their program is not ours to set.
    const hostProcess = globalThis.process;
    const priorExitCode = hostProcess?.exitCode;

    // finally, not a straight-line restore: callMain can throw rather than
    // exit (an Emscripten abort, a trap, memory growth failing), and the host's
    // exit code must not be left changed on the way out.
    try {
      const returned = module.callMain(["-i", INPUT_PATH, "-o", OUTPUT_PATH]);
      if (typeof returned === "number") exitCode = returned;
    } finally {
      if (hostProcess && hostProcess.exitCode !== priorExitCode) {
        hostProcess.exitCode = priorExitCode;
      }
    }

    // Read the output file even when the run failed, since that is where the
    // diagnostic is. It is absent if nec2c aborted before opening it.
    let output = "";
    try {
      output = module.FS.readFile(OUTPUT_PATH, { encoding: "utf8" });
    } catch {
      output = "";
    }

    if (exitCode !== 0) {
      throw new Nec2cError(
        exitCode,
        deckText,
        stdout.join("\n"),
        stderr.join("\n"),
        output,
      );
    }

    return output;
  };
}
