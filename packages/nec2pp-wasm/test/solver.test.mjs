// The numbers here are cross-checked against nec2c rather than against a
// previous run of this package: a 1 m dipole at 145.9 MHz reads 75.25 ohm
// through nec2c, and nec2++ has to agree to be worth having.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext, createSolver } from "../src/runner.mjs";

const WIRE = {
  tag: 1,
  segments: 9,
  from: [0, 0, 0],
  to: [0, 0, 1],
  radiusM: 0.001,
};
const SOURCE = { kind: "voltage", tag: 1, segment: 5, volts: { re: 1, im: 0 } };
// Three theta by two phi with averaging on: NEC needs at least two of each
// before it computes an average power gain.
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
    const feed = solve(model()).feeds[0];
    assert.equal(feed.tag, 1);
    assert.equal(feed.segment, 5);
    assert.ok(
      Math.abs(feed.impedance.re - 75.2571) < 0.01,
      `expected ~75.2571 ohm, got ${feed.impedance.re}`,
    );
    assert.ok(feed.impedance.im > 0, "a slightly long dipole is inductive");
  });

  it("reports feed current, voltage and power", async () => {
    // None of this is reachable through nec2++'s C API; it comes from the
    // structure-excitation result underneath.
    const solve = await createSolver();
    const feed = solve(model()).feeds[0];
    assert.deepEqual(feed.voltage, { re: 1, im: 0 });
    assert.ok(Math.hypot(feed.current.re, feed.current.im) > 0);
    assert.ok(feed.powerW > 0);
    // P = |V|^2 * Re(1/Z) / 2 for an applied voltage.
    const zMagSquared = feed.impedance.re ** 2 + feed.impedance.im ** 2;
    const expected = (1 * feed.impedance.re) / (2 * zMagSquared);
    assert.ok(
      Math.abs(feed.powerW - expected) < expected * 1e-6,
      `power ${feed.powerW} does not match V and Z`,
    );
  });

  it("returns the whole pattern, not just scalars", async () => {
    const solve = await createSolver();
    const result = solve(model());
    assert.equal(result.pattern.length, GRID.ntheta * GRID.nphi);

    // Broadside to a vertical dipole is the third theta (0, 45, 90).
    const broadside = result.pattern[2];
    assert.equal(broadside.thetaDeg, 90);
    assert.ok(
      Math.abs(broadside.totalGainDb - 2.13) < 0.05,
      `expected ~2.13 dB broadside, got ${broadside.totalGainDb}`,
    );
    assert.equal(broadside.sense, "LINEAR");
    assert.ok(broadside.axialRatio < 1e-6);
    assert.ok(broadside.eTheta.magnitude > 0);
    assert.equal(typeof broadside.ePhi.phaseDeg, "number");
  });

  it("reports gain statistics and average power gain", async () => {
    const solve = await createSolver();
    const result = solve(model());
    assert.ok(Math.abs(result.gain.maxDb - 2.13) < 0.05);
    assert.ok(result.gain.minDb <= result.gain.maxDb);
    assert.equal(typeof result.gain.sdDb, "number");
    assert.equal(typeof result.gainRhcp.maxDb, "number");
    // The figure that stays honest over lossy ground, where a budget taken as
    // input-minus-losses counts what the earth absorbs as radiated.
    assert.ok(
      result.averagePowerGain > 0.9 && result.averagePowerGain <= 1.5,
      `expected near-unity in free space, got ${result.averagePowerGain}`,
    );
  });

  it("omits average power gain when it was not asked for", async () => {
    const solve = await createSolver();
    const result = solve(model({ grid: { ...GRID, average: 0 } }));
    assert.equal(result.averagePowerGain, undefined);
  });

  it("returns per-segment currents", async () => {
    const solve = await createSolver();
    const result = solve(model());
    assert.equal(result.currents.length, WIRE.segments);
    const feed = result.currents[4];
    assert.equal(feed.tag, 1);
    assert.equal(feed.segment, 5);
    assert.equal(feed.at.length, 3);
    // The feed segment carries the most current on a centre-fed dipole.
    const magnitudes = result.currents.map((c) =>
      Math.hypot(c.current.re, c.current.im),
    );
    assert.equal(Math.max(...magnitudes), magnitudes[4]);
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
      steel.feeds[0].impedance.re > copper.feeds[0].impedance.re,
      "steel should read more resistive than copper",
    );
    // Loss shows up in the average power gain, which is the point of having it.
    assert.ok(steel.averagePowerGain < copper.averagePowerGain);
  });

  it("solves a ground-mounted vertical bonded to ground", async () => {
    const solve = await createSolver();
    const quarterWave = 299.792458 / 145.9 / 4;
    const result = solve(
      model({
        wires: [{ ...WIRE, to: [0, 0, quarterWave] }],
        sources: [{ ...SOURCE, segment: 1 }],
        ground: true,
        groundConnected: true,
      }),
    );
    const r = result.feeds[0].impedance.re;
    assert.ok(r > 25 && r < 50, `not a monopole's base resistance: ${r}`);
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

  it("refuses a ground connection with no ground", async () => {
    const solve = await createSolver();
    assert.throws(
      () => solve(model({ groundConnected: true })),
      /but there is no ground/,
    );
  });

  it("builds a structure step by step through a context", async () => {
    // The lower layer, for a model assembled conditionally or solved more
    // than once.
    const nec = await createContext();
    try {
      nec
        .wire(WIRE)
        // Translated rather than rotated: this wire lies on the z axis, so a
        // rotation about z would put the copy exactly on top of it.
        .transform({ moveM: [0.5, 0, 0], copies: 1, tagIncrement: 1 })
        .finishGeometry()
        .frequency(145.9)
        .excite(SOURCE);
      const result = nec.solvePattern(GRID);
      // Two wires now: the original and its rotated copy.
      assert.equal(result.currents.length, WIRE.segments * 2);
      assert.deepEqual(
        [...new Set(result.currents.map((c) => c.tag))].sort(),
        [1, 2],
      );
    } finally {
      nec.dispose();
    }
  });

  it("refuses to be used after disposal", async () => {
    const nec = await createContext();
    nec.dispose();
    assert.throws(() => nec.wire(WIRE), /disposed/);
  });
});
