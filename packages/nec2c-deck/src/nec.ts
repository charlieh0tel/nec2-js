// Emit NEC-2 decks and parse nec2c output.
//
// Nothing here runs a solver. NecRunner names the shape of one so a caller can
// supply it: the nec2c-wasm package, or a native nec2c binary. Keeping the
// solver out is what lets this package have no dependencies and run anywhere.
//
// buildDeck writes standard NEC-2 cards, but the parsers are keyed to nec2c's
// exact column layout and will not read output from other NEC implementations.

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

// A TL length of zero tells NEC to use the straight-line distance between the
// two segment centres. Spelling that as a sentinel rather than a bare 0 keeps
// a computed length that rounds away from silently becoming this instead of
// raising, which is the same rule the GW radius follows.
export const TL_LENGTH_FROM_GEOMETRY = "auto";

// A TL card: an ideal transmission line joining two segments.
//   tag1, segment1: first port (wire tag and 1-based segment).
//   tag2, segment2: second port.
//   z0Ohm: characteristic impedance; a negative value models a crossed
//     (polarity-reversed) connection, which flips the handedness.
//   lengthM: line length, or TL_LENGTH_FROM_GEOMETRY. nec2c treats a given
//     length as electrical length at the free-space wavelength, so length =
//     wavelength / 4 gives a 90 deg line regardless of any real coax velocity
//     factor.
//
// The card's shunt-admittance fields (F3..F6) are not written; they stay at
// zero, an unloaded line.
export interface TransmissionLine {
  tag1: number;
  segment1: number;
  tag2: number;
  segment2: number;
  z0Ohm: number;
  lengthM: number | typeof TL_LENGTH_FROM_GEOMETRY;
}

// A radial-wire ground screen buried under the feed point, for a GN card.
//   count: number of radials.
//   screenRadiusM: radius of the screen, i.e. the length of one radial.
//   wireRadiusM: conductor radius of a single radial.
// NEC models the screen as a surface impedance rather than as wires, so the
// radials cost nothing in matrix size. They can only be used with the
// reflection-coefficient ground below; nec2c rejects them outright with
// Sommerfeld (main.c: "RADIAL WIRE G.S. APPROXIMATION MAY NOT BE USED WITH
// SOMMERFELD GROUND OPTION").
export interface RadialScreen {
  count: number;
  screenRadiusM: number;
  wireRadiusM: number;
}

// How NEC treats finite ground.
//   "sommerfeld": the Sommerfeld/Norton solution. Slower, and the accurate
//     treatment for an antenna within a wavelength or so of earth.
//   "reflection": the Fresnel reflection-coefficient approximation. Faster,
//     degrades for antennas close to ground, and is the only option that
//     accepts a radial screen.
export type GroundMethod = "sommerfeld" | "reflection";

// Electrical constants of a real ground, for a GN card.
//   epsR: relative permittivity, dimensionless and at least 1.
//   sigmaSm: conductivity in siemens per metre.
//   method: defaults to "reflection" when a screen is given (the only method
//     NEC allows there) and "sommerfeld" otherwise, which is the accurate
//     choice for a bare antenna over earth.
//   radials: an optional buried screen.
// Typical constants: average ground 13 and 0.005, poor 5 and 0.001, sea water
// 81 and 5.
export interface GroundConstants {
  epsR: number;
  sigmaSm: number;
  method?: GroundMethod;
  radials?: RadialScreen;
}

// What sits beneath the antenna: nothing (free space), a perfect conductor, or
// real ground with the constants above.
export type Ground = boolean | GroundConstants;

// GN card ground types. 0 is finite ground by reflection coefficient, 1 a
// perfect conductor, 2 Sommerfeld/Norton for finite constants.
const GN_REFLECTION = 0;
const GN_PERFECT = 1;
const GN_SOMMERFELD = 2;
// Radial-wire ground screen count when there is no screen.
const GN_NO_RADIALS = 0;

// GE flag: what the structure does about the ground plane.
//   0: no ground at all (free space).
//   -1: ground present, but no wire touches it.
//   1: ground present and wires connect to it, so NEC extends the current
//      basis onto the ground image. Required for a ground-mounted vertical.
const GE_FREE_SPACE = 0;
const GE_GROUND_UNCONNECTED = -1;
const GE_GROUND_CONNECTED = 1;

