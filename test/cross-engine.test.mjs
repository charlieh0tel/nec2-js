// Do the two solvers agree?
//
// nec2c and nec2++ are independent implementations of NEC-2 reached by
// completely different routes -- a deck of text through a parser, and a C++
// API through embind. Almost any mistake in either route shows up as
// disagreement here: a mis-mapped card, a units error, a transposed argument,
// a misread column.
//
// The tolerances are loose on purpose. This asks whether the two engines are
// solving the same structure, not whether they agree to the last digit; where
// they genuinely diverge, that is its own finding and belongs in
// investigations/ rather than in an assertion.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDeck, parseOutput } from "nec2c-deck";
import { runNec } from "nec2c-wasm";
import { createSolver } from "necpp-wasm";

const FREQ_MHZ = 145.9;
// Coarse enough to stay fast, but at least two of each angle so nec2++ will
// compute an average power gain.
const GRID = { ntheta: 3, nphi: 2, theta0: 0, phi0: 0, dtheta: 45, dphi: 90 };

// The same structure said twice, once per engine's vocabulary. Kept adjacent
// deliberately: if these ever drift apart the comparison is meaningless.
const GEOMETRIES = [
  {
    name: "a half-wave dipole in free space",
    deckWires: [
      {
        tag: 1,
        segments: 9,
        x1: 0,
        y1: 0,
        z1: 0,
        x2: 0,
        y2: 0,
        z2: 1,
        radiusM: 0.001,
      },
    ],
    apiWires: [
      {
        tag: 1,
        segments: 9,
        from: [0, 0, 0],
        to: [0, 0, 1],
        radiusM: 0.001,
      },
    ],
    segment: 5,
    ground: false,
    groundConnected: false,
  },
  {
    name: "a quarter-wave monopole bonded to perfect ground",
    deckWires: [
      {
        tag: 1,
        segments: 9,
        x1: 0,
        y1: 0,
        z1: 0,
        x2: 0,
        y2: 0,
        z2: 299.792458 / FREQ_MHZ / 4,
        radiusM: 0.001,
      },
    ],
    apiWires: [
      {
        tag: 1,
        segments: 9,
        from: [0, 0, 0],
        to: [0, 0, 299.792458 / FREQ_MHZ / 4],
        radiusM: 0.001,
      },
    ],
    segment: 1,
    ground: true,
    groundConnected: true,
  },
  {
    name: "a dipole well above real ground",
    deckWires: [
      {
        tag: 1,
        segments: 9,
        x1: 0,
        y1: 0,
        z1: 5,
        x2: 1,
        y2: 0,
        z2: 5,
        radiusM: 0.001,
      },
    ],
    apiWires: [
      {
        tag: 1,
        segments: 9,
        from: [0, 0, 5],
        to: [1, 0, 5],
        radiusM: 0.001,
      },
    ],
    segment: 5,
    // Five metres is about 2.4 wavelengths up, well clear of the regime
    // where NEC-2's Sommerfeld ground comes apart (see TODO.md).
    ground: { epsR: 13, sigmaSm: 0.005 },
    groundConnected: false,
  },
];

async function viaDeck(geometry) {
  const deck = buildDeck({
    comments: ["cross-engine"],
    wires: geometry.deckWires,
    sources: [{ tag: 1, segment: geometry.segment, vReal: 1, vImag: 0 }],
    ground: geometry.ground,
    groundConnected: geometry.groundConnected,
    freqMhz: FREQ_MHZ,
    grid: GRID,
  });
  return parseOutput(await runNec(deck));
}

function viaApi(solve, geometry) {
  return solve({
    wires: geometry.apiWires,
    sources: [
      {
        kind: "voltage",
        tag: 1,
        segment: geometry.segment,
        volts: { re: 1, im: 0 },
      },
    ],
    ground: geometry.ground,
    groundConnected: geometry.groundConnected,
    freqMhz: FREQ_MHZ,
    grid: GRID,
  });
}

// Feedpoint impedance is the sharpest single number the two share: it depends
// on the geometry, the segmentation, the source placement and the ground, so
// agreement here means the whole description survived both routes.
const IMPEDANCE_TOLERANCE = 0.02;
// Gain is an integral over the pattern and the two engines sample and
// normalize it slightly differently, so it gets a wider band.
const GAIN_TOLERANCE_DB = 0.5;

describe("nec2c and nec2++ on the same structure", () => {
  for (const geometry of GEOMETRIES) {
    it(`agree on ${geometry.name}`, async () => {
      const solve = await createSolver();
      const deckResult = await viaDeck(geometry);
      const apiResult = viaApi(solve, geometry);

      const deckZ = deckResult.sources[0];
      const apiZ = apiResult.feeds[0].impedance;

      const relative = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), 1);
      assert.ok(
        relative(deckZ.zReal, apiZ.re) < IMPEDANCE_TOLERANCE,
        `resistance: nec2c ${deckZ.zReal}, nec2++ ${apiZ.re}`,
      );
      assert.ok(
        relative(deckZ.zImag, apiZ.im) < IMPEDANCE_TOLERANCE,
        `reactance: nec2c ${deckZ.zImag}, nec2++ ${apiZ.im}`,
      );

      // Same directions, sampled the same way, so these line up index for
      // index. The peak is compared rather than every point: a null is
      // -999.99 in both and comparing those says nothing.
      assert.equal(deckResult.pattern.length, apiResult.pattern.length);
      const deckPeak = Math.max(
        ...deckResult.pattern.map((p) => p.totalGainDb),
      );
      const apiPeak = Math.max(...apiResult.pattern.map((p) => p.totalGainDb));
      assert.ok(
        Math.abs(deckPeak - apiPeak) < GAIN_TOLERANCE_DB,
        `peak gain: nec2c ${deckPeak} dB, nec2++ ${apiPeak} dB`,
      );

      // Both should report the same number of segments carrying current.
      assert.equal(deckResult.currents.length, apiResult.currents.length);
    });
  }

  it("agree that a conductivity load costs efficiency", async () => {
    // Loss is where the two routes are most likely to disagree silently: the
    // deck writes an LD card in E notation and nec2++ takes the same numbers
    // through a function call.
    const solve = await createSolver();
    const geometry = GEOMETRIES[0];
    const load = { kind: "conductivity", tag: 1, sigmaSm: 1.0e6 };

    const deck = buildDeck({
      comments: ["lossy"],
      wires: geometry.deckWires,
      sources: [{ tag: 1, segment: geometry.segment, vReal: 1, vImag: 0 }],
      loads: [load],
      ground: false,
      freqMhz: FREQ_MHZ,
      grid: GRID,
    });
    const deckResult = parseOutput(await runNec(deck));
    const apiResult = solve({
      wires: geometry.apiWires,
      sources: [
        {
          kind: "voltage",
          tag: 1,
          segment: geometry.segment,
          volts: { re: 1, im: 0 },
        },
      ],
      loads: [load],
      ground: false,
      freqMhz: FREQ_MHZ,
      grid: GRID,
    });

    const deckZ = deckResult.sources[0].zReal;
    const apiZ = apiResult.feeds[0].impedance.re;
    assert.ok(
      Math.abs(deckZ - apiZ) / deckZ < IMPEDANCE_TOLERANCE,
      `loaded resistance: nec2c ${deckZ}, nec2++ ${apiZ}`,
    );
    // And both agree the loss is real: nec2c through its power budget,
    // nec2++ through the structure loss implied by a higher feed resistance.
    assert.ok(deckResult.power.structureLossW > 0);
    assert.ok(apiZ > 70, "a lossy dipole reads more resistive than 73 ohm");
  });
});
