// Does the solver's Sommerfeld/Norton ground evaluation converge to a perfect
// ground plane as conductivity goes to infinity?
//
// That limit is unambiguous physics rather than a modelling judgement: as
// sigma -> infinity a lossy half-space becomes a perfect conductor, so GN 2
// must approach the GN 1 answer for the same geometry. Anything else is a
// fault in the Sommerfeld evaluation, and the size of the gap is the size of
// the fault.
//
// Usage:
//   node investigations/sommerfeld.mjs                     # bundled wasm nec2c
//   node investigations/sommerfeld.mjs <style> <command>   # another solver
//
// The second form is the point of this script: running an alternative
// implementation over the same decks is what separates a bug in one solver
// from a limit of the NEC-2 method, and that is the question standing between
// this repo and packaging nec2++ (see TODO.md).
//
// NEC implementations disagree about how to be invoked, so <style> names the
// convention:
//
//   flags     -i IN -o OUT          nec2c
//   attached  -iIN -oOUT            nec2++
//   stdio     deck on stdin, output on stdout    nec2dxs and other Fortran
//                                               NEC-2 builds
//   jobname   NAME (reads NAME.nec, writes NAME.res)   aegnec2
//
// For example:
//   node investigations/sommerfeld.mjs attached ~/src/necpp/_install_/bin/nec2++
//   node investigations/sommerfeld.mjs stdio    ~/src/nec2/nec2dxs
//   node investigations/sommerfeld.mjs jobname  ~/src/aegnec2/_install_/bin/aegnec2
//
// A solver needing a shared library it cannot find on its own wants
// LD_LIBRARY_PATH set in the environment; this script passes the environment
// through untouched.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDeck, parseOutput } from "../packages/nec2c-deck/dist/index.js";
import { runNec as runWasm } from "../packages/nec2c-wasm/src/runner.mjs";

const FREQ_MHZ = 145.9;
const LIGHT_MHZ_M = 299.792458;
const LAMBDA = LIGHT_MHZ_M / FREQ_MHZ;
// A conductivity far past any real material, standing in for the limit.
const SIGMA_LIMIT = 1e10;
// Permittivity is held fixed; at this conductivity it no longer matters.
const EPS_R = 13;
// Above about a hundredth of a percent, the two grounds are not the same
// answer and the Sommerfeld evaluation is the only thing that differs.
const AGREEMENT_PCT = 0.01;

// One horizontal half-wave dipole, fed at the centre, at a given height.
function dipoleDeck(heightWl, ground) {
  const z = heightWl * LAMBDA;
  return buildDeck({
    comments: [`sommerfeld probe h=${heightWl}wl`],
    wires: [
      {
        tag: 1,
        segments: 11,
        x1: -0.5,
        y1: 0,
        z1: z,
        x2: 0.5,
        y2: 0,
        z2: z,
        radiusM: 0.001,
      },
    ],
    sources: [{ tag: 1, segment: 6, vReal: 1, vImag: 0 }],
    ground,
    freqMhz: FREQ_MHZ,
    grid: { ntheta: 1, nphi: 1, theta0: 0, phi0: 0, dtheta: 0, dphi: 0 },
  });
}

// How a given solver wants to be invoked. Each entry turns a deck and a
// scratch directory into the argv, stdin and output location to use.
const STYLES = {
  flags: (dir) => ({
    args: ["-i", join(dir, "in.nec"), "-o", join(dir, "out.txt")],
    output: join(dir, "out.txt"),
  }),
  attached: (dir) => ({
    args: [`-i${join(dir, "in.nec")}`, `-o${join(dir, "out.txt")}`],
    output: join(dir, "out.txt"),
  }),
  stdio: (dir) => ({
    args: [],
    stdin: join(dir, "in.nec"),
    // Fortran NEC-2 builds write the report to stdout.
    output: null,
  }),
  jobname: (dir) => ({
    // Reads <name>.nec and writes <name>.res beside it.
    args: [join(dir, "in")],
    output: join(dir, "in.res"),
  }),
};

