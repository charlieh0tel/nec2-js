// Unit tests for deck emission and nec2c output parsing.
//
// Two kinds of fixture: a hand-trimmed sample that exercises awkward columns
// (an exact-zenith row with no textual polarization sense), and a full nec2c
// run captured from fixtures/loop.nec so the parsers are checked against real
// output rather than only against a curated excerpt.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  TL_LENGTH_FROM_GEOMETRY,
  buildDeck,
  feedCurrent,
  parseOutput,
  segmentMagnitude,
  sourceCurrentPhaseDeg,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "fixtures", name), "utf8");

// Trimmed nec2c output covering two sources and a few pattern directions,
// including an exact-zenith row that omits the textual sense. The fixed
// columns must be preserved exactly.
const SAMPLE_OUTPUT = `
                        --------- ANTENNA INPUT PARAMETERS ---------
  TAG   SEG       VOLTAGE (VOLTS)         CURRENT (AMPS)         IMPEDANCE (OHMS)        ADMITTANCE (MHOS)     POWER
  No:   No:     REAL      IMAGINARY     REAL      IMAGINARY     REAL      IMAGINARY    REAL       IMAGINARY   (WATTS)
  100     1  1.0000E+00  0.0000E+00  5.0000E-03  5.0000E-03  1.0000E+02  -1.0000E+02  5.0E-03  5.0E-03  2.5E-03
  200     1  1.0000E+00  0.0000E+00  5.0000E-03 -5.0000E-03  1.0000E+02   1.0000E+02  5.0E-03 -5.0E-03  2.5E-03


                             ---------- RADIATION PATTERNS -----------

 ---- ANGLES -----     ----- POWER GAINS -----       ---- POLARIZATION ----   ---- E(THETA) ----    ----- E(PHI) ------
  THETA      PHI       VERTC    HORIZ    TOTAL       AXIAL      TILT  SENSE   MAGNITUDE    PHASE    MAGNITUDE     PHASE
 DEGREES   DEGREES        DB       DB       DB       RATIO   DEGREES            VOLTS/M   DEGREES     VOLTS/M   DEGREES
    0.00      0.00     2.00     2.00     5.00      0.9800      0.00         1.0E-01      0.00  1.0E-01     90.00
   30.00      0.00     1.00     1.00     3.00      0.8000     10.00 RIGHT   8.0E-02     12.00  6.0E-02     95.00
   60.00      0.00  -999.99  -999.99  -999.99      0.0000      0.00 LINEAR  0.0E+00      0.00  0.0E+00      0.00
`;

const WIRES = [
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
  {
    tag: 2,
    segments: 9,
    x1: 0,
    y1: 0,
    z1: 0,
    x2: 0,
    y2: 1,
    z2: 0,
    radiusM: 0.001,
  },
];
const GRID = { ntheta: 9, nphi: 7, theta0: 0, phi0: 0, dtheta: 10, dphi: 15 };

const countOccurrences = (haystack, needle) =>
  haystack.split(needle).length - 1;

// buildDeck takes one options object; every test here varies a field or two of
// the same working deck.
const deck = (overrides) =>
  buildDeck({
    comments: ["t"],
    wires: WIRES,
    sources: [],
    ground: false,
    freqMhz: 145.9,
    grid: GRID,
    ...overrides,
  });

