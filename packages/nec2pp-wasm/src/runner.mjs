// nec2++ in WebAssembly.
//
// Unlike the sibling nec2c-wasm, nothing here is text. nec2++ is driven
// through its C++ API and hands back numbers, so there is no deck to format
// and no output to parse -- and none of the column-layout fragility that
// comes with parsing.

import createNec2pp from "../prebuilts/nec2pp.mjs";

export { createSolver, POLARIZATION_SENSE };

// nec2++ reports polarization sense as an index. The order is nec2++'s own
// enum (POL_LINEAR, POL_RIGHT, POL_LEFT); the fourth is what it uses where
// the field is too small for a sense to mean anything, which is a pattern
// null.
const POLARIZATION_SENSE = ["LINEAR", "RIGHT", "LEFT", "UNDEFINED"];

// The Emscripten module is expensive to instantiate and safe to share: each
// solve gets its own nec_context, so state does not leak between them. One
// factory call is enough for a process.
let modulePromise;

function loadModule(options) {
  if (modulePromise === undefined) {
    modulePromise = createNec2pp(options);
  }
  return modulePromise;
}

/**
 * Load nec2++ and return a solver.
 *
 * @param {{locateFile?: (path: string) => string}} [options] Emscripten
 *   options; `locateFile` points at nec2pp.wasm when it is not beside the
 *   glue module.
 * @returns {Promise<(model: object) => object>} A function that solves one
 *   model and returns its results.
 */
async function createSolver(options = {}) {
  const module = await loadModule(options);
  return (model) => solve(module, model);
}

// Free every C++ object this solve created, whatever happened. Emscripten
// cannot collect them: a bound object holds a wasm heap pointer, so dropping
// the JS reference leaks the memory behind it.
function solve(module, model) {
  const nec = new module.Nec();
  try {
    return run(nec, model);
  } finally {
    nec.delete();
  }
}

function run(nec, model) {
  const {
    wires = [],
    transforms = [],
    sources = [],
    loads = [],
    transmissionLines = [],
    ground = false,
    groundConnected = false,
    freqMhz,
    grid,
  } = model;

  for (const w of wires) {
    nec.wire(w.tag, w.segments, w.x1, w.y1, w.z1, w.x2, w.y2, w.z2, w.radiusM);
  }
  for (const t of transforms) {
    nec.transform(
      t.tagIncrement ?? 0,
      t.copies ?? 0,
      t.rotXDeg ?? 0,
      t.rotYDeg ?? 0,
      t.rotZDeg ?? 0,
      t.moveXM ?? 0,
      t.moveYM ?? 0,
      t.moveZM ?? 0,
      t.fromTag ?? 0,
    );
  }

  // gpflag mirrors the GE card: 0 free space, 1 wires bonded to the ground
  // plane, -1 ground present with nothing touching it.
  const grounded = ground !== false;
  nec.geometryComplete(grounded ? (groundConnected ? 1 : -1) : 0);
  applyGround(nec, ground);

  nec.frequency(freqMhz);
  for (const s of sources) {
    nec.excitationVoltage(s.tag, s.segment, s.vReal, s.vImag);
  }
  for (const load of loads) {
    applyLoad(nec, load);
  }
  for (const line of transmissionLines) {
    nec.transmissionLine(
      line.tag1,
      line.segment1,
      line.tag2,
      line.segment2,
      line.z0Ohm,
      line.lengthM,
    );
  }

  // This is the call that runs the solve; everything above only describes.
  nec.radiationPattern(
    0,
    grid.ntheta,
    grid.nphi,
    grid.axes ?? 0,
    grid.normalization ?? 0,
    grid.gain ?? 0,
    grid.average ?? 0,
    grid.theta0,
    grid.phi0,
    grid.dtheta,
    grid.dphi,
  );

  return readResults(nec, sources, grid);
}

