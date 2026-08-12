// Energy conservation, against arithmetic rather than against another solver.
//
// A lossless antenna over a perfect conductor puts all of its input power into
// the upper hemisphere, so the average power gain over 2 pi steradians is
// exactly 2. Nothing here has to be told that by a reference implementation:
// either an engine meets the limit or it does not.
//
// That makes this the one check that cannot be argued away as two
// implementations disagreeing, and the one that would catch a bad rebuild or a
// bad submodule bump numerically. NEC obtains the figure by integrating the
// far field, so it exercises a different path from the feedpoint impedance the
// cross-engine test compares.
//
// NEC's own POWER BUDGET cannot serve here: it reports radiated power as input
// minus losses, so it balances by construction and can never show a violation.
//
// Deliberately not tested near the ground. Below about 0.05 wavelengths NEC-2's
// Sommerfeld evaluation stops meeting this limit -- that is the method, not
// nec2c, and it is documented rather than asserted. Encoding today's wrong
// numbers would pin a defect nobody here controls.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDeck, parseOutput } from "nec2c-deck";
import { runNec } from "nec2c-wasm";
import { createSolver } from "necpp-wasm";

const FREQ_MHZ = 145.9;
const WAVELENGTH_M = 299.792458 / FREQ_MHZ;

// Heights where NEC-2's ground treatment is sound. 0.05 wavelengths is where
// it starts to come apart, so the lower of these has a comfortable margin.
const HEIGHTS_WL = [0.5, 0.1];

// The exact answer: all the power into half the sphere.
const EXACT = 2;

// The angular grid has an error of its own. Measured at about 0.25 percent
// over a perfect ground at every height, so 1 percent is four times the noise
// floor and still far tighter than any real disagreement.
const TOLERANCE = 0.01;

// At least two samples in each angle, or NEC refuses to average at all
// (main.c forces iavp = 0). The trailing 1 of the XNDA code is the A digit
// asking for it.
const GRID = {
  ntheta: 19,
  nphi: 37,
  theta0: 0,
  phi0: 0,
  dtheta: 5,
  dphi: 10,
};
const AVERAGING_OPTION_CODE = 1001;

const wireAt = (heightM) => ({
  tag: 1,
  segments: 11,
  x1: -0.5,
  y1: 0,
  z1: heightM,
  x2: 0.5,
  y2: 0,
  z2: heightM,
  radiusM: 0.001,
});

async function viaNec2c(heightM) {
  const deck = buildDeck({
    comments: ["average power gain over a perfect conductor"],
    wires: [wireAt(heightM)],
    sources: [{ tag: 1, segment: 6, vReal: 1, vImag: 0 }],
    ground: true,
    freqMhz: FREQ_MHZ,
    grid: { ...GRID, optionCode: AVERAGING_OPTION_CODE },
  });
  const result = parseOutput(await runNec(deck));
  assert.ok(
    result.averagePowerGain,
    "nec2c printed no average power gain; the A digit or the grid is wrong",
  );
  return result.averagePowerGain;
}

function viaNecpp(solve, heightM) {
  const result = solve({
    wires: [
      {
        tag: 1,
        segments: 11,
        from: [-0.5, 0, heightM],
        to: [0.5, 0, heightM],
        radiusM: 0.001,
      },
    ],
    sources: [{ kind: "voltage", tag: 1, segment: 6, volts: { re: 1, im: 0 } }],
    ground: true,
    freqMhz: FREQ_MHZ,
    grid: { ...GRID, average: 1 },
  });
  assert.ok(
    typeof result.averagePowerGain === "number",
    "nec2++ returned no average power gain",
  );
  return result.averagePowerGain;
}

describe("average power gain over a perfect conductor", () => {
  for (const heightWl of HEIGHTS_WL) {
    const heightM = heightWl * WAVELENGTH_M;

    it(`nec2c conserves energy at ${heightWl} wavelengths`, async () => {
      const { gain, solidAngleOverPi } = await viaNec2c(heightM);
      // The grid covers the upper hemisphere, so the average is taken over
      // 2 pi steradians. If this drifts the gain means something else.
      assert.ok(
        Math.abs(solidAngleOverPi - 2) < 0.01,
        `averaged over ${solidAngleOverPi}*pi steradians, expected 2`,
      );
      assert.ok(
        Math.abs(gain - EXACT) / EXACT < TOLERANCE,
        `average power gain ${gain}, expected ${EXACT}`,
      );
    });

    it(`nec2++ conserves energy at ${heightWl} wavelengths`, async () => {
      const solve = await createSolver();
      const gain = viaNecpp(solve, heightM);
      assert.ok(
        Math.abs(gain - EXACT) / EXACT < TOLERANCE,
        `average power gain ${gain}, expected ${EXACT}`,
      );
    });
  }

  it("both engines agree with each other, not just with the limit", async () => {
    // Meeting the limit separately is the real check; this catches the case
    // where both are wrong in the same direction by the grid's own error.
    const solve = await createSolver();
    const heightM = HEIGHTS_WL[0] * WAVELENGTH_M;
    const { gain: fromNec2c } = await viaNec2c(heightM);
    const fromNecpp = viaNecpp(solve, heightM);
    assert.ok(
      Math.abs(fromNec2c - fromNecpp) / EXACT < TOLERANCE,
      `nec2c ${fromNec2c}, nec2++ ${fromNecpp}`,
    );
  });
});
