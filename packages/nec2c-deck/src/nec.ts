// Emit NEC-2 decks and parse nec2c output. Port of the pure parts of
// the retired Python nec.py.
//
// The subprocess execution (run_nec) is intentionally not ported. A NecRunner
// abstraction is exported instead, for later wiring to a WebAssembly build of
// nec2c.

// One straight NEC wire (GW card).
//   tag: NEC tag number.
//   segments: number of NEC segments along the wire.
//   x1, y1, z1: first endpoint, meters.
//   x2, y2, z2: second endpoint, meters.
//   radiusM: conductor radius, meters.
export interface Wire {
  tag: number;
  segments: number;
  x1: number;
  y1: number;
  z1: number;
  x2: number;
  y2: number;
  z2: number;
  radiusM: number;
}

// RP card option code that reproduces the normal-mode power-gain pattern with
// the polarization/axial-ratio columns nec2c prints by default.
export const RP_OPTION_CODE = 1000;

// Runs a NEC-2 deck and returns the raw text output. Implemented elsewhere
// (WASM in the browser); the engine only formats decks and parses output.
export type NecRunner = (deck: string) => Promise<string>;

// A voltage source (EX card) on one segment.
//   tag: tag of the wire carrying the source segment.
//   segment: 1-based segment number.
//   vReal, vImag: complex applied voltage.
export interface Source {
  tag: number;
  segment: number;
  vReal: number;
  vImag: number;
}

// A TL card: an ideal transmission line joining two segments.
//   tag1, segment1: first port (wire tag and 1-based segment).
//   tag2, segment2: second port.
//   z0Ohm: characteristic impedance; a negative value models a crossed
//     (polarity-reversed) connection, which flips the handedness.
//   lengthM: line length. nec2c treats it as electrical length at the
//     free-space wavelength, so length = wavelength / 4 gives a 90 deg line
//     regardless of any real coax velocity factor.
export interface TransmissionLine {
  tag1: number;
  segment1: number;
  tag2: number;
  segment2: number;
  z0Ohm: number;
  lengthM: number;
}

// RP-card sampling grid over the upper hemisphere. Angles are in degrees; theta
// is measured from zenith.
export interface RadiationGrid {
  ntheta: number;
  nphi: number;
  theta0: number;
  phi0: number;
  dtheta: number;
  dphi: number;
}

// Per-source result parsed from ANTENNA INPUT PARAMETERS.
export interface SourceResult {
  tag: number;
  segment: number;
  zReal: number;
  zImag: number;
  iReal: number;
  iImag: number;
}

export function sourceCurrentPhaseDeg(source: SourceResult): number {
  return (Math.atan2(source.iImag, source.iReal) * 180.0) / Math.PI;
}

// One segment's current, parsed from the CURRENTS AND LOCATION block.
export interface SegmentCurrent {
  tag: number;
  segment: number;
  iReal: number;
  iImag: number;
}

export function segmentMagnitude(current: SegmentCurrent): number {
  return Math.hypot(current.iReal, current.iImag);
}

export function segmentPhaseDeg(current: SegmentCurrent): number {
  return (Math.atan2(current.iImag, current.iReal) * 180.0) / Math.PI;
}

// One direction parsed from RADIATION PATTERNS.
//   axialRatio: NEC axial ratio: minor/major axis, 0 (linear) .. 1 (circular).
export interface PatternPoint {
  thetaDeg: number;
  phiDeg: number;
  totalGainDb: number;
  axialRatio: number;
  sense: string;
}

// A complex value (feed current).
export interface Complex {
  re: number;
  im: number;
}

export interface NecResult {
  sources: SourceResult[];
  pattern: PatternPoint[];
  currents: SegmentCurrent[];
}

// Current on the (1-segment) feed wire with this tag, 0 if absent.
export function feedCurrent(result: NecResult, tag: number): Complex {
  for (const c of result.currents) {
    if (c.tag === tag) {
      return { re: c.iReal, im: c.iImag };
    }
  }
  return { re: 0, im: 0 };
}

// NEC card fields are fixed-point text, so a value has to survive being
// written with a fixed number of decimals. Six decimals in metres is 1 um: a
// smaller dimension would be written as 0.000000, and a zero GW radius means
// something else entirely to NEC (a tapered wire expecting a GC card), so
// nec2c would reject the deck with an error naming neither the wire nor the
// field. toFixed also switches to exponential notation at 1e21, which no NEC
// card reader accepts.
const F6_SMALLEST = 1e-6;
const FIXED_NOTATION_LIMIT = 1e21;

