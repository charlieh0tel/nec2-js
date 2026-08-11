// nec2++ in WebAssembly.
//
// Nothing here is text. nec2++ is driven through its C++ API and hands back
// numbers, so there is no deck to format and no output to parse.
//
// Two layers. createContext() mirrors nec2++'s own shape -- describe a
// structure, then solve, then read results -- and is what you want when a
// model is built up conditionally or solved more than once. solve() is the
// one-shot convenience over it.
//
// Conventions throughout, which nec2++'s C++ API does not share: complex
// values are {re, im}, points are [x, y, z] in metres, angles are degrees,
// and anything selecting a mode is a string rather than an integer code.

import createNecpp from "../prebuilts/necpp.mjs";

export { createContext, createSolver, solve, POLARIZATION_SENSE };

// nec2++'s polarization_sense enum, in its own order. The fourth is what it
// reports where both field components are ~0 and no sense means anything --
// a pattern null.
const POLARIZATION_SENSE = ["LINEAR", "RIGHT", "LEFT", "UNDEFINED"];

// GN card ground types: finite by reflection coefficient, perfect conductor,
// Sommerfeld/Norton. A radial screen exists only for the first.
const GN_REFLECTION = 0;
const GN_PERFECT = 1;
const GN_SOMMERFELD = 2;

// GE flag: free space, ground with wires bonded to it, ground with nothing
// touching it.
const GE_FREE_SPACE = 0;
const GE_GROUND_CONNECTED = 1;
const GE_GROUND_UNCONNECTED = -1;

// nec2++'s excitation_type enum.
const EXCITATION = {
  voltage: 0,
  planeWaveLinear: 1,
  planeWaveRightCircular: 2,
  planeWaveLeftCircular: 3,
  current: 4,
  voltageSlopeDiscontinuity: 5,
};

// LD card type codes, in the order the NEC-2 documentation lists them.
const LOAD = {
  series: 0,
  parallel: 1,
  seriesPerMeter: 2,
  parallelPerMeter: 3,
  impedance: 4,
  conductivity: 5,
};

// The Emscripten module is expensive to instantiate and safe to share: each
// context owns its own nec_context, so nothing leaks between them.
let modulePromise;

function loadModule(options) {
  if (modulePromise === undefined) {
    modulePromise = createNecpp(options);
  }
  return modulePromise;
}

/**
 * Load nec2++ and open a context to describe a structure in.
 *
 * @param {{locateFile?: (path: string) => string}} [options] Emscripten
 *   options; `locateFile` points at necpp.wasm when it does not sit beside
 *   the glue module.
 * @returns {Promise<NecContext>} An open context. Call dispose() when done.
 */
async function createContext(options = {}) {
  const module = await loadModule(options);
  return new NecContext(new module.Nec());
}

/**
 * Solve one structure and return its results.
 *
 * @param {object} model The structure, environment and sampling grid.
 * @param {object} [options] Emscripten options, as createContext takes.
 * @returns {Promise<object>} The results.
 */
async function solve(model, options = {}) {
  const nec = await createContext(options);
  try {
    return nec.solveModel(model);
  } finally {
    nec.dispose();
  }
}

/**
 * Load nec2++ once and return a function that solves models with it.
 *
 * @param {object} [options] Emscripten options, as createContext takes.
 * @returns {Promise<(model: object) => object>} A solve function.
 */
async function createSolver(options = {}) {
  // Loading is the only asynchronous part, so doing it once here leaves a
  // plain synchronous solve behind.
  const module = await loadModule(options);
  return (model) => {
    const nec = new NecContext(new module.Nec());
    try {
      return nec.solveModel(model);
    } finally {
      nec.dispose();
    }
  };
}

// A structure being described, and then solved.
//
// The order nec2++ requires: geometry, then finishGeometry(), then the
// environment and excitation, then solvePattern(), which is the call that
// actually runs the solve. Reading a result before that throws.
class NecContext {
  #nec;

  constructor(nec) {
    this.#nec = nec;
  }

