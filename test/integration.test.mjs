// The seam between the two packages: nec2c-deck writes a deck, nec2c-wasm
// solves it, nec2c-deck parses the result back. Neither package's own tests
// cover this, since each is deliberately independent of the other.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDeck, parseOutput } from "nec2c-deck";
import { Nec2cError, runNec } from "nec2c-wasm";

// A 1 m vertical wire at 145.9 MHz is a touch over half a wavelength, so it
// should land near a dipole's 73 ohm and read slightly inductive.
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
const GRID = { ntheta: 3, nphi: 1, theta0: 0, phi0: 0, dtheta: 30, dphi: 0 };

// A quarter-wave vertical standing on the ground, which only works as a model
// if the deck bonds it to the ground plane. Free-space wavelength at 145.9 MHz
// is 2.055 m.
const QUARTER_WAVE_M = 299.792458 / 145.9 / 4;
const VERTICAL = {
  tag: 1,
  segments: 9,
  x1: 0,
  y1: 0,
  z1: 0,
  x2: 0,
  y2: 0,
  z2: QUARTER_WAVE_M,
  radiusM: 0.001,
};

const solve = (options) =>
  runNec(
    buildDeck({
      comments: ["t"],
      wires: [WIRE],
      sources: [SOURCE],
      ground: false,
      freqMhz: 145.9,
      grid: GRID,
      ...options,
    }),
  ).then(parseOutput);

describe("nec2c-deck + nec2c-wasm", () => {
  it("solves a dipole and parses a plausible feedpoint impedance", async () => {
    const deck = buildDeck({
      comments: ["dipole"],
      wires: [WIRE],
      sources: [SOURCE],
      ground: false,
      freqMhz: 145.9,
      grid: GRID,
    });
    const result = parseOutput(await runNec(deck));

    assert.equal(result.sources.length, 1);
    assert.equal(result.pattern.length, 3);

    const z = result.sources[0];
    assert.ok(
      z.zReal > 60 && z.zReal < 90,
      `feedpoint resistance ${z.zReal} outside the dipole range`,
    );
    assert.ok(z.zImag > 0, "a slightly long dipole should be inductive");
  });

  it("feeds a ground-mounted vertical against the ground plane", async () => {
    // Without GE 1 the base segment floats and the solve is meaningless. A
    // quarter wave over perfect ground is a half dipole: about 36 ohms.
    const result = await solve({
      wires: [VERTICAL],
      sources: [{ tag: 1, segment: 1, vReal: 1, vImag: 0 }],
      ground: true,
      groundConnected: true,
    });
    const z = result.sources[0];
    assert.ok(
      z.zReal > 25 && z.zReal < 50,
      `base resistance ${z.zReal} is not a quarter-wave monopole's`,
    );
  });

  it("solves a radial ground screen under a vertical", async () => {
    // Exercises the GN 0 + radials combination end to end; nec2c stops outright
    // if the card is malformed or paired with the wrong ground type.
    const result = await solve({
      wires: [VERTICAL],
      sources: [{ tag: 1, segment: 1, vReal: 1, vImag: 0 }],
      ground: {
        epsR: 13,
        sigmaSm: 0.005,
        radials: { count: 32, screenRadiusM: 5, wireRadiusM: 0.0008 },
      },
      groundConnected: true,
    });
    assert.equal(result.sources.length, 1);
    assert.ok(result.sources[0].zReal > 0, "expected a solved feedpoint");
  });

  it("adds a lumped impedance load at the feed", async () => {
    // LD type 4 puts a fixed R + jX in series with the segment, so a 100 ohm
    // resistor should show up almost entirely in the feedpoint resistance.
    const bare = await solve({});
    const loaded = await solve({
      loads: [
        {
          kind: "impedance",
          tag: 1,
          fromSegment: 5,
          resistanceOhm: 100,
          reactanceOhm: 0,
        },
      ],
    });
    const added = loaded.sources[0].zReal - bare.sources[0].zReal;
    assert.ok(
      Math.abs(added - 100) < 5,
      `a 100 ohm load moved the feed resistance by ${added}`,
    );
  });

  it("makes a wire lossy with a conductivity load", async () => {
    // The card that turns a lossless model into a real one. Steel is poor
    // enough that the loss is unmistakable in the feedpoint resistance.
    const copper = await solve({
      loads: [{ kind: "conductivity", tag: 1, sigmaSm: 5.8e7 }],
    });
    const steel = await solve({
      loads: [{ kind: "conductivity", tag: 1, sigmaSm: 1.0e6 }],
    });
    assert.ok(
      steel.sources[0].zReal > copper.sources[0].zReal,
      `steel (${steel.sources[0].zReal}) should read more resistive than copper (${copper.sources[0].zReal})`,
    );
  });

  it("reports the efficiency a conductivity load costs", async () => {
    // The pairing that makes both cards worth having: LD makes the model
    // lossy, and the power budget is where that loss becomes a number.
    const lossless = await solve({});
    assert.ok(lossless.power, "expected a power budget");
    assert.ok(
      lossless.power.efficiencyPercent > 99.9,
      `a lossless model should be ~100% efficient, got ${lossless.power.efficiencyPercent}`,
    );
    assert.equal(lossless.power.structureLossW, 0);

    const steel = await solve({
      loads: [{ kind: "conductivity", tag: 1, sigmaSm: 1.0e6 }],
    });
    assert.ok(steel.power.efficiencyPercent < 99.9, "steel should cost gain");
    assert.ok(steel.power.structureLossW > 0, "steel should burn power");
    // The budget has to add up: input = radiated + structure + network loss.
    // nec2c prints each term with %11.4E, five significant digits, so three
    // summed terms can miss the input by a few parts per million of it. The
    // tolerance is that printing precision, not physics.
    const { inputW, radiatedW, structureLossW, networkLossW } = steel.power;
    const residualW = Math.abs(
      inputW - (radiatedW + structureLossW + networkLossW),
    );
    assert.ok(
      residualW < inputW * 1e-3,
      `power budget does not balance: ${residualW} W adrift of ${inputW} W`,
    );
  });

  it("replicates a wire with a GM transform", async () => {
    // One GW plus a GM asking for three more copies is a four-wire structure,
    // so nec2c should report four wires' worth of segments.
    const one = await solve({});
    const four = await solve({
      transforms: [{ copies: 3, tagIncrement: 1, moveXM: 0.5 }],
    });
    assert.equal(four.currents.length, one.currents.length * 4);
    // Each copy carries the incremented tag, which is what makes it
    // addressable by a later card.
    assert.deepEqual(
      [...new Set(four.currents.map((c) => c.tag))].sort((a, b) => a - b),
      [1, 2, 3, 4],
    );
  });

  it("reports a deck nec2c cannot parse", async () => {
    await assert.rejects(
      () => runNec("total garbage not a deck\n"),
      (e) => {
        assert.ok(e instanceof Nec2cError);
        assert.notEqual(e.exitCode, 0);
        // nec2c writes its complaint to the output file, not to stderr.
        assert.match(e.output, /ERROR/);
        return true;
      },
    );
  });
});
