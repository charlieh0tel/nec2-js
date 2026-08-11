// Does the solver conserve energy near ground?
//
// A lossless antenna over a perfect conductor radiates all of its input power
// into the upper hemisphere, so the average power gain over 2 pi steradians is
// exactly 2. That is a closed-form reference: this measurement does not need a
// second solver to say what the answer should be.
//
// It is also independent of the impedance. NEC obtains average power gain by
// integrating the far field over the sampled solid angle, whereas the
// feedpoint impedance comes from the current solution -- so this and
// sommerfeld.mjs probe the same regime through different quantities.
//
// NEC's own POWER BUDGET cannot serve here. It reports radiated power as
// input minus losses (main.c: pin - pnls - ploss), so it balances by
// construction and can never show a violation.
//
// Usage:
//   node investigations/average-power-gain.mjs                    # native nec2c
//   node investigations/average-power-gain.mjs <style> <command>  # another solver
//
// Styles are as in sommerfeld.mjs: flags, attached, stdio, jobname. The wasm
// runner is not used here because the check wants whatever binary is being
// examined, and comparing several is the point.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDeck } from "../packages/nec2c-deck/dist/index.js";

const FREQ_MHZ = 145.9;
const LAMBDA = 299.792458 / FREQ_MHZ;
// Far past any real material: the ground absorbs nothing, so the answer must
// be the perfectly conducting one.
const SIGMA_LIMIT = 1e10;
const EPS_R = 13;
// Average gain over the upper hemisphere for a lossless antenna over a perfect
// conductor. All the power goes up, into half the sphere.
const EXACT = 2;

// Averaging is only performed with at least two samples in each angle
// (main.c forces iavp = 0 otherwise). The A digit of XNDA requests it.
const AVERAGING_GRID = {
  ntheta: 19,
  nphi: 37,
  theta0: 0,
  phi0: 0,
  dtheta: 5,
  dphi: 10,
  optionCode: 1001,
};

const STYLES = {
  flags: (i, o) => ["-i", i, "-o", o],
  attached: (i, o) => [`-i${i}`, `-o${o}`],
  stdio: () => [],
  jobname: (i) => [i.replace(/\.nec$/, "")],
};

function deckFor(heightWl, ground) {
  const z = heightWl * LAMBDA;
  return buildDeck({
    comments: ["average power gain probe"],
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
    grid: AVERAGING_GRID,
  });
}

function averageGain(command, style, deckText) {
  const dir = mkdtempSync(join(tmpdir(), "apg-"));
  const inPath = join(dir, "in.nec");
  const outPath = join(dir, "out.txt");
  writeFileSync(inPath, deckText);
  const args = STYLES[style](inPath, outPath);
  const stdout = execFileSync(command, args, {
    input: style === "stdio" ? readFileSync(inPath) : undefined,
    stdio: [style === "stdio" ? "pipe" : "ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const text =
    style === "stdio"
      ? stdout.toString()
      : readFileSync(
          style === "jobname" ? `${inPath.replace(/\.nec$/, "")}.res` : outPath,
          "utf8",
        );
  // Printed as "AVERAGE POWER GAIN:  1.9951E+00 - SOLID ANGLE ...".
  const found = text.match(/AVERAGE POWER GAIN[:=]?\s*([-\d.E+]+)/i);
  if (!found) throw new Error("no average power gain in output");
  return Number(found[1]);
}

const [style = "flags", command = "/usr/bin/nec2c"] = process.argv.slice(2);
if (!STYLES[style]) {
  console.error(
    `unknown style ${style}; expected ${Object.keys(STYLES).join(", ")}`,
  );
  process.exit(2);
}

console.log(`solver: ${command} (${style})`);
console.log(
  `average power gain over the upper hemisphere; exactly ${EXACT} for a lossless antenna over a perfect conductor\n`,
);
console.log("  height     perfect    sigma=1e10    vs exact");

for (const heightWl of [0.002, 0.01, 0.02, 0.05, 0.25, 1]) {
  try {
    const perfect = averageGain(command, style, deckFor(heightWl, true));
    const limit = averageGain(
      command,
      style,
      deckFor(heightWl, {
        epsR: EPS_R,
        sigmaSm: SIGMA_LIMIT,
        method: "sommerfeld",
      }),
    );
    const vsExact = (100 * (limit - EXACT)) / EXACT;
    console.log(
      `${`${heightWl}wl`.padStart(8)} ${perfect.toFixed(4).padStart(11)} ${limit.toFixed(4).padStart(13)} ${`${vsExact >= 0 ? "+" : ""}${vsExact.toFixed(2)}%`.padStart(11)}`,
    );
  } catch (e) {
    console.log(
      `${`${heightWl}wl`.padStart(8)}   failed: ${e.message.split("\n")[0].slice(0, 50)}`,
    );
  }
}

console.log(
  "\nThe perfect-ground column is the measurement's own noise floor: it should read 2.0 too, and what it misses by is the angular grid, not the ground model. Read the last column against that, not against zero.",
);