function checkFixed(x: number, field: string, smallest: number): void {
  if (!Number.isFinite(x)) {
    throw new Error(`${field} must be a finite number, got ${x}`);
  }
  if (Math.abs(x) >= FIXED_NOTATION_LIMIT) {
    throw new Error(`${field} is too large to write as a NEC card field: ${x}`);
  }
  if (x !== 0 && Math.abs(x) < smallest) {
    throw new Error(
      `${field} would be written as zero (${x}); NEC card fields carry ` +
        `${smallest} resolution, and a zero radius or coordinate changes the ` +
        "meaning of the card",
    );
  }
}

function f6(x: number, field: string): string {
  checkFixed(x, field, F6_SMALLEST);
  return x.toFixed(6);
}

function f3any(x: number, field: string): string {
  checkFixed(x, field, 0);
  return x.toFixed(3);
}

// For fields where rounding to zero is harmless because zero is a normal
// value, not a change of meaning.
function f6any(x: number, field: string): string {
  checkFixed(x, field, 0);
  return x.toFixed(6);
}

// A comment card is one line. A newline in the text would end the card and let
// whatever followed be read as a card of its own, so text that cannot be
// carried faithfully is rejected rather than quietly reshaped. NEC reads 80
// columns; "CM " takes three.
const COMMENT_COLUMNS = 77;

function comment(text: string): string {
  if (/[\r\n]/.test(text)) {
    throw new Error(
      `comment lines cannot contain newlines: ${JSON.stringify(text)}`,
    );
  }
  if (text.length > COMMENT_COLUMNS) {
    throw new Error(
      `comment is ${text.length} characters; NEC reads ${COMMENT_COLUMNS}: ` +
        JSON.stringify(text),
    );
  }
  return text;
}

// Tags and segment counts index NEC's own tables; a fractional or negative one
// silently becomes a different card.
function checkIndex(x: number, field: string): number {
  if (!Number.isInteger(x) || x < 0) {
    throw new Error(`${field} must be a non-negative integer, got ${x}`);
  }
  return x;
}

// Render a complete NEC-2 deck as text.
export function buildDeck(
  commentLines: string[],
  wires: Wire[],
  sources: Source[],
  ground: boolean,
  freqMhz: number,
  grid: RadiationGrid,
  transmissionLines: TransmissionLine[] = [],
): string {
  const lines: string[] = commentLines.map((c) => `CM ${comment(c)}`);
  lines.push("CE");
  for (const w of wires) {
    const at = (field: string) => `wire ${w.tag} ${field}`;
    lines.push(
      `GW ${checkIndex(w.tag, "wire tag")} ` +
        `${checkIndex(w.segments, at("segment count"))} ` +
        `${f6(w.x1, at("x1"))} ${f6(w.y1, at("y1"))} ${f6(w.z1, at("z1"))} ` +
        `${f6(w.x2, at("x2"))} ${f6(w.y2, at("y2"))} ${f6(w.z2, at("z2"))} ` +
        `${f6(w.radiusM, at("radius"))}`,
    );
  }
  // GE flag -1: ground present but no wires connect to it (loops float above the
  // reflector); 0: free space.
  lines.push(`GE ${ground ? -1 : 0}`);
  if (ground) {
    // Perfect conducting ground plane approximates a solid metal reflector.
    lines.push("GN 1");
  }
  lines.push("EK");
  for (const t of transmissionLines) {
    lines.push(
      `TL ${checkIndex(t.tag1, "line tag1")} ` +
        `${checkIndex(t.segment1, "line segment1")} ` +
        `${checkIndex(t.tag2, "line tag2")} ` +
        `${checkIndex(t.segment2, "line segment2")} ` +
        // A negative Z0 is meaningful here: it models a crossed connection.
        `${f6(t.z0Ohm, "line impedance")} ${f6(t.lengthM, "line length")}`,
    );
  }
  for (const s of sources) {
    lines.push(
      `EX 0 ${checkIndex(s.tag, "source tag")} ` +
        `${checkIndex(s.segment, "source segment")} 0 ` +
        // A zero voltage component is ordinary (a purely real or imaginary
        // drive), so these are not held to the smallest-magnitude rule.
        `${f6any(s.vReal, "source voltage (real)")} ` +
        `${f6any(s.vImag, "source voltage (imaginary)")}`,
    );
  }
  lines.push(`FR 0 1 0 0 ${f6(freqMhz, "frequency")} 0`);
  lines.push(
    `RP 0 ${checkIndex(grid.ntheta, "grid ntheta")} ` +
      `${checkIndex(grid.nphi, "grid nphi")} ${RP_OPTION_CODE} ` +
      // Zero angles and steps are ordinary: a single cut has no step.
      `${f3any(grid.theta0, "grid theta0")} ${f3any(grid.phi0, "grid phi0")} ` +
      `${f3any(grid.dtheta, "grid dtheta")} ${f3any(grid.dphi, "grid dphi")}`,
  );
  lines.push("EN");
  return `${lines.join("\n")}\n`;
}