describe("parseOutput", () => {
  it("reads source impedance and current phase", () => {
    const result = parseOutput(SAMPLE_OUTPUT);
    assert.equal(result.sources.length, 2);
    const [a, b] = result.sources;
    assert.equal(a.tag, 100);
    assert.equal(a.zReal, 100);
    assert.equal(a.zImag, -100);
    assert.ok(Math.abs(sourceCurrentPhaseDeg(a) - 45) < 1e-9);
    assert.ok(Math.abs(sourceCurrentPhaseDeg(b) + 45) < 1e-9);
  });

  it("reports a blank polarization sense as undefined", () => {
    const result = parseOutput(SAMPLE_OUTPUT);
    assert.equal(result.pattern.length, 3);
    // nec2c blanks the column at a pattern null, where there is no
    // polarization to report -- not a linear-polarization measurement.
    assert.equal(result.pattern[0].sense, "UNDEFINED");
    assert.equal(result.pattern[1].sense, "RIGHT");
    // A row nec2c did label LINEAR keeps that label.
    assert.equal(result.pattern[2].sense, "LINEAR");
  });

  it("does not blank the sense at zenith when the field is nonzero", () => {
    // The comment this replaces claimed the column is dropped at zenith. The
    // real fixture disproves it: theta=0 phi=0 reads RIGHT.
    const result = parseOutput(fixture("loop.out.txt"));
    const zenith = result.pattern.find(
      (p) => p.thetaDeg === 0 && p.phiDeg === 0,
    );
    assert.ok(zenith, "fixture should contain a zenith row");
    assert.notEqual(zenith.sense, "UNDEFINED");
  });

  it("reads all three sections of a real nec2c run", () => {
    const result = parseOutput(fixture("loop.out.txt"));
    assert.ok(result.sources.length >= 1, "expected at least one source");
    assert.ok(result.currents.length > 0, "expected segment currents");
    assert.ok(result.pattern.length > 0, "expected pattern points");
    // A driven antenna has nonzero current at its feed.
    assert.ok(segmentMagnitude(result.currents[0]) >= 0);
    const feed = feedCurrent(result, result.sources[0].tag);
    assert.ok(Math.hypot(feed.re, feed.im) > 0, "feed current must be nonzero");
  });

  it("returns zero from feedCurrent for an unknown tag", () => {
    const result = parseOutput(fixture("loop.out.txt"));
    assert.deepEqual(feedCurrent(result, 999999), { re: 0, im: 0 });
  });

  it("rejects output holding more than one set of results", () => {
    // nec2c emits a full set of sections per frequency step. Keeping one set
    // and attributing it to the whole run is the failure this guards against.
    assert.throws(
      () => parseOutput(SAMPLE_OUTPUT + SAMPLE_OUTPUT),
      /2 ANTENNA INPUT PARAMETERS sections/,
    );
  });

  it("rejects a malformed row rather than truncating the list", () => {
    // Dropping rows here would silently lose feed points from a multi-source
    // model and still return a well-formed result.
    const broken = SAMPLE_OUTPUT.replace(
      "  200     1  1.0000E+00  0.0000E+00  5.0000E-03 -5.0000E-03  1.0000E+02   1.0000E+02  5.0E-03 -5.0E-03  2.5E-03",
      "  200     1  1.0000E+00  0.0000E+00  5.0000E-03 -5.0000E-03",
    );
    assert.throws(() => parseOutput(broken), /malformed ANTENNA INPUT/);
  });

  it("is not fooled by a section name echoed from a comment card", () => {
    // nec2c copies CM cards verbatim into its COMMENTS block, so matching on
    // the bare words would pick up the comment instead of the real section.
    const withComment = `
                               ---------------- COMMENTS ----------------
                               RADIATION PATTERNS of a test antenna
${SAMPLE_OUTPUT}`;
    const result = parseOutput(withComment);
    assert.equal(result.pattern.length, 3);
    assert.equal(result.sources.length, 2);
  });

  it("rejects non-finite numbers from a diverged solve", () => {
    // %E prints NAN/INF when a solve diverges. Passing those through would
    // propagate silently through hypot and atan2.
    const diverged = SAMPLE_OUTPUT.replace(
      "1.0000E+02  -1.0000E+02",
      "NAN         NAN       ",
    );
    assert.throws(() => parseOutput(diverged), /non-finite source impedance/);
  });

  it("rejects a near-field run rather than reporting no radiation", () => {
    // RP 1 prints location and field columns under its own title. An empty
    // pattern would read as an antenna that radiates nothing.
    const nearField = `
                             ------- RADIATED FIELDS NEAR GROUND --------

    ------- LOCATION -------     --- E(THETA) ---     ---- E(PHI) ----
      RHO    PHI        Z           MAG    PHASE         MAG    PHASE
    0.0000   0.00     1.0000     1.0E-01    0.00     1.0E-01    90.00
`;
    assert.throws(() => parseOutput(nearField), /RADIATED FIELDS NEAR GROUND/);
  });

  it("returns empty sections for text with no results", () => {
    const result = parseOutput("nothing to see here\n");
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.pattern, []);
    assert.deepEqual(result.currents, []);
  });
});