// RP-card sampling grid over the upper hemisphere. Angles are in degrees; theta
// is measured from zenith.
//
// optionCode is the card's XNDA digits and defaults to RP_OPTION_CODE. Two of
// them change what the parsed columns mean without moving them: X selects
// vertical/horizontal or major/minor axis gains, and D selects power or
// directive gain. parseOutput reads both as totalGainDb, so a caller that
// changes this has to remember which it asked for. N (normalization) and A
// (averaging) add rows and a trailing block that the parsers skip.
//
// The card's F5 and F6 fields (radial distance and gain normalization factor)
// are not written; they stay at zero.
export interface RadiationGrid {
  ntheta: number;
  nphi: number;
  theta0: number;
  phi0: number;
  dtheta: number;
  dphi: number;
  optionCode?: number;
}

// Which segments an LD card loads.
//   tag: wire tag to load. Zero addresses the structure as a whole.
//   fromSegment, toSegment: 1-based segment range. With a nonzero tag they
//     count segments within that tag; with tag 0 they are absolute segment
//     numbers over the whole structure. Omitting both loads every segment of
//     the tag (or, with tag 0, every segment in the model). Omitting only
//     toSegment loads the single segment fromSegment.
export interface LoadTarget {
  tag: number;
  fromSegment?: number;
  toSegment?: number;
}

// An LD card. The kind picks how NEC turns the values into a segment
// impedance:
//   "series", "parallel": a lumped R-L-C across the whole segment, in ohms,
//     henries and farads. A zero L or C is left out of the network rather
//     than being taken literally as a short or an open.
//   "seriesPerMeter", "parallelPerMeter": the same network specified per unit
//     length (ohms/m, H/m, F/m) and scaled by each segment's length, so one
//     card loads unequal segments consistently.
//   "impedance": a fixed R + jX in ohms, frequency-independent.
//   "conductivity": the wire's own metal, in siemens per metre. This is the
//     one that turns a lossless model into a real one -- copper is 5.8e7 --
//     and NEC computes the skin-effect surface impedance from it and the wire
//     radius, so it varies with frequency as it should.
export type Load = LoadTarget &
  (
    | {
        kind: "series" | "parallel" | "seriesPerMeter" | "parallelPerMeter";
        resistanceOhm: number;
        inductanceH: number;
        capacitanceF: number;
      }
    | { kind: "impedance"; resistanceOhm: number; reactanceOhm: number }
    | { kind: "conductivity"; sigmaSm: number }
  );

// LD card type codes, in the order the NEC-2 documentation lists them.
const LD_TYPE: Record<Load["kind"], number> = {
  series: 0,
  parallel: 1,
  seriesPerMeter: 2,
  parallelPerMeter: 3,
  impedance: 4,
  conductivity: 5,
};