// Split a line into whitespace-delimited tokens, matching Python str.split().
function tokenize(line: string): string[] {
  const trimmed = line.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

// Whether a token parses as a float, matching Python float() acceptance
// (including inf/nan and scientific notation, but not hex or empty strings).
function isFloat(token: string): boolean {
  const trimmed = token.trim();
  // Hex is excluded deliberately: Number("0x64") is 100, but the tag and
  // segment fields go through parseInt(_, 10), which reads it as 0. Accepting
  // a token one way and reading it another is how a tag silently changes.
  if (trimmed === "" || /^[+-]?0[xXbBoO]/.test(trimmed)) {
    return false;
  }
  if (/^[+-]?(inf|infinity|nan)$/i.test(trimmed)) {
    return true;
  }
  return !Number.isNaN(Number(trimmed));
}

// Read a numeric field, refusing the non-finite values nec2c prints when a
// solve diverges. Returning NaN would propagate silently through hypot and
// atan2 and surface much later as an unexplained result.
function finite(token: string | undefined, field: string): number {
  const value = Number(token);
  if (!Number.isFinite(value)) {
    throw new Error(
      `nec2c reported a non-finite ${field}: ${JSON.stringify(token)}`,
    );
  }
  return value;
}

// Parse the ANTENNA INPUT PARAMETERS data rows.
// Columns: tag seg V_re V_im I_re I_im Z_re Z_im Y_re Y_im power.
function parseSources(lines: string[], start: number): SourceResult[] {
  const results: SourceResult[] = [];
  let seenData = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const tokens = tokenize(line);
    const t0 = tokens[0];
    const looksLikeData = tokens.length >= 11 && t0 !== undefined && isFloat(t0);
    if (!looksLikeData) {
      // A row that fails to parse *inside* the block would otherwise truncate
      // the list and hand back a short but well-formed result, losing feed
      // points without a word. Ending the section is only valid before the
      // data starts (the column headers) or after it.
      if (seenData && t0 !== undefined && isFloat(t0)) {
        throw new Error(
          `malformed ANTENNA INPUT PARAMETERS row: ${JSON.stringify(line)}`,
        );
      }
      if (seenData) {
        break;
      }
      continue;
    }
    seenData = true;
    results.push({
      tag: Number.parseInt(t0, 10),
      segment: Number.parseInt(tokens[1] ?? "", 10),
      iReal: finite(tokens[4], "source current (real)"),
      iImag: finite(tokens[5], "source current (imaginary)"),
      zReal: finite(tokens[6], "source impedance (real)"),
      zImag: finite(tokens[7], "source impedance (imaginary)"),
    });
  }
  return results;
}

// Reported for a direction where nec2c printed no polarization sense: the
// field is too small to have one (a pattern null), so neither the sense nor
// the axial ratio on that row is a measurement of anything.
export const SENSE_UNDEFINED = "UNDEFINED";

