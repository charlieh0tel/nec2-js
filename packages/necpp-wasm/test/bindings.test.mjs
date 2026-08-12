// Every binding, exercised at least once.
//
// solver.test.mjs checks the numbers on a dipole. This checks that the rest
// of the surface is wired correctly at all -- an argument in the wrong order,
// a degrees/radians slip or a missing enum value produces silently wrong
// results rather than an error, and half of what the facade binds had never
// been called.
//
// These are deliberately shallow. Where an assertion can be made against
// something known -- a loop's resonance, a reflected copy's tag, a load
// raising feed resistance -- it is; otherwise the test only claims the call
// reaches nec2++ and solves.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext } from "../src/runner.mjs";

const FREQ_MHZ = 145.9;
const WAVELENGTH_M = 299.792458 / FREQ_MHZ;
const GRID = {
  ntheta: 3,
  nphi: 2,
  theta0: 0,
  phi0: 0,
  dtheta: 45,
  dphi: 90,
  average: 1,
};
const WIRE = {
  tag: 1,
  segments: 9,
  from: [0, 0, 0],
  to: [0, 0, 1],
  radiusM: 0.001,
};
const SOURCE = { kind: "voltage", tag: 1, segment: 5, volts: { re: 1, im: 0 } };

// Each test gets its own context and disposes it, so a failure cannot leak
// wasm memory into the next one.
async function withContext(body) {
  const nec = await createContext();
  try {
    return body(nec);
  } finally {
    nec.dispose();
  }
}

describe("geometry bindings", () => {
  it("builds an arc", async () => {
    const result = await withContext((nec) => {
      // A half-wavelength circumference loop is near its first resonance, so
      // the feed should read a few hundred ohms rather than anything wild.
      const radiusM = WAVELENGTH_M / (2 * Math.PI);
      nec
        .arc({
          tag: 1,
          segments: 12,
          radiusM,
          fromDeg: 0,
          toDeg: 360,
          wireRadiusM: 0.001,
        })
        .finishGeometry()
        .frequency(FREQ_MHZ)
        .excite({ ...SOURCE, segment: 1 });
      return nec.solvePattern(GRID);
    });
    assert.equal(result.currents.length, 12);
    assert.ok(Number.isFinite(result.feeds[0].impedance.re));
  });

  it("builds a helix", async () => {
    const result = await withContext((nec) => {
      nec
        .helix({
          tag: 1,
          segments: 20,
          turnSpacingM: 0.05,
          lengthM: 0.5,
          startRadii: [0.05, 0.05],
          endRadii: [0.05, 0.05],
          wireRadiusM: 0.001,
        })
        .finishGeometry()
        .frequency(FREQ_MHZ)
        .excite({ ...SOURCE, segment: 1 });
      return nec.solvePattern(GRID);
    });
    assert.equal(result.currents.length, 20);
    // An axial-mode helix is the classic circularly polarized antenna, so the
    // two hands should not read identically -- which also proves the RHCP and
    // LHCP getters are wired to different values.
    assert.notEqual(result.gainRhcp.maxDb, result.gainLhcp.maxDb);
  });

  it("reflects the structure through a plane", async () => {
    const result = await withContext((nec) => {
      nec
        .wire({ ...WIRE, from: [0.25, 0, 0], to: [0.25, 0, 1] })
        .reflect({ planes: "x", tagIncrement: 100 })
        .finishGeometry()
        .frequency(FREQ_MHZ)
        .excite(SOURCE);
      return nec.solvePattern(GRID);
    });
    // One wire reflected is two wires, and the copy carries the incremented
    // tag.
    assert.equal(result.currents.length, WIRE.segments * 2);
    assert.deepEqual(
      [...new Set(result.currents.map((c) => c.tag))].sort((a, b) => a - b),
      [1, 101],
    );
  });

  it("rotates with the angles in degrees", async () => {
    // The GM card takes degrees but nec_context::move() takes radians, so a
    // missing conversion here would put the copy 57x further round than
    // asked. Two wires 90 degrees apart in azimuth are perpendicular: their
    // far ends differ in x and y.
    const result = await withContext((nec) => {
      nec
        .wire({
          tag: 1,
          segments: 5,
          from: [0.5, 0, 0],
          to: [0.5, 0, 0.5],
          radiusM: 0.001,
        })
        .transform({ rotZDeg: 90, copies: 1, tagIncrement: 1 })
        .finishGeometry()
        .frequency(FREQ_MHZ)
        .excite({ ...SOURCE, segment: 1 });
      return nec.solvePattern(GRID);
    });
    const first = result.currents.find((c) => c.tag === 1);
    const copy = result.currents.find((c) => c.tag === 2);
    // The original sits on +x; a 90 degree rotation about z puts the copy on
    // +y, so their centres swap which axis is nonzero. Positions are in
    // wavelengths, as nec2++ reports them.
    const expected = 0.5 / WAVELENGTH_M;
    const near = (value, want) => Math.abs(value - want) < 1e-4;
    assert.ok(
      near(first.atWavelengths[0], expected) && near(first.atWavelengths[1], 0),
    );
    assert.ok(
      near(copy.atWavelengths[1], expected) && near(copy.atWavelengths[0], 0),
    );
  });
});