  #assertOpen() {
    if (this.#nec === undefined) {
      throw new Error("this context has been disposed");
    }
  }

  // --- geometry ---------------------------------------------------------

  /** A straight wire from one point to another. */
  wire({ tag, segments, from, to, radiusM }) {
    this.#assertOpen();
    this.#nec.wire(
      tag,
      segments,
      from[0],
      from[1],
      from[2],
      to[0],
      to[1],
      to[2],
      radiusM,
    );
    return this;
  }

  /** An arc of the given radius, swept between two angles in the XZ plane. */
  arc({ tag, segments, radiusM, fromDeg, toDeg, wireRadiusM }) {
    this.#assertOpen();
    this.#nec.arc(tag, segments, radiusM, fromDeg, toDeg, wireRadiusM);
    return this;
  }

  /**
   * A helix. turnSpacingM is the pitch and lengthM the axial length; a
   * negative length winds it left-handed. The radius pairs are the ellipse
   * semi-axes at each end, so unequal pairs give a tapered or elliptical
   * helix.
   */
  helix({
    tag,
    segments,
    turnSpacingM,
    lengthM,
    startRadii,
    endRadii,
    wireRadiusM,
  }) {
    this.#assertOpen();
    this.#nec.helix(
      tag,
      segments,
      turnSpacingM,
      lengthM,
      startRadii[0],
      startRadii[1],
      endRadii[0],
      endRadii[1],
      wireRadiusM,
    );
    return this;
  }

  /**
   * Move, rotate and optionally replicate what has been defined so far.
   * Rotations compose X first, then Y, then Z, and are applied before the
   * translation. copies: 0 moves in place; more reapply the transform to
   * each new copy, so 45 degrees and 7 copies sweeps a circle.
   */
  transform({
    rotXDeg = 0,
    rotYDeg = 0,
    rotZDeg = 0,
    moveM = [0, 0, 0],
    copies = 0,
    tagIncrement = 0,
    fromTag = 0,
  } = {}) {
    this.#assertOpen();
    this.#nec.transform(
      tagIncrement,
      copies,
      rotXDeg,
      rotYDeg,
      rotZDeg,
      moveM[0],
      moveM[1],
      moveM[2],
      fromTag,
    );
    return this;
  }

  /**
   * Reflect the structure through the named coordinate planes, which is a
   * large speedup as well as a convenience: NEC solves one sector and reuses
   * it.
   */
  reflect({ planes, tagIncrement = 0 }) {
    this.#assertOpen();
    // NEC packs the three plane flags as decimal digits, x being the most
    // significant.
    const code =
      (planes.includes("x") ? 100 : 0) +
      (planes.includes("y") ? 10 : 0) +
      (planes.includes("z") ? 1 : 0);
    this.#nec.reflect(tagIncrement, code);
    return this;
  }

  /**
   * End the geometry. groundConnected says that wires touch the ground plane
   * and NEC should carry their currents onto the ground image -- what a
   * ground-mounted vertical needs, and meaningless without a ground.
   */
  finishGeometry({ ground = false, groundConnected = false } = {}) {
    this.#assertOpen();
    if (ground === false) {
      if (groundConnected) {
        throw new Error(
          "groundConnected asks NEC to bond wires to a ground plane, but there is no ground",
        );
      }
      this.#nec.geometryComplete(GE_FREE_SPACE);
      return this;
    }
    this.#nec.geometryComplete(
      groundConnected ? GE_GROUND_CONNECTED : GE_GROUND_UNCONNECTED,
    );
    this.#applyGround(ground);
    return this;
  }

  #applyGround(ground) {
    if (ground === true) {
      this.#nec.groundCard(GN_PERFECT, 0, 0, 0, 0, 0, 0, 0);
      return;
    }
    const { epsR, sigmaSm, radials } = ground;
    if (!(epsR >= 1)) {
      throw new Error(
        `ground epsR is a relative permittivity and cannot be below 1, got ${epsR}`,
      );
    }
    if (!(sigmaSm >= 0)) {
      throw new Error(
        `ground sigmaSm is a conductivity and cannot be negative, got ${sigmaSm}`,
      );
    }
    // NEC has no screen model for the Sommerfeld ground, so asking for
    // radials selects the reflection-coefficient one.
    const method = ground.method ?? (radials ? "reflection" : "sommerfeld");
    if (radials && method === "sommerfeld") {
      throw new Error(
        "a radial ground screen cannot be combined with the Sommerfeld ground; use method 'reflection', or drop the radials",
      );
    }
    const type = method === "sommerfeld" ? GN_SOMMERFELD : GN_REFLECTION;
    if (radials) {
      this.#nec.groundCard(
        type,
        radials.count,
        epsR,
        sigmaSm,
        radials.screenRadiusM,
        radials.wireRadiusM,
        0,
        0,
      );
      return;
    }
    this.#nec.groundCard(type, 0, epsR, sigmaSm, 0, 0, 0, 0);
  }

  // --- environment ------------------------------------------------------

  /** The single frequency to solve at. */
  frequency(freqMhz) {
    this.#assertOpen();
    this.#nec.frequency(freqMhz);
    return this;
  }

  /**
   * Drive the structure. "voltage" and "voltageSlopeDiscontinuity" sit on a
   * segment; "current" is an elementary source at a point; the plane-wave
   * kinds illuminate the structure instead, which is how a receiving antenna
   * or a radar cross section is modelled.
   */
  excite(excitation) {
    this.#assertOpen();
    const kind = excitation.kind ?? "voltage";
    const code = EXCITATION[kind];
    if (code === undefined) {
      throw new Error(`unknown excitation kind: ${JSON.stringify(kind)}`);
    }
    if (kind === "voltage" || kind === "voltageSlopeDiscontinuity") {
      const { tag, segment, volts } = excitation;
      this.#nec.excitationVoltage(code, tag, segment, volts.re, volts.im ?? 0);
      return this;
    }
    if (kind === "current") {
      const { at, alphaDeg = 0, betaDeg = 0, moment } = excitation;
      this.#nec.excitationCurrent(
        at[0],
        at[1],
        at[2],
        alphaDeg,
        betaDeg,
        moment,
      );
      return this;
    }
    const {
      ntheta = 1,
      nphi = 1,
      theta0 = 0,
      phi0 = 0,
      etaDeg = 0,
      dtheta = 0,
      dphi = 0,
      axialRatio = 0,
    } = excitation;
    this.#nec.excitationPlaneWave(
      code,
      ntheta,
      nphi,
      theta0,
      phi0,
      etaDeg,
      dtheta,
      dphi,
      axialRatio,
    );
    return this;
  }

  /**
   * Load segments. "conductivity" is the one that turns a lossless model into
   * a real one -- copper is 5.8e7 -- and NEC derives the frequency-dependent
   * skin-effect impedance from it and the wire radius.
   *
   * tag 0 addresses the whole structure. With a nonzero tag the segment range
   * counts within that tag; with tag 0 the numbers are absolute.
   */
  load(spec) {
    this.#assertOpen();
    const type = LOAD[spec.kind];
    if (type === undefined) {
      throw new Error(`unknown load kind: ${JSON.stringify(spec.kind)}`);
    }
    const from = spec.fromSegment ?? 0;
    const to = spec.toSegment ?? from;
    if (to < from) {
      throw new Error(`load toSegment (${to}) is before fromSegment (${from})`);
    }
    if (spec.kind === "conductivity") {
      if (!(spec.sigmaSm > 0)) {
        throw new Error(
          `load sigmaSm is a conductivity and must be positive, got ${spec.sigmaSm}`,
        );
      }
      this.#nec.loadCard(type, spec.tag, from, to, spec.sigmaSm, 0, 0);
      return this;
    }
    if (spec.kind === "impedance") {
      this.#nec.loadCard(
        type,
        spec.tag,
        from,
        to,
        spec.resistanceOhm,
        spec.reactanceOhm,
        0,
      );
      return this;
    }
    // A zero L or C is not a short or an open: NEC leaves that element out of
    // the network, which is how a plain R-C or R-L is written.
    this.#nec.loadCard(
      type,
      spec.tag,
      from,
      to,
      spec.resistanceOhm ?? 0,
      spec.inductanceH ?? 0,
      spec.capacitanceF ?? 0,
    );
    return this;
  }

  /**
   * An ideal transmission line between two segments. A negative z0Ohm models
   * a crossed connection, which flips the handedness. The length is
   * electrical length at the free-space wavelength, so wavelength/4 is a 90
   * degree line whatever a real coax's velocity factor would be; 0 tells NEC
   * to use the straight-line distance between the segments.
   */
  transmissionLine({ from, to, z0Ohm, lengthM = 0 }) {
    this.#assertOpen();
    this.#nec.transmissionLine(
      from.tag,
      from.segment,
      to.tag,
      to.segment,
      z0Ohm,
      lengthM,
    );
    return this;
  }

  /** A general two-port network, given as its admittance matrix in siemens. */
  network({ from, to, y11, y12, y22 }) {
    this.#assertOpen();
    this.#nec.network(
      from.tag,
      from.segment,
      to.tag,
      to.segment,
      y11.re,
      y11.im ?? 0,
      y12.re,
      y12.im ?? 0,
      y22.re,
      y22.im ?? 0,
    );
    return this;
  }

  /**
   * Below this separation, in wavelengths, NEC uses its cheaper interaction
   * approximation: the accuracy-for-speed knob on large structures.
   */
  interactionDistance(wavelengths) {
    this.#assertOpen();
    this.#nec.interactionDistance(wavelengths);
    return this;
  }

  /** The extended thin-wire kernel, for wires thick against their segments. */
  extendedThinWireKernel(enabled = true) {
    this.#assertOpen();
    this.#nec.extendedThinWireKernel(enabled);
    return this;
  }

  // --- solve ------------------------------------------------------------

  /**
   * Sample the far field, which is the call that actually runs the solve.
   *
   * The NEC option digits are separate values rather than a packed XNDA code:
   * axes (X), normalization (N), gain (D) and average (A). Set average to ask
   * for the average power gain, which also needs at least two points in each
   * angle.
   */
  solvePattern({
    ntheta,
    nphi,
    theta0 = 0,
    phi0 = 0,
    dtheta = 0,
    dphi = 0,
    axes = 0,
    normalization = 0,
    gain = 0,
    average = 0,
  }) {
    this.#assertOpen();
    const wantAverage = average ? 1 : 0;
    this.#nec.radiationPattern(
      0,
      ntheta,
      nphi,
      axes,
      normalization,
      gain,
      wantAverage,
      theta0,
      phi0,
      dtheta,
      dphi,
    );
    return this.#readResults(
      { ntheta, nphi, theta0, phi0, dtheta, dphi },
      wantAverage,
    );
  }

  /** Describe and solve a whole model in one call. */
  solveModel(model) {
    const {
      wires = [],
      arcs = [],
      helices = [],
      transforms = [],
      reflections = [],
      sources = [],
      loads = [],
      transmissionLines = [],
      networks = [],
      ground = false,
      groundConnected = false,
      freqMhz,
      interactionDistance,
      extendedThinWireKernel,
      grid,
    } = model;

    for (const w of wires) this.wire(w);
    for (const a of arcs) this.arc(a);
    for (const h of helices) this.helix(h);
    for (const t of transforms) this.transform(t);
    for (const r of reflections) this.reflect(r);
    this.finishGeometry({ ground, groundConnected });
    if (extendedThinWireKernel !== undefined) {
      this.extendedThinWireKernel(extendedThinWireKernel);
    }
    if (interactionDistance !== undefined) {
      this.interactionDistance(interactionDistance);
    }
    this.frequency(freqMhz);
    for (const s of sources) this.excite(s);
    for (const l of loads) this.load(l);
    for (const t of transmissionLines) this.transmissionLine(t);
    for (const n of networks) this.network(n);
    return this.solvePattern(grid);
  }

  // --- results ----------------------------------------------------------

  #readResults(grid, wantAverage) {
    const pattern = drain(this.#nec.pattern(), (p, index) => {
      // nec2++ walks the grid phi-major and does not store the angles with
      // it, so they are recomputed from the grid that asked for them.
      const theta = index % grid.ntheta;
      const phi = Math.floor(index / grid.ntheta);
      return {
        thetaDeg: grid.theta0 + theta * grid.dtheta,
        phiDeg: grid.phi0 + phi * grid.dphi,
        totalGainDb: p.totalGainDb,
        axialRatio: p.axialRatio,
        tiltDeg: p.tiltDeg,
        sense: POLARIZATION_SENSE[p.senseIndex] ?? "UNDEFINED",
        eTheta: { magnitude: p.eThetaMagnitude, phaseDeg: p.eThetaPhaseDeg },
        ePhi: { magnitude: p.ePhiMagnitude, phaseDeg: p.ePhiPhaseDeg },
      };
    });

    const currents = drain(this.#nec.currents(), (c) => ({
      tag: c.tag,
      segment: c.segment,
      at: [c.x, c.y, c.z],
      lengthM: c.lengthM,
      current: { re: c.iReal, im: c.iImag },
    }));

    const feeds = drain(this.#nec.feeds(), (f) => ({
      tag: f.tag,
      segment: f.segment,
      impedance: { re: f.zReal, im: f.zImag },
      current: { re: f.iReal, im: f.iImag },
      voltage: { re: f.vReal, im: f.vImag },
      powerW: f.powerW,
    }));

    return {
      feeds,
      pattern,
      currents,
      gain: this.#nec.gain(),
      gainRhcp: this.#nec.gainRhcp(),
      gainLhcp: this.#nec.gainLhcp(),
      // Only computed when asked for; otherwise nec2++ leaves the slot
      // untouched and whatever is in it means nothing.
      averagePowerGain: wantAverage ? this.#nec.averagePowerGain() : undefined,
    };
  }

  /**
   * Release the wasm memory behind this context. Emscripten cannot collect
   * it: the bound object holds a heap pointer, so dropping the JS reference
   * leaks what it points at.
   */
  dispose() {
    if (this.#nec !== undefined) {
      this.#nec.delete();
      this.#nec = undefined;
    }
  }

  /** So a context can be held with `using`. */
  [Symbol.dispose]() {
    this.dispose();
  }
}

// Bound std::vectors are wasm-heap objects like any other: copy into a JS
// array, then delete both the elements and the vector.
function drain(vector, map) {
  const out = [];
  const size = vector.size();
  for (let i = 0; i < size; i++) {
    const item = vector.get(i);
    out.push(map(item, i));
    if (typeof item?.delete === "function") {
      item.delete();
    }
  }
  vector.delete();
  return out;
}