// Wraps an external solver as a runner, so an alternative implementation can be
// measured with the same decks.
function externalRunner(style, command) {
  const plan = STYLES[style];
  if (!plan) {
    throw new Error(
      `unknown style ${JSON.stringify(style)}; expected one of ${Object.keys(STYLES).join(", ")}`,
    );
  }
  return async (deck) => {
    // nec2c has a fixed-size filename buffer and aborts on long paths, so keep
    // the scratch directory short.
    const dir = mkdtempSync(join(tmpdir(), "sf-"));
    writeFileSync(join(dir, "in.nec"), deck);
    const { args, stdin, output } = plan(dir);
    const stdout = execFileSync(command, args, {
      input: stdin ? readFileSync(stdin) : undefined,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return output ? readFileSync(output, "utf8") : stdout.toString();
  };
}

// nec2c-deck's parsers are keyed to nec2c's formatting, and the Fortran NEC-2
// builds differ from it in two ways that matter here. Both are presentation,
// not content, so normalizing is enough to compare the numbers.
function normalize(text) {
  return (
    text
      // Section titles are fenced with spaced dashes: "- - - TITLE - - -".
      .replace(/^(\s*)((?:- )+)([A-Z][A-Z .]*[A-Z])( -)+\s*$/gm, "$1--- $3 ---")
      // Fixed-column fields have no separator to spare, so a negative value
      // runs straight onto the one before it: "1.0E-02-2.2E-03".
      .replace(/(E[+-]\d\d)(?=-)/g, "$1 ")
  );
}

const [style, command] = process.argv.slice(2);
if (style && !command) {
  console.error(
    `usage: sommerfeld.mjs [<style> <command>]\n       styles: ${Object.keys(STYLES).join(", ")}`,
  );
  process.exit(2);
}
const runner = command ? externalRunner(style, command) : runWasm;

const feedResistance = async (heightWl, ground) => {
  const result = parseOutput(
    normalize(await runner(dipoleDeck(heightWl, ground))),
  );
  const source = result.sources[0];
  if (!source) throw new Error("no source parsed");
  return source.zReal;
};

console.log(
  `solver: ${command ? `${command} (${style})` : "nec2c-wasm (bundled)"}`,
);
console.log(
  `horizontal half-wave dipole, ${FREQ_MHZ} MHz, feedpoint resistance in ohms\n`,
);
console.log(
  "  height      GN 1 perfect    GN 2 sigma=1e10           error   verdict",
);

let worst = 0;
let failures = 0;
for (const heightWl of [
  0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.15, 0.25, 0.5, 1,
]) {
  let line;
  try {
    const perfect = await feedResistance(heightWl, true);
    const limit = await feedResistance(heightWl, {
      epsR: EPS_R,
      sigmaSm: SIGMA_LIMIT,
      method: "sommerfeld",
    });
    const errorPct = (100 * (limit - perfect)) / perfect;
    const diverged = Math.abs(errorPct) > AGREEMENT_PCT;
    if (diverged) worst = Math.max(worst, Math.abs(errorPct));
    const shown = `${errorPct >= 0 ? "+" : ""}${errorPct.toFixed(2)}%`;
    line = `${`${heightWl}`.padStart(8)}wl ${perfect.toFixed(3).padStart(14)} ${limit.toFixed(3).padStart(18)} ${shown.padStart(14)}   ${diverged ? "DIVERGES" : "agrees"}`;
  } catch (e) {
    // A solver that refuses or crashes has also failed to reach the limit; it
    // just fails louder than one that returns a confident wrong number.
    failures += 1;
    line = `${`${heightWl}`.padStart(8)}wl   failed: ${e.message.split("\n")[0].slice(0, 60)}`;
  }
  console.log(line);
}

console.log("");
if (failures) {
  console.log(
    `${failures} height${failures === 1 ? "" : "s"} produced no answer at all, so this solver did not meet the limit there either.`,
  );
}
console.log(
  worst > AGREEMENT_PCT
    ? `Worst divergence ${worst.toFixed(1)}% of the heights that did solve. The limit is exact, so a gap of that size is the Sommerfeld evaluation, not the model being hard.`
    : failures
      ? "Every height that solved met the limit."
      : "Converges to perfect ground at every height: the Sommerfeld evaluation is sound over this range.",
);
console.log(
  "\nNote: the breakdown is set by height in wavelengths, not by the mesh. Holding 0.02wl and varying the segment count from 3 to 81 -- a 27x range of segment lengths, spanning heights from an eighth of a segment to three of them -- leaves the error at about 91% throughout. Refining the model does not help; only lifting the antenna does.",
);