describe("buildDeck", () => {
  it("emits the expected cards over a ground plane", () => {
    const text = deck({
      comments: ["test"],
      sources: [{ tag: 1, segment: 5, vReal: 1, vImag: 0 }],
      ground: true,
    });
    assert.ok(text.startsWith("CM test"));
    assert.ok(text.includes("GN 1"));
    // -1: ground present, but no wire connects to it.
    assert.ok(text.includes("GE -1"));
    assert.equal(countOccurrences(text, "\nGW "), 2);
    assert.equal(countOccurrences(text, "\nEX "), 1);
    assert.ok(text.trimEnd().endsWith("EN"));
  });

  it("emits a Sommerfeld GN card for real ground constants", () => {
    const text = deck({ ground: { epsR: 13, sigmaSm: 0.005 } });
    // Type 2 is Sommerfeld/Norton; the 0 after it is the radial-wire count,
    // which nec2c requires to be zero for this ground type.
    assert.ok(text.includes("GN 2 0 0 0 13.000000 0.005000"));
    assert.ok(text.includes("GE -1"));
  });

  it("emits a reflection-coefficient GN card when asked", () => {
    const text = deck({
      ground: { epsR: 13, sigmaSm: 0.005, method: "reflection" },
    });
    assert.ok(text.includes("GN 0 0 0 0 13.000000 0.005000"));
  });

  it("emits a radial ground screen", () => {
    const text = deck({
      ground: {
        epsR: 13,
        sigmaSm: 0.005,
        radials: { count: 32, screenRadiusM: 10, wireRadiusM: 0.0008 },
      },
    });
    // A screen forces the reflection-coefficient ground; the trailing floats
    // are the screen radius and the radial wire radius.
    assert.ok(
      text.includes("GN 0 32 0 0 13.000000 0.005000 10.000000 0.000800"),
    );
  });

  it("refuses a radial screen over Sommerfeld ground", () => {
    // nec2c stops with "RADIAL WIRE G.S. APPROXIMATION MAY NOT BE USED WITH
    // SOMMERFELD GROUND OPTION"; say so before writing the card.
    assert.throws(
      () =>
        deck({
          ground: {
            epsR: 13,
            sigmaSm: 0.005,
            method: "sommerfeld",
            radials: { count: 32, screenRadiusM: 10, wireRadiusM: 0.0008 },
          },
        }),
      /cannot be combined with the Sommerfeld ground/,
    );
  });

  it("bonds wires to ground with GE 1 when asked", () => {
    // A ground-mounted vertical fed against earth needs the connection; NEC
    // extends the current basis onto the image only for GE 1.
    const text = deck({ ground: true, groundConnected: true });
    assert.ok(text.includes("GE 1"));
  });

  it("refuses a ground connection in free space", () => {
    assert.throws(
      () => deck({ ground: false, groundConnected: true }),
      /but ground is false/,
    );
  });

  it("refuses ground constants that are not physical", () => {
    assert.throws(
      () => deck({ ground: { epsR: 0.5, sigmaSm: 0.005 } }),
      /cannot be below 1/,
    );
    assert.throws(
      () => deck({ ground: { epsR: 13, sigmaSm: -1 } }),
      /cannot be negative/,
    );
  });

  it("omits ground cards in free space", () => {
    const text = deck({
      sources: [{ tag: 1, segment: 5, vReal: 1, vImag: 0 }],
    });
    assert.ok(text.includes("GE 0"));
    assert.ok(!text.includes("GN"));
  });

  it("formats geometry to six decimals", () => {
    assert.ok(
      deck({}).includes(
        "GW 1 9 0.000000 0.000000 0.000000 0.000000 0.000000 1.000000 0.001000",
      ),
      "GW card must use fixed 6-decimal formatting",
    );
  });

  it("refuses a dimension that would be written as zero", () => {
    // A GW radius of 0 means a tapered wire expecting a GC card, so rounding
    // one away changes what the card means. nec2c would only say
    // "GEOMETRY DATA CARD ERROR".
    assert.throws(
      () => deck({ wires: [{ ...WIRES[0], radiusM: 5e-7 }] }),
      /would be written as zero/,
    );
  });

  it("allows a coordinate that rounds to zero", () => {
    // A radial rotated to 90 degrees lands on 3.4e-17, which is zero in every
    // sense that matters. Only a zero radius changes what the card means.
    const text = deck({
      wires: [{ ...WIRES[0], x2: 3.3971132970020115e-17 }],
    });
    assert.ok(text.includes("GW 1 9 0.000000 0.000000 0.000000 0.000000"));
  });

  it("refuses non-finite and out-of-range values", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => deck({ wires: [{ ...WIRES[0], z2: bad }] }),
        /must be a finite number/,
      );
    }
    // toFixed switches to exponential at 1e21, which no card reader accepts.
    assert.throws(
      () => deck({ wires: [{ ...WIRES[0], z2: 1e21 }] }),
      /too large/,
    );
  });

  it("refuses a fractional tag or segment count", () => {
    assert.throws(
      () => deck({ wires: [{ ...WIRES[0], segments: 9.5 }] }),
      /non-negative integer/,
    );
  });

  it("refuses a comment carrying a newline", () => {
    // Otherwise the text after the newline is read as a card of its own.
    assert.throws(
      () => deck({ comments: ["line1\nEN\nCM evil"] }),
      /cannot contain newlines/,
    );
  });

  it("allows zero where zero is a normal value", () => {
    // A purely real drive, and a single azimuth cut with no phi step.
    const text = deck({
      sources: [{ tag: 1, segment: 5, vReal: 1, vImag: 0 }],
      grid: { ntheta: 3, nphi: 1, theta0: 0, phi0: 0, dtheta: 30, dphi: 0 },
    });
    assert.ok(text.includes("EX 0 1 5 0 1.000000 0.000000"));
    assert.ok(text.includes("RP 0 3 1 1000 0.000 0.000 30.000 0.000"));
  });

  it("honours an RP option code", () => {
    // 1002 keeps the default axes but asks for directive rather than power
    // gain; parseOutput reads the same columns either way.
    const text = deck({ grid: { ...GRID, optionCode: 1002 } });
    assert.ok(text.includes("RP 0 9 7 1002 "));
  });

  it("emits transmission lines when given them", () => {
    const text = deck({
      transmissionLines: [
        {
          tag1: 1,
          segment1: 5,
          tag2: 2,
          segment2: 5,
          z0Ohm: -93,
          lengthM: 0.5,
        },
      ],
    });
    // A negative Z0 models a crossed connection and must survive formatting.
    assert.ok(text.includes("TL 1 5 2 5 -93.000000 0.500000"));
  });

  it("writes a zero TL length only for the explicit sentinel", () => {
    // Zero is the card's own "measure it from the geometry". A computed length
    // that rounds away must not turn into that silently.
    const line = { tag1: 1, segment1: 5, tag2: 2, segment2: 5, z0Ohm: 50 };
    const text = deck({
      transmissionLines: [{ ...line, lengthM: TL_LENGTH_FROM_GEOMETRY }],
    });
    assert.ok(text.includes("TL 1 5 2 5 50.000000 0.000000"));
    assert.throws(
      () => deck({ transmissionLines: [{ ...line, lengthM: 5e-7 }] }),
      /would be written as zero/,
    );
  });

  it("emits loads in exponential notation", () => {
    // 5 pF is 5e-12 farads. Fixed six-decimal notation would write it as zero,
    // and NEC reads a zero C as "no capacitor in this network" -- a load that
    // silently vanishes.
    const text = deck({
      loads: [
        {
          kind: "series",
          tag: 1,
          fromSegment: 3,
          resistanceOhm: 10,
          inductanceH: 0,
          capacitanceF: 5e-12,
        },
      ],
    });
    assert.ok(
      text.includes("LD 0 1 3 3 1.000000e+1 0.000000e+0 5.000000e-12"),
      `capacitance must keep its magnitude, got: ${text}`,
    );
  });

  it("emits each load kind with its own type code", () => {
    const kinds = {
      series: 0,
      parallel: 1,
      seriesPerMeter: 2,
      parallelPerMeter: 3,
    };
    for (const [kind, code] of Object.entries(kinds)) {
      const text = deck({
        loads: [
          {
            kind,
            tag: 1,
            resistanceOhm: 1,
            inductanceH: 1e-6,
            capacitanceF: 1e-12,
          },
        ],
      });
      assert.ok(
        text.includes(`LD ${code} 1 0 0 `),
        `${kind} should be ${code}`,
      );
    }
    const impedance = deck({
      loads: [
        { kind: "impedance", tag: 1, resistanceOhm: 50, reactanceOhm: -20 },
      ],
    });
    assert.ok(impedance.includes("LD 4 1 0 0 5.000000e+1 -2.000000e+1 0"));
    // Copper. This is the card that turns a lossless model into a real one.
    const wire = deck({
      loads: [{ kind: "conductivity", tag: 0, sigmaSm: 5.8e7 }],
    });
    assert.ok(wire.includes("LD 5 0 0 0 5.800000e+7 0 0"));
  });

  it("refuses a backwards or non-physical load", () => {
    assert.throws(
      () =>
        deck({
          loads: [
            {
              kind: "series",
              tag: 1,
              fromSegment: 5,
              toSegment: 2,
              resistanceOhm: 1,
              inductanceH: 0,
              capacitanceF: 0,
            },
          ],
        }),
      /is before fromSegment/,
    );
    assert.throws(
      () => deck({ loads: [{ kind: "conductivity", tag: 1, sigmaSm: 0 }] }),
      /must be positive/,
    );
  });

  it("emits GM transforms after the wires and before GE", () => {
    const text = deck({
      transforms: [{ rotZDeg: 45, copies: 7, tagIncrement: 10 }],
    });
    assert.ok(
      text.includes("GM 10 7 0.000 0.000 45.000 0.000000 0.000000 0.000000 0"),
    );
    // GM acts on the structure built so far, so it has to follow every GW and
    // precede the card that ends the geometry.
    assert.ok(text.indexOf("\nGM ") > text.lastIndexOf("\nGW "));
    assert.ok(text.indexOf("\nGM ") < text.indexOf("\nGE "));
  });

  it("defaults every GM field to a no-op", () => {
    const text = deck({ transforms: [{ moveZM: 2 }] });
    assert.ok(
      text.includes("GM 0 0 0.000 0.000 0.000 0.000000 0.000000 2.000000 0"),
    );
  });
});
