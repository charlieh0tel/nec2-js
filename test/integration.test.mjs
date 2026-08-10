// The seam between the two packages: nec2c-deck writes a deck, nec2c-wasm
// solves it, nec2c-deck parses the result back. Neither package's own tests
// cover this, since each is deliberately independent of the other.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Nec2cError, runNec } from "nec2c-wasm";
import { buildDeck, parseOutput } from "nec2c-deck";

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

describe("nec2c-deck + nec2c-wasm", () => {
  it("solves a dipole and parses a plausible feedpoint impedance", async () => {
    const deck = buildDeck(["dipole"], [WIRE], [SOURCE], false, 145.9, GRID);
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

  it("reports a deck nec2c cannot parse", async () => {
    await assert.rejects(() => runNec("total garbage not a deck\n"), (e) => {
      assert.ok(e instanceof Nec2cError);
      assert.notEqual(e.exitCode, 0);
      // nec2c writes its complaint to the output file, not to stderr.
      assert.match(e.output, /ERROR/);
      return true;
    });
  });
});
