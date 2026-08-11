// The numbers here are cross-checked against nec2c, not just against a
// previous run of this package: a 1 m dipole at 145.9 MHz reads 75.25 ohm
// through nec2c-wasm, and nec2++ has to agree to be worth having.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSolver } from "../src/runner.mjs";

const WIRE = {
  tag: 1,
  segments: 9,
  x1: 0,
  y1: 0,
  z1: 0,
  x2: 0,
  y2: 0,
  z2: 1,
  radiusM: 0.001,
};
const SOURCE = { tag: 1, segment: 5, vReal: 1, vImag: 0 };
// Three theta by two phi, with averaging on: NEC needs at least two of each
// before it will compute an average power gain.
const GRID = {
  ntheta: 3,
  nphi: 2,
  theta0: 0,
  phi0: 0,
  dtheta: 45,
  dphi: 90,
  average: 1,
};

const model = (overrides) => ({
  wires: [WIRE],
  sources: [SOURCE],
  ground: false,
  freqMhz: 145.9,
  grid: GRID,
  ...overrides,
});

describe("nec2pp-wasm", () => {
  it("agrees with nec2c on a dipole feedpoint", async () => {
    const solve = await createSolver();
    const result = solve(model());
    const z = result.sources[0];
    assert.ok(
      Math.abs(z.zReal - 75.2571) < 0.01,
      `expected ~75.2571 ohm, got ${z.zReal}`,
    );
    assert.ok(z.zImag > 0, "a slightly long dipole should be inductive");
  });

  it("returns the whole pattern, not just scalars", async () => {
    const solve = await createSolver();
    const result = solve(model());
    assert.equal(result.pattern.length, GRID.ntheta * GRID.nphi);

    // Broadside to a vertical dipole is the third theta (0, 45, 90) and is
    // where the ~2.1 dBi sits.
    const broadside = result.pattern[2];
    assert.equal(broadside.thetaDeg, 90);
    assert.ok(
      Math.abs(broadside.totalGainDb - 2.13) < 0.05,
      `expected ~2.13 dB broadside, got ${broadside.totalGainDb}`,
    );
    // A straight wire radiates linearly.
    assert.equal(broadside.sense, "LINEAR");
    assert.ok(broadside.axialRatio < 1e-6);
    assert.ok(broadside.eThetaMagnitude > 0);
  });

  it("returns per-segment currents", async () => {
    const solve = await createSolver();
    const result = solve(model());
    assert.equal(result.currents.length, WIRE.segments);
    const feed = result.currents[4];
    assert.equal(feed.tag, 1);
    assert.equal(feed.segment, 5);
    assert.ok(Math.hypot(feed.iReal, feed.iImag) > 0);
    // The feed segment carries the most current on a centre-fed dipole.
    const magnitudes = result.currents.map((c) => Math.hypot(c.iReal, c.iImag));
    assert.equal(Math.max(...magnitudes), magnitudes[4]);
  });

  it("reports average power gain, which nec2c-deck cannot compute", async () => {
    // The figure that stays honest over lossy ground, where a power budget
    // taken as input-minus-losses counts what the earth absorbs as radiated.
    const solve = await createSolver();
    const result = solve(model());
    assert.ok(
      result.averagePowerGain > 0.9 && result.averagePowerGain <= 1.5,
      `expected a near-unity average power gain in free space, got ${result.averagePowerGain}`,
    );
  });

  it("makes a wire lossy with a conductivity load", async () => {
    const solve = await createSolver();
    const copper = solve(
      model({ loads: [{ kind: "conductivity", tag: 1, sigmaSm: 5.8e7 }] }),
    );
    const steel = solve(
      model({ loads: [{ kind: "conductivity", tag: 1, sigmaSm: 1.0e6 }] }),
    );
    assert.ok(
      steel.sources[0].zReal > copper.sources[0].zReal,
      "steel should read more resistive than copper",
    );
  });

  it("solves over ground", async () => {
    const solve = await createSolver();
    const result = solve(
      model({ ground: { epsR: 13, sigmaSm: 0.005 }, groundConnected: false }),
    );
    assert.ok(result.sources[0].zReal > 0);
    assert.equal(result.pattern.length, GRID.ntheta * GRID.nphi);
  });

  it("refuses radials over Sommerfeld ground", async () => {
    const solve = await createSolver();
    assert.throws(
      () =>
        solve(
          model({
            ground: {
              epsR: 13,
              sigmaSm: 0.005,
              method: "sommerfeld",
              radials: { count: 32, screenRadiusM: 5, wireRadiusM: 0.0008 },
            },
          }),
        ),
      /cannot be combined with the Sommerfeld ground/,
    );
  });
});
