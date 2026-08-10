// Smoke test / validation for the nec2c wasm build. Rerunnable.
//
// 1. Runs a reference deck through both native nec2c and the wasm runner.
// 2. Numerically compares the ANTENNA INPUT PARAMETERS impedance row and a
//    sample of RADIATION PATTERNS rows (tolerant of float formatting).
// 3. Runs 20 sequential wasm calls to prove repeatability.
// 4. Reports ms/run for wasm vs native.
//
// Usage: node test/smoke.mjs [deck.nec]
//
// Requires native nec2c for the comparison (Debian/Ubuntu: apt install nec2c);
// set NEC2C to point at it if it is not at the default path.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNec } from "../src/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const deckPath = process.argv[2] ?? join(here, "fixture.nec");
const NATIVE = process.env.NEC2C ?? "/usr/bin/nec2c";
const REL_TOL = 1e-4;
const RUNS = 20;

const deck = readFileSync(deckPath, "utf8");

// --- run native ---
function runNative(text) {
  const dir = mkdtempSync(join(tmpdir(), "nec2c-"));
  const inPath = join(dir, "in.nec");
  const outPath = join(dir, "out.txt");
  writeFileSync(inPath, text);
  execFileSync(NATIVE, ["-i", inPath, "-o", outPath]);
  return readFileSync(outPath, "utf8");
}

// --- parsing helpers ---
// Pull the single data row under ANTENNA INPUT PARAMETERS as an array of floats.
function parseInputParams(out) {
  const lines = out.split("\n");
  const idx = lines.findIndex((l) => l.includes("ANTENNA INPUT PARAMETERS"));
  if (idx < 0) throw new Error("no ANTENNA INPUT PARAMETERS section");
  // Scan for the data row rather than trusting a fixed header length: the
  // header differs between sections and grows lines in some RP modes, and a
  // hardcoded offset that lands on a header line would parse to all-NaN.
  for (let i = idx + 1; i < lines.length; i++) {
    const row = lines[i].trim().split(/\s+/).map(Number);
    if (row.length >= 11 && !row.some(Number.isNaN)) return row;
  }
  throw new Error("no ANTENNA INPUT PARAMETERS data row parsed");
}

// A comparison is only meaningful if there are numbers on both sides. NaN
// fails every > test, so an all-NaN parse would otherwise report a worst
// relative difference of zero and pass.
function requireFinite(values, label) {
  if (!values.length) throw new Error(`${label}: no values parsed`);
  const bad = values.findIndex((v) => !Number.isFinite(v));
  if (bad >= 0) {
    throw new Error(`${label}: value ${bad} is not finite (${values[bad]})`);
  }
}

// Pull the RADIATION PATTERNS numeric rows as arrays of floats. The section
// has a variable number of header lines before the data, so we skip forward
// to the first all-numeric row and then collect the contiguous block.
function parseRadiation(out) {
  const lines = out.split("\n");
  const idx = lines.findIndex((l) => l.includes("RADIATION PATTERNS"));
  if (idx < 0) throw new Error("no RADIATION PATTERNS section");
  const rows = [];
  let started = false;
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    // Drop the RIGHT/LEFT/LINEAR sense token so the rest parse as numbers.
    const nums = l
      .replace(/RIGHT|LEFT|LINEAR/g, " ")
      .trim()
      .split(/\s+/)
      .map(Number);
    const allNum = nums.length >= 8 && !nums.some(Number.isNaN);
    if (allNum) {
      started = true;
      rows.push(nums);
    } else if (started) {
      break; // end of the numeric block
    }
  }
  if (!rows.length) throw new Error("no RADIATION PATTERNS data rows parsed");
  return rows;
}

function maxRelDiff(a, b, label) {
  if (a.length !== b.length)
    throw new Error(
      `${label}: column count differs ${a.length} vs ${b.length}`,
    );
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const denom = Math.max(Math.abs(a[i]), Math.abs(b[i]), 1e-12);
    const rel = Math.abs(a[i] - b[i]) / denom;
    if (rel > worst) worst = rel;
  }
  return worst;
}

// --- correctness ---
console.log(`deck: ${deckPath}`);
const nativeOut = runNative(deck);
const wasmOut = await runNec(deck);

const niParams = parseInputParams(nativeOut);
const wiParams = parseInputParams(wasmOut);
requireFinite(niParams, "native input-params");
requireFinite(wiParams, "wasm input-params");
// Confirm this is the row the deck's EX card asked for, so that parsing some
// other numeric table cannot masquerade as agreement.
const excitation = deck
  .split("\n")
  .find((l) => l.startsWith("EX "))
  ?.trim()
  .split(/\s+/);
if (excitation) {
  const [wantTag, wantSeg] = [Number(excitation[2]), Number(excitation[3])];
  if (niParams[0] !== wantTag || niParams[1] !== wantSeg) {
    throw new Error(
      `parsed input-params row is tag ${niParams[0]} seg ${niParams[1]}, ` +
        `deck excites tag ${wantTag} seg ${wantSeg}`,
    );
  }
}
const ipDiff = maxRelDiff(niParams, wiParams, "input-params");
// Row columns: tag seg Vre Vim Ire Iim Zre Zim Yre Yim P; impedance is 6,7.
console.log(
  `ANTENNA INPUT PARAMETERS impedance native=${niParams[6]} ${niParams[7]}j ` +
    `wasm=${wiParams[6]} ${wiParams[7]}j maxRelDiff(row)=${ipDiff.toExponential(2)}`,
);

const nRad = parseRadiation(nativeOut);
const wRad = parseRadiation(wasmOut);
const sample = [0, 3, 6, 9, 12].filter((i) => i < nRad.length);
if (!sample.length) throw new Error("no radiation rows to compare");
let radWorst = 0;
for (const i of sample) {
  requireFinite(nRad[i], `native rad row ${i}`);
  requireFinite(wRad[i], `wasm rad row ${i}`);
  const d = maxRelDiff(nRad[i], wRad[i], `rad row ${i}`);
  radWorst = Math.max(radWorst, d);
  console.log(
    `RAD row ${i} theta=${nRad[i][0]} phi=${nRad[i][1]} totalGain native=${nRad[i][4]} wasm=${wRad[i][4]} maxRelDiff=${d.toExponential(2)}`,
  );
}

const worst = Math.max(ipDiff, radWorst);
const pass = worst <= REL_TOL;
console.log(
  `overall worst relDiff=${worst.toExponential(2)} tol=${REL_TOL} ${pass ? "PASS" : "FAIL"}`,
);

// --- repeatability + timing ---
let repeatOk = true;
const wasmTimes = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const o = await runNec(deck);
  wasmTimes.push(performance.now() - t0);
  if (o !== wasmOut) {
    repeatOk = false;
    console.log(`repeatability FAIL at run ${i}: output differs`);
  }
}
console.log(
  `repeatability: ${RUNS} sequential wasm calls ${repeatOk ? "identical PASS" : "FAIL"}`,
);

const nativeTimes = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  runNative(deck);
  nativeTimes.push(performance.now() - t0);
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
console.log(
  `ms/run wasm=${mean(wasmTimes).toFixed(1)} (fresh instance per call) native=${mean(nativeTimes).toFixed(1)} over ${RUNS} runs`,
);

process.exit(pass && repeatOk ? 0 : 1);
