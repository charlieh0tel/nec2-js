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
//   node investigations/sommerfeld.mjs            # the bundled wasm nec2c
//   node investigations/sommerfeld.mjs <command>  # any CLI taking -i IN -o OUT
//
// The second form is the point of this script: it runs an external solver
// through the same decks so the two can be compared directly. nec2++'s `necpp`
// executable takes the same -i/-o arguments as nec2c, so
//
//   node investigations/sommerfeld.mjs /usr/local/bin/necpp
//
// answers whether nec2c's numbers are a bug in nec2c or a limit of the NEC-2
// method itself -- which is the question standing between this repo and
// packaging nec2++ (see TODO.md).

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

// Wraps an external file-in/file-out solver as a runner, so an alternative
// implementation can be measured with the same decks.
function externalRunner(command) {
  return async (deck) => {
    // nec2c has a fixed-size filename buffer and aborts on long paths, so keep
    // the working directory short.
    const dir = mkdtempSync(join(tmpdir(), "sf-"));
    const inPath = join(dir, "in.nec");
    const outPath = join(dir, "out.txt");
    writeFileSync(inPath, deck);
    execFileSync(command, ["-i", inPath, "-o", outPath], { stdio: "ignore" });
    return readFileSync(outPath, "utf8");
  };
}

const command = process.argv[2];
const runner = command ? externalRunner(command) : runWasm;

const feedResistance = async (heightWl, ground) => {
  const result = parseOutput(await runner(dipoleDeck(heightWl, ground)));
  const source = result.sources[0];
  if (!source) throw new Error("no source parsed");
  return source.zReal;
};

console.log(`solver: ${command ?? "nec2c-wasm (bundled)"}`);
console.log(
  `horizontal half-wave dipole, ${FREQ_MHZ} MHz, feedpoint resistance in ohms\n`,
);
console.log(
  "  height      GN 1 perfect    GN 2 sigma=1e10           error   verdict",
);

let worst = 0;
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
    line = `${`${heightWl}`.padStart(8)}wl   failed: ${e.message.slice(0, 60)}`;
  }
  console.log(line);
}

console.log("");
console.log(
  worst > AGREEMENT_PCT
    ? `Worst divergence ${worst.toFixed(1)}%. The limit is exact, so a gap this size is the Sommerfeld evaluation being wrong, not the model being hard.`
    : "Converges to perfect ground at every height: the Sommerfeld evaluation is sound over this range.",
);
console.log(
  `\nNote: divergence sets in where the height approaches the segment length (${(LAMBDA / 11).toFixed(3)} m here), a geometry NEC-2 itself warns about. Running the same sweep through another NEC-2 implementation is what separates a bug in one solver from a limit of the method.`,
);