// Parse RADIATION PATTERNS data rows.
// Layout: theta phi vert horiz total axial tilt [sense] e_theta_mag
// e_theta_phase e_phi_mag e_phi_phase. The textual sense column is blank at
// pattern nulls; see SENSE_UNDEFINED.
function parsePattern(lines: string[], start: number): PatternPoint[] {
  const points: PatternPoint[] = [];
  let seenData = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const tokens = tokenize(line);
    const t0 = tokens[0];
    const t1 = tokens[1];
    const t7 = tokens[7];
    if (
      tokens.length >= 8 &&
      t0 !== undefined &&
      t1 !== undefined &&
      isFloat(t0) &&
      isFloat(t1)
    ) {
      // nec2c blanks the sense column when both field components are ~0
      // (radiation.c: ethm2 <= 1e-20 && ephm2 <= 1e-20) -- a pattern null,
      // which can occur at any angle. There is no polarization to report
      // there, so say so rather than claiming a linear measurement.
      const sense =
        t7 !== undefined && isFloat(t7) ? SENSE_UNDEFINED : (t7 ?? SENSE_UNDEFINED);
      points.push({
        thetaDeg: finite(t0, "pattern theta"),
        phiDeg: finite(t1, "pattern phi"),
        totalGainDb: finite(tokens[4], "pattern total gain"),
        axialRatio: finite(tokens[5], "pattern axial ratio"),
        sense,
      });
      seenData = true;
    } else if (seenData) {
      break;
    }
  }
  return points;
}

// Parse the CURRENTS AND LOCATION data rows.
// Columns: seg tag X Y Z length I_re I_im I_mag I_phase (10 fields).
function parseCurrents(lines: string[], start: number): SegmentCurrent[] {
  const results: SegmentCurrent[] = [];
  let seenData = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const tokens = tokenize(line);
    const t0 = tokens[0];
    const t6 = tokens[6];
    const t7 = tokens[7];
    if (
      tokens.length >= 10 &&
      t0 !== undefined &&
      t6 !== undefined &&
      t7 !== undefined &&
      isFloat(t0) &&
      isFloat(t6) &&
      isFloat(t7)
    ) {
      results.push({
        tag: Number.parseInt(tokens[1] ?? "", 10),
        segment: Number.parseInt(t0, 10),
        iReal: finite(t6, "segment current (real)"),
        iImag: finite(t7, "segment current (imaginary)"),
      });
      seenData = true;
    } else if (seenData) {
      break;
    }
  }
  return results;
}

// A section title is centered and fenced with dashes:
//     --------- ANTENNA INPUT PARAMETERS ---------
// Matching the fenced form rather than the bare words matters: nec2c echoes CM
// comment cards verbatim into its COMMENTS block, so a deck whose comment
// mentions a section name would otherwise be mistaken for that section.
function sectionTitle(line: string, title: string): boolean {
  return new RegExp(`^\\s*-+\\s*${title}\\s*-+\\s*$`).test(line);
}

// Parse nec2c output text into an NecResult.
//
// One deck, one set of results. nec2c emits a full set of sections per
// frequency step and per RP card, and this shape has nowhere to record which
// frequency a row belongs to, so rather than silently keeping one set and
// attributing it to the whole run, repeats are rejected. Run one frequency per
// deck (buildDeck emits FR 0 1) and combine the results yourself.
export function parseOutput(text: string): NecResult {
  // Match Python str.splitlines(): split on any newline flavour.
  const lines = text.split(/\r\n|\r|\n/);
  const starts = {
    "ANTENNA INPUT PARAMETERS": [] as number[],
    "CURRENTS AND LOCATION": [] as number[],
    "RADIATION PATTERNS": [] as number[],
  };
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line === undefined) {
      continue;
    }
    for (const title of Object.keys(starts) as (keyof typeof starts)[]) {
      if (sectionTitle(line, title)) {
        starts[title].push(idx);
      }
    }
  }

  for (const [title, found] of Object.entries(starts)) {
    if (found.length > 1) {
      throw new Error(
        `nec2c output has ${found.length} ${title} sections; ` +
          "parseOutput handles one set of results per deck. Sweep by running " +
          "one frequency per deck.",
      );
    }
  }

  // Each parser scans forward for its first data-shaped row, so it is handed
  // the title line rather than a hardcoded header length. The headers differ in
  // length between sections and grow extra lines for some RP modes, so an
  // offset would be both wrong and fragile.
  const at = (title: keyof typeof starts) => starts[title][0];
  const sourceStart = at("ANTENNA INPUT PARAMETERS");
  const currentStart = at("CURRENTS AND LOCATION");
  const patternStart = at("RADIATION PATTERNS");

  return {
    sources: sourceStart === undefined ? [] : parseSources(lines, sourceStart),
    currents:
      currentStart === undefined ? [] : parseCurrents(lines, currentStart),
    pattern: patternStart === undefined ? [] : parsePattern(lines, patternStart),
  };
}