// A GM card: rotate and translate the structure built so far, optionally
// leaving copies behind.
//   rotXDeg, rotYDeg, rotZDeg: rotation about each axis, degrees.
//   moveXM, moveYM, moveZM: translation, metres.
//   copies: how many new copies to generate. Zero (the default) moves the
//     existing structure in place instead of copying it.
//   tagIncrement: added to every tag on each successive copy, so the copies
//     stay individually addressable.
//   fromTag: the transform applies to this tag and everything defined after
//     it. Zero (the default) means the whole structure.
//
// NEC rotates before it translates, and composes the rotations X first, then
// Y, then Z (geometry.c move() builds Rz*Ry*Rx). With copies > 1 the whole
// transform is reapplied to the last copy each time, so a rotation of 45 deg
// with 7 copies sweeps a full circle rather than putting everything at 45.
export interface Transform {
  rotXDeg?: number;
  rotYDeg?: number;
  rotZDeg?: number;
  moveXM?: number;
  moveYM?: number;
  moveZM?: number;
  copies?: number;
  tagIncrement?: number;
  fromTag?: number;
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
// written with a fixed number of decimals. toFixed also switches to
// exponential notation at 1e21, which no NEC card reader accepts.
//
// Rounding to zero only matters where zero changes what the card means, which
// is the GW radius: NEC reads a zero radius as a tapered wire expecting a GC
// card, and nec2c then rejects the deck with an error naming neither the wire
// nor the field. Coordinates are not held to that rule -- a wire endpoint at
// the origin or on an axis is ordinary, and a rotated one lands on values like
// 3.4e-17 that are zero in every sense that matters.
const F6_SMALLEST = 1e-6;
const FIXED_NOTATION_LIMIT = 1e21;

function checkFinite(x: number, field: string): void {
  if (!Number.isFinite(x)) {
    throw new Error(`${field} must be a finite number, got ${x}`);
  }
}

function checkFixed(x: number, field: string): void {
  checkFinite(x, field);
  if (Math.abs(x) >= FIXED_NOTATION_LIMIT) {
    throw new Error(`${field} is too large to write as a NEC card field: ${x}`);
  }
}

// For the GW radius, where a value that rounds away changes the card's meaning.
function f6nonzero(x: number, field: string): string {
  checkFixed(x, field);
  if (x === 0 || Math.abs(x) < F6_SMALLEST) {
    throw new Error(
      `${field} would be written as zero (${x}); NEC card fields carry ${F6_SMALLEST} resolution, and a zero radius means a tapered wire`,
    );
  }
  return x.toFixed(6);
}

function f3any(x: number, field: string): string {
  checkFixed(x, field);
  return x.toFixed(3);
}

function f6any(x: number, field: string): string {
  checkFixed(x, field);
  return x.toFixed(6);
}

// Loading values span far more decades than a coordinate does: 5 pF is 5e-12
// farads, which fixed six-decimal notation writes as a flat zero, and NEC
// reads a zero L or C as "leave this element out" rather than as the value
// asked for. nec2c's control-card reader accepts E notation in a float field
// (input.c readmn tests for 'E' and 'e'), so LD values are written that way
// and keep their magnitude. Geometry cards are kept in fixed notation even
// though readgm would accept E as well: those fields are the ones a
// fixed-column reader in another NEC implementation is most likely to be
// handed, and no antenna dimension needs the range.
const LOAD_DECIMALS = 6;

function e6any(x: number, field: string): string {
  checkFinite(x, field);
  return x.toExponential(LOAD_DECIMALS);
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
      `comment is ${text.length} characters; NEC reads ` +
        `${COMMENT_COLUMNS}: ${JSON.stringify(text)}`,
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

// GN card for finite ground. After the type code and the radial count come two
// unused integer fields, then the constants themselves. With a screen the next
// two floats describe it; without one they would be a second ground medium,
// which is not written here and so stays at zero.
function groundCard(ground: GroundConstants): string {
  if (!(ground.epsR >= 1)) {
    throw new Error(
      `ground epsR is a relative permittivity and cannot be below 1, got ${ground.epsR}`,
    );
  }
  if (!(ground.sigmaSm >= 0)) {
    throw new Error(
      `ground sigmaSm is a conductivity and cannot be negative, got ${ground.sigmaSm}`,
    );
  }
  const { radials } = ground;
  const method = ground.method ?? (radials ? "reflection" : "sommerfeld");
  if (radials && method === "sommerfeld") {
    throw new Error(
      "a radial ground screen cannot be combined with the Sommerfeld ground; NEC has no such model. Use method 'reflection', or drop the radials",
    );
  }
  const type = method === "sommerfeld" ? GN_SOMMERFELD : GN_REFLECTION;
  const constants =
    `${f6any(ground.epsR, "ground epsR")} ` +
    `${f6any(ground.sigmaSm, "ground sigmaSm")}`;
  if (!radials) {
    return `GN ${type} ${GN_NO_RADIALS} 0 0 ${constants}`;
  }
  if (radials.count < 1) {
    throw new Error(
      `a radial screen needs at least one radial, got ${radials.count}`,
    );
  }
  return (
    `GN ${type} ${checkIndex(radials.count, "radial count")} 0 0 ` +
    `${constants} ` +
    // Both are dimensions of real wire: a screen or radial that rounds to
    // zero is not a screen, so neither may round away.
    `${f6nonzero(radials.screenRadiusM, "radial screen radius")} ` +
    `${f6nonzero(radials.wireRadiusM, "radial wire radius")}`
  );
}

// LD card. The three float fields carry different quantities per load kind, so
// each branch names what it is writing.
function loadCard(load: Load): string {
  const from = checkIndex(load.fromSegment ?? 0, "load fromSegment");
  // NEC reads a zero "to" as "same as from", which is what omitting it means.
  const to = checkIndex(load.toSegment ?? from, "load toSegment");
  if (to < from) {
    throw new Error(
      `load toSegment (${to}) is before fromSegment (${from}); nec2c rejects the card outright`,
    );
  }
  const values = loadValues(load);
  return (
    `LD ${LD_TYPE[load.kind]} ${checkIndex(load.tag, "load tag")} ` +
    `${from} ${to} ${values}`
  );
}

function loadValues(load: Load): string {
  if (load.kind === "conductivity") {
    if (!(load.sigmaSm > 0)) {
      throw new Error(
        `load sigmaSm is a conductivity and must be positive, got ${load.sigmaSm}`,
      );
    }
    return `${e6any(load.sigmaSm, "load sigmaSm")} 0 0`;
  }
  if (load.kind === "impedance") {
    return (
      `${e6any(load.resistanceOhm, "load resistance")} ` +
      `${e6any(load.reactanceOhm, "load reactance")} 0`
    );
  }
  // A zero L or C is not read as a short or an open: NEC leaves that element
  // out of the network entirely, so omitting one is how a plain R-C or R-L is
  // written.
  return (
    `${e6any(load.resistanceOhm, "load resistance")} ` +
    `${e6any(load.inductanceH, "load inductance")} ` +
    `${e6any(load.capacitanceF, "load capacitance")}`
  );
}

// GM card. The last field is a tag number even though NEC reads it as a float.
function transformCard(transform: Transform): string {
  return (
    `GM ${checkIndex(transform.tagIncrement ?? 0, "transform tagIncrement")} ` +
    `${checkIndex(transform.copies ?? 0, "transform copies")} ` +
    `${f3any(transform.rotXDeg ?? 0, "transform rotXDeg")} ` +
    `${f3any(transform.rotYDeg ?? 0, "transform rotYDeg")} ` +
    `${f3any(transform.rotZDeg ?? 0, "transform rotZDeg")} ` +
    `${f6any(transform.moveXM ?? 0, "transform moveXM")} ` +
    `${f6any(transform.moveYM ?? 0, "transform moveYM")} ` +
    `${f6any(transform.moveZM ?? 0, "transform moveZM")} ` +
    `${checkIndex(transform.fromTag ?? 0, "transform fromTag")}`
  );
}

// Everything buildDeck needs to write one deck.
//   comments: CM lines, one card each.
//   wires: GW cards, in the order they should be defined.
//   transforms: GM cards, applied after every wire is defined and in the order
//     given. A transform's fromTag selects the tail of the structure it acts
//     on, so replicating part of a model means defining that part last.
//   sources: EX voltage sources.
//   loads: LD cards.
//   transmissionLines: TL cards.
//   ground: free space, a perfect conductor, or real constants.
//   groundConnected: true when wires touch the ground plane and NEC should
//     bond them to it (GE 1) -- a ground-mounted vertical fed against earth.
//     Meaningless without a ground, and rejected there.
//   freqMhz: the single frequency to solve at.
//   grid: the RP sampling grid.
export interface DeckOptions {
  comments: string[];
  wires: Wire[];
  transforms?: Transform[];
  sources: Source[];
  loads?: Load[];
  transmissionLines?: TransmissionLine[];
  ground: Ground;
  groundConnected?: boolean;
  freqMhz: number;
  grid: RadiationGrid;
}

// Render a complete NEC-2 deck as text.
//
// Cards of one kind are emitted as a contiguous block. That is not only for
// readability: nec2c frees and reallocates the buffer behind LD, TL/NT and EX
// whenever a card of that kind arrives after a card of another kind (main.c
// tests iflow), so interleaving them would silently discard all but the last
// group.
export function buildDeck(options: DeckOptions): string {
  const {
    comments,
    wires,
    transforms = [],
    sources,
    loads = [],
    transmissionLines = [],
    ground,
    groundConnected = false,
    freqMhz,
    grid,
  } = options;

  const lines: string[] = comments.map((c) => `CM ${comment(c)}`);
  lines.push("CE");
  for (const w of wires) {
    const at = (field: string) => `wire ${w.tag} ${field}`;
    lines.push(
      `GW ${checkIndex(w.tag, "wire tag")} ` +
        `${checkIndex(w.segments, at("segment count"))} ` +
        `${f6any(w.x1, at("x1"))} ${f6any(w.y1, at("y1"))} ${f6any(w.z1, at("z1"))} ` +
        `${f6any(w.x2, at("x2"))} ${f6any(w.y2, at("y2"))} ${f6any(w.z2, at("z2"))} ` +
        `${f6nonzero(w.radiusM, at("radius"))}`,
    );
  }
  for (const t of transforms) {
    lines.push(transformCard(t));
  }
  if (ground === false) {
    if (groundConnected) {
      throw new Error(
        "groundConnected asks NEC to bond wires to a ground plane, but ground is false (free space)",
      );
    }
    lines.push(`GE ${GE_FREE_SPACE}`);
  } else {
    lines.push(
      `GE ${groundConnected ? GE_GROUND_CONNECTED : GE_GROUND_UNCONNECTED}`,
    );
  }
  if (ground === true) {
    // Perfect conducting ground plane, which also approximates a solid metal
    // reflector.
    lines.push(`GN ${GN_PERFECT}`);
  } else if (ground !== false) {
    lines.push(groundCard(ground));
  }
  lines.push("EK");
  for (const load of loads) {
    lines.push(loadCard(load));
  }
  for (const t of transmissionLines) {
    lines.push(
      `TL ${checkIndex(t.tag1, "line tag1")} ` +
        `${checkIndex(t.segment1, "line segment1")} ` +
        `${checkIndex(t.tag2, "line tag2")} ` +
        `${checkIndex(t.segment2, "line segment2")} ` +
        // A negative Z0 is meaningful here: it models a crossed connection.
        `${f6any(t.z0Ohm, "line impedance")} ` +
        // Zero is the card's own sentinel for "measure it from the geometry",
        // which is why a numeric length that rounds away is still refused.
        `${
          t.lengthM === TL_LENGTH_FROM_GEOMETRY
            ? (0).toFixed(6)
            : f6nonzero(t.lengthM, "line length")
        }`,
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
  lines.push(`FR 0 1 0 0 ${f6nonzero(freqMhz, "frequency")} 0`);
  lines.push(
    `RP 0 ${checkIndex(grid.ntheta, "grid ntheta")} ` +
      `${checkIndex(grid.nphi, "grid nphi")} ` +
      `${checkIndex(grid.optionCode ?? RP_OPTION_CODE, "grid optionCode")} ` +
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
    const looksLikeData =
      tokens.length >= 11 && t0 !== undefined && isFloat(t0);
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
//
// These column positions hold for every far-field RP mode -- verified against
// nec2c for each XNDA digit. What the option code changes is what two of the
// columns mean, not where they sit: the gain columns are major/minor axis or
// vertical/horizontal (X), and the total is a power gain or a directive gain
// (D). Both are read here as totalGainDb, so the caller has to know which it
// asked for. Near-field runs (RP 1) are a different section entirely and are
// rejected in parseOutput.
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
        t7 !== undefined && isFloat(t7)
          ? SENSE_UNDEFINED
          : (t7 ?? SENSE_UNDEFINED);
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
  let nearGround = false;
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
    if (sectionTitle(line, "RADIATED FIELDS NEAR GROUND")) {
      nearGround = true;
    }
  }

  // RP 1 asks for near-field values at points in space, which nec2c prints
  // under its own title with location and field columns that have nothing in
  // common with a radiation pattern. Say so, rather than handing back an empty
  // pattern that looks like an antenna with no radiation.
  if (nearGround && starts["RADIATION PATTERNS"].length === 0) {
    throw new Error(
      "nec2c output holds RADIATED FIELDS NEAR GROUND (an RP 1 near-field run), which this parser does not read; it reads far-field RADIATION PATTERNS",
    );
  }

  for (const [title, found] of Object.entries(starts)) {
    if (found.length > 1) {
      throw new Error(
        `nec2c output has ${found.length} ${title} sections; parseOutput handles one set of results per deck. Sweep by running one frequency per deck.`,
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
    pattern:
      patternStart === undefined ? [] : parsePattern(lines, patternStart),
  };
}
