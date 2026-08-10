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
  { tag: 1, segments: 9, x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 1, radiusM: 0.001 },
  { tag: 2, segments: 9, x1: 0, y1: 0, z1: 0, x2: 0, y2: 1, z2: 0, radiusM: 0.001 },
];
const GRID = { ntheta: 9, nphi: 7, theta0: 0, phi0: 0, dtheta: 10, dphi: 15 };

const countOccurrences = (haystack, needle) =>
  haystack.split(needle).length - 1;

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

  it("treats a missing polarization sense as LINEAR", () => {
    const result = parseOutput(SAMPLE_OUTPUT);
    assert.equal(result.pattern.length, 3);
    // Exact zenith: polarization is undefined, so nec2c omits the column.
    assert.equal(result.pattern[0].sense, "LINEAR");
    assert.ok(Math.abs(result.pattern[0].axialRatio - 0.98) < 1e-9);
    assert.equal(result.pattern[1].sense, "RIGHT");
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

  it("returns empty sections for text with no results", () => {
    const result = parseOutput("nothing to see here\n");
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.pattern, []);
    assert.deepEqual(result.currents, []);
  });
});

describe("buildDeck", () => {
  it("emits the expected cards over a ground plane", () => {
    const sources = [{ tag: 1, segment: 5, vReal: 1, vImag: 0 }];
    const deck = buildDeck(["test"], WIRES, sources, true, 145.9, GRID);
    assert.ok(deck.startsWith("CM test"));
    assert.ok(deck.includes("GN 1"));
    // -1: ground present, but no wire connects to it.
    assert.ok(deck.includes("GE -1"));
    assert.equal(countOccurrences(deck, "\nGW "), 2);
    assert.equal(countOccurrences(deck, "\nEX "), 1);
    assert.ok(deck.trimEnd().endsWith("EN"));
  });

  it("omits ground cards in free space", () => {
    const sources = [{ tag: 1, segment: 5, vReal: 1, vImag: 0 }];
    const deck = buildDeck(["t"], WIRES, sources, false, 145.9, GRID);
    assert.ok(deck.includes("GE 0"));
    assert.ok(!deck.includes("GN"));
  });

  it("formats geometry to six decimals", () => {
    const deck = buildDeck(["t"], WIRES, [], false, 145.9, GRID);
    assert.ok(
      deck.includes(
        "GW 1 9 0.000000 0.000000 0.000000 0.000000 0.000000 1.000000 0.001000",
      ),
      "GW card must use fixed 6-decimal formatting",
    );
  });

  it("emits transmission lines when given them", () => {
    const lines = [
      { tag1: 1, segment1: 5, tag2: 2, segment2: 5, z0Ohm: -93, lengthM: 0.5 },
    ];
    const deck = buildDeck(["t"], WIRES, [], false, 145.9, GRID, lines);
    // A negative Z0 models a crossed connection and must survive formatting.
    assert.ok(deck.includes("TL 1 5 2 5 -93.000000 0.500000"));
  });
});