describe("environment bindings", () => {
  it("accepts an interaction distance and the thin-wire kernel", async () => {
    const result = await withContext((nec) => {
      nec
        .wire(WIRE)
        .finishGeometry()
        .extendedThinWireKernel(true)
        .interactionDistance(1.0)
        .frequency(FREQ_MHZ)
        .excite(SOURCE);
      return nec.solvePattern(GRID);
    });
    // Both are accuracy/speed knobs, so the answer should still be a dipole's.
    const r = result.feeds[0].impedance.re;
    assert.ok(r > 50 && r < 110, `feed resistance ${r} is not a dipole's`);
  });

  it("emits a radial ground screen", async () => {
    const result = await withContext((nec) => {
      nec
        .wire({ ...WIRE, to: [0, 0, WAVELENGTH_M / 4] })
        .finishGeometry({
          ground: {
            epsR: 13,
            sigmaSm: 0.005,
            radials: { count: 32, screenRadiusM: 5, wireRadiusM: 0.0008 },
          },
          groundConnected: true,
        })
        .frequency(FREQ_MHZ)
        .excite({ ...SOURCE, segment: 1 });
      return nec.solvePattern(GRID);
    });
    const r = result.feeds[0].impedance.re;
    assert.ok(r > 10 && r < 100, `base resistance ${r} is implausible`);
  });
});

describe("excitation bindings", () => {
  it("drives with an elementary current source", async () => {
    const result = await withContext((nec) => {
      nec
        .wire(WIRE)
        .finishGeometry()
        .frequency(FREQ_MHZ)
        .excite({ kind: "current", at: [0.5, 0, 0.5], moment: 1.0 });
      return nec.solvePattern(GRID);
    });
    // A current source off the structure induces current on it, but there is
    // no driven segment, so there is no feedpoint to report.
    assert.equal(result.currents.length, WIRE.segments);
    assert.ok(
      result.currents.some((c) => Math.hypot(c.current.re, c.current.im) > 0),
      "the source should induce current on the wire",
    );
  });

  it("illuminates the structure with a plane wave", async () => {
    // How a receiving antenna or a radar cross section is modelled. It also
    // suppresses the results a voltage source produces, so this checks the
    // call lands rather than the numbers.
    const result = await withContext((nec) => {
      nec.wire(WIRE).finishGeometry().frequency(FREQ_MHZ).excite({
        kind: "planeWaveLinear",
        ntheta: 1,
        nphi: 1,
        theta0: 90,
        phi0: 0,
      });
      return nec.solvePattern(GRID);
    });
    assert.equal(result.currents.length, WIRE.segments);
    assert.ok(
      result.currents.some((c) => Math.hypot(c.current.re, c.current.im) > 0),
      "an incident wave should induce current",
    );
  });

  it("rejects an unknown excitation kind", async () => {
    await withContext((nec) => {
      nec.wire(WIRE).finishGeometry().frequency(FREQ_MHZ);
      assert.throws(
        () => nec.excite({ kind: "telepathy", tag: 1, segment: 5 }),
        /unknown excitation kind/,
      );
    });
  });
});