// GN card types: 0 finite by reflection coefficient, 1 perfect conductor,
// 2 Sommerfeld/Norton. A radial screen only exists for type 0.
const GN_REFLECTION = 0;
const GN_PERFECT = 1;
const GN_SOMMERFELD = 2;

function applyGround(nec, ground) {
  if (ground === false) {
    return;
  }
  if (ground === true) {
    nec.groundCard(GN_PERFECT, 0, 0, 0, 0, 0, 0, 0);
    return;
  }
  const { radials } = ground;
  const method = ground.method ?? (radials ? "reflection" : "sommerfeld");
  if (radials && method === "sommerfeld") {
    throw new Error(
      "a radial ground screen cannot be combined with the Sommerfeld ground; use method 'reflection', or drop the radials",
    );
  }
  const type = method === "sommerfeld" ? GN_SOMMERFELD : GN_REFLECTION;
  if (radials) {
    nec.groundCard(
      type,
      radials.count,
      ground.epsR,
      ground.sigmaSm,
      radials.screenRadiusM,
      radials.wireRadiusM,
      0,
      0,
    );
    return;
  }
  nec.groundCard(type, 0, ground.epsR, ground.sigmaSm, 0, 0, 0, 0);
}

// LD card type codes, in the order the NEC-2 documentation lists them.
const LD_TYPE = {
  series: 0,
  parallel: 1,
  seriesPerMeter: 2,
  parallelPerMeter: 3,
  impedance: 4,
  conductivity: 5,
};

function applyLoad(nec, load) {
  const from = load.fromSegment ?? 0;
  const to = load.toSegment ?? from;
  const type = LD_TYPE[load.kind];
  if (type === undefined) {
    throw new Error(`unknown load kind: ${JSON.stringify(load.kind)}`);
  }
  if (load.kind === "conductivity") {
    nec.loadCard(type, load.tag, from, to, load.sigmaSm, 0, 0);
    return;
  }
  if (load.kind === "impedance") {
    nec.loadCard(
      type,
      load.tag,
      from,
      to,
      load.resistanceOhm,
      load.reactanceOhm,
      0,
    );
    return;
  }
  nec.loadCard(
    type,
    load.tag,
    from,
    to,
    load.resistanceOhm,
    load.inductanceH,
    load.capacitanceF,
  );
}

// Bound std::vectors are wasm-heap objects like any other, so each one has to
// be copied into a JS array and then deleted.
function drain(vector, map) {
  const out = [];
  const size = vector.size();
  for (let i = 0; i < size; i++) {
    const item = vector.get(i);
    out.push(map(item));
    if (typeof item?.delete === "function") {
      item.delete();
    }
  }
  vector.delete();
  return out;
}

function readResults(nec, sources, grid) {
  const patternVector = nec.pattern();
  const pattern = drain(patternVector, (p) => ({
    ...p,
    sense: POLARIZATION_SENSE[p.senseIndex] ?? "UNDEFINED",
  }));
  // The pattern is walked phi-major, matching how the getters are indexed;
  // the angles are not stored with it, so they are recomputed from the grid
  // that asked for them.
  for (let i = 0; i < pattern.length; i++) {
    const theta = i % grid.ntheta;
    const phi = Math.floor(i / grid.ntheta);
    pattern[i].thetaDeg = grid.theta0 + theta * grid.dtheta;
    pattern[i].phiDeg = grid.phi0 + phi * grid.dphi;
  }

  const currents = drain(nec.currents(), (c) => ({ ...c }));

  const feeds = sources.map((source, index) => ({
    tag: source.tag,
    segment: source.segment,
    zReal: nec.impedanceReal(index),
    zImag: nec.impedanceImag(index),
  }));

  return {
    sources: feeds,
    pattern,
    currents,
    gainMaxDb: nec.gainMax(),
    gainMeanDb: nec.gainMean(),
    // Only computed when the grid asked for it (grid.average) and it has at
    // least two points in each angle; otherwise nec2++ leaves it untouched.
    averagePowerGain: grid.average ? nec.averagePowerGain() : undefined,
  };
}
