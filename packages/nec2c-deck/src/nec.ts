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

function f6(x: number): string {
  return x.toFixed(6);
}

function f3(x: number): string {
  return x.toFixed(3);
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
  const lines: string[] = commentLines.map((c) => `CM ${c}`);
  lines.push("CE");
  for (const w of wires) {
    lines.push(
      `GW ${w.tag} ${w.segments} ` +
        `${f6(w.x1)} ${f6(w.y1)} ${f6(w.z1)} ` +
        `${f6(w.x2)} ${f6(w.y2)} ${f6(w.z2)} ${f6(w.radiusM)}`,
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
      `TL ${t.tag1} ${t.segment1} ${t.tag2} ${t.segment2} ` +
        `${f6(t.z0Ohm)} ${f6(t.lengthM)}`,
    );
  }
  for (const s of sources) {
    lines.push(`EX 0 ${s.tag} ${s.segment} 0 ${f6(s.vReal)} ${f6(s.vImag)}`);
  }
  lines.push(`FR 0 1 0 0 ${f6(freqMhz)} 0`);
  lines.push(
    `RP 0 ${grid.ntheta} ${grid.nphi} ${RP_OPTION_CODE} ` +
      `${f3(grid.theta0)} ${f3(grid.phi0)} ${f3(grid.dtheta)} ${f3(grid.dphi)}`,
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
  if (trimmed === "") {
    return false;
  }
  if (/^[+-]?(inf|infinity|nan)$/i.test(trimmed)) {
    return true;
  }
  const value = Number(trimmed);
  return !Number.isNaN(value) && trimmed !== "";
}

// Parse the ANTENNA INPUT PARAMETERS data rows.
// Columns: tag seg V_re V_im I_re I_im Z_re Z_im Y_re Y_im power.
function parseSources(lines: string[], start: number): SourceResult[] {
  const results: SourceResult[] = [];
  // Skip the two-line column header following the section title.
  let i = start + 3;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    const tokens = tokenize(line);
    const t0 = tokens[0];
    if (tokens.length < 11 || t0 === undefined || !isFloat(t0)) {
      break;
    }
    results.push({
      tag: Number.parseInt(t0, 10),
      segment: Number.parseInt(tokens[1] ?? "", 10),
      iReal: Number(tokens[4]),
      iImag: Number(tokens[5]),
      zReal: Number(tokens[6]),
      zImag: Number(tokens[7]),
    });
    i += 1;
  }
  return results;
}

// Parse RADIATION PATTERNS data rows.
// Layout: theta phi vert horiz total axial tilt [sense] e_theta_mag
// e_theta_phase e_phi_mag e_phi_phase. The textual sense column is absent at
// directions where polarization is undefined (e.g. exact zenith).
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
      const sense = t7 !== undefined && isFloat(t7) ? "LINEAR" : (t7 ?? "LINEAR");
      points.push({
        thetaDeg: Number(t0),
        phiDeg: Number(t1),
        totalGainDb: Number(tokens[4]),
        axialRatio: Number(tokens[5]),
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
        iReal: Number(t6),
        iImag: Number(t7),
      });
      seenData = true;
    } else if (seenData) {
      break;
    }
  }
  return results;
}

// Parse nec2c output text into an NecResult.
export function parseOutput(text: string): NecResult {
  // Match Python str.splitlines(): split on any newline flavour.
  const lines = text.split(/\r\n|\r|\n/);
  let sources: SourceResult[] = [];
  let pattern: PatternPoint[] = [];
  let currents: SegmentCurrent[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line === undefined) {
      continue;
    }
    if (line.includes("ANTENNA INPUT PARAMETERS")) {
      sources = parseSources(lines, idx);
    } else if (line.includes("CURRENTS AND LOCATION")) {
      // Data rows begin after the title and two-line column header.
      currents = parseCurrents(lines, idx + 4);
    } else if (line.includes("RADIATION PATTERNS")) {
      // Data rows begin after the three-line column header.
      pattern = parsePattern(lines, idx + 4);
    }
  }
  return { sources, pattern, currents };
}