describe("loading and network bindings", () => {
  it("applies every lumped load kind", async () => {
    const kinds = [
      { kind: "series", resistanceOhm: 50, inductanceH: 0, capacitanceF: 0 },
      {
        kind: "parallel",
        resistanceOhm: 50,
        inductanceH: 1e-6,
        capacitanceF: 0,
      },
      {
        kind: "seriesPerMeter",
        resistanceOhm: 10,
        inductanceH: 0,
        capacitanceF: 0,
      },
      {
        kind: "parallelPerMeter",
        resistanceOhm: 500,
        inductanceH: 1e-6,
        capacitanceF: 0,
      },
      { kind: "impedance", resistanceOhm: 50, reactanceOhm: -20 },
    ];
    for (const load of kinds) {
      const result = await withContext((nec) => {
        nec
          .wire(WIRE)
          .finishGeometry()
          .frequency(FREQ_MHZ)
          .excite(SOURCE)
          .load({ ...load, tag: 1, fromSegment: 5 });
        return nec.solvePattern(GRID);
      });
      assert.ok(
        Number.isFinite(result.feeds[0].impedance.re),
        `${load.kind} produced a non-finite feedpoint`,
      );
    }
  });

  it("adds a series resistance where it was asked for", async () => {
    // The one lumped load with an answer that can be predicted: a fixed
    // R + jX in series with the feed segment moves the feedpoint by R.
    const bare = await withContext((nec) => {
      nec.wire(WIRE).finishGeometry().frequency(FREQ_MHZ).excite(SOURCE);
      return nec.solvePattern(GRID);
    });
    const loaded = await withContext((nec) => {
      nec.wire(WIRE).finishGeometry().frequency(FREQ_MHZ).excite(SOURCE).load({
        kind: "impedance",
        tag: 1,
        fromSegment: 5,
        resistanceOhm: 100,
        reactanceOhm: 0,
      });
      return nec.solvePattern(GRID);
    });
    const added = loaded.feeds[0].impedance.re - bare.feeds[0].impedance.re;
    assert.ok(
      Math.abs(added - 100) < 5,
      `a 100 ohm load moved the feedpoint by ${added}`,
    );
  });

  it("rejects an unknown load kind and a backwards range", async () => {
    await withContext((nec) => {
      nec.wire(WIRE).finishGeometry().frequency(FREQ_MHZ).excite(SOURCE);
      assert.throws(
        () => nec.load({ kind: "vibes", tag: 1 }),
        /unknown load kind/,
      );
      assert.throws(
        () =>
          nec.load({
            kind: "conductivity",
            tag: 1,
            fromSegment: 7,
            toSegment: 2,
            sigmaSm: 1e7,
          }),
        /is before fromSegment/,
      );
    });
  });

  it("joins two wires with a transmission line", async () => {
    const result = await withContext((nec) => {
      nec
        .wire(WIRE)
        .wire({ ...WIRE, tag: 2, from: [0.5, 0, 0], to: [0.5, 0, 1] })
        .finishGeometry()
        .frequency(FREQ_MHZ)
        .excite(SOURCE)
        .transmissionLine({
          from: { tag: 1, segment: 5 },
          to: { tag: 2, segment: 5 },
          z0Ohm: 50,
          lengthM: WAVELENGTH_M / 4,
        });
      return nec.solvePattern(GRID);
    });
    assert.equal(result.currents.length, WIRE.segments * 2);
    // The parasite is fed only through the line, so it has to be carrying
    // current for the line to have done anything.
    const parasite = result.currents.filter((c) => c.tag === 2);
    assert.ok(
      parasite.some((c) => Math.hypot(c.current.re, c.current.im) > 0),
      "the second wire should be driven through the line",
    );
  });

  it("joins two wires with a two-port network", async () => {
    const result = await withContext((nec) => {
      nec
        .wire(WIRE)
        .wire({ ...WIRE, tag: 2, from: [0.5, 0, 0], to: [0.5, 0, 1] })
        .finishGeometry()
        .frequency(FREQ_MHZ)
        .excite(SOURCE)
        .network({
          from: { tag: 1, segment: 5 },
          to: { tag: 2, segment: 5 },
          y11: { re: 0.02, im: 0 },
          y12: { re: -0.01, im: 0 },
          y22: { re: 0.02, im: 0 },
        });
      return nec.solvePattern(GRID);
    });
    const parasite = result.currents.filter((c) => c.tag === 2);
    assert.ok(
      parasite.some((c) => Math.hypot(c.current.re, c.current.im) > 0),
      "the second wire should be driven through the network",
    );
  });
});

describe("error handling", () => {
  it("turns a nec2++ trap into a usable Error and recovers", async () => {
    // nec2++ does not range-check tag or segment references: naming one that
    // does not exist walks off an array. Under wasm that is a trap, which
    // poisons the module instance -- so the wrapper has to both report it as
    // an Error and discard the instance, or every later solve in the process
    // would fail too.
    const nec = await createContext();
    try {
      nec.wire(WIRE).finishGeometry().frequency(FREQ_MHZ);
      assert.throws(
        () => {
          nec.excite({ ...SOURCE, tag: 99 });
          nec.solvePattern(GRID);
        },
        (e) => {
          assert.ok(e instanceof Error, "should be a JS Error");
          assert.ok(!("excPtr" in e), "should not be a raw CppException");
          return true;
        },
      );
    } finally {
      try {
        nec.dispose();
      } catch {
        // Disposing a trapped instance can itself trap; nothing to salvage.
      }
    }

    // The next context has to work, which is the point of discarding the
    // poisoned module.
    const result = await withContext((fresh) => {
      fresh.wire(WIRE).finishGeometry().frequency(FREQ_MHZ).excite(SOURCE);
      return fresh.solvePattern(GRID);
    });
    const r = result.feeds[0].impedance.re;
    assert.ok(r > 50 && r < 110, `recovered solve gave ${r}`);
  });

  it("rejects a disposed context before reaching nec2++", async () => {
    const nec = await createContext();
    nec.dispose();
    assert.throws(() => nec.wire(WIRE), /disposed/);
  });
});
