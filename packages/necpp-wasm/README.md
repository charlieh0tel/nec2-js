# necpp-wasm

[nec2++](https://github.com/tmolteno/necpp) -- Tim Molteno's C++ rewrite of
NEC-2 -- compiled to a WebAssembly ES module that runs in Node (>= 20) and
browsers.

Unlike the sibling [`nec2c-wasm`](../nec2c-wasm), **nothing here is text**.
nec2++ is driven through its C++ API and hands back numbers, so there is no
deck to format and no output to parse.

No pthreads and no SharedArrayBuffer, so browsers need no COOP/COEP headers.
The `.wasm` is prebuilt and committed, so installing needs no Emscripten.

## Usage

```js
import { solve } from "necpp-wasm";

const result = await solve({
  wires: [{ tag: 1, segments: 9, from: [0, 0, 0], to: [0, 0, 1], radiusM: 0.001 }],
  sources: [{ kind: "voltage", tag: 1, segment: 5, volts: { re: 1, im: 0 } }],
  ground: false,
  freqMhz: 145.9,
  grid: { ntheta: 3, nphi: 2, theta0: 0, phi0: 0, dtheta: 45, dphi: 90, average: 1 },
});

result.feeds[0].impedance;      // { re: 75.2571, im: 16.9006 }
result.feeds[0].current;        // { re, im }, and .voltage, .powerW
result.pattern[2].totalGainDb;  // 2.13 at theta 90
result.pattern[2].sense;        // "LINEAR"
result.gain.maxDb;              // and minDb, meanDb, sdDb
result.averagePowerGain;        // 0.97
```

The API follows nec2++'s own shape and units, adding JavaScript idiom rather
than a different model: complex values are `{re, im}`, points are
`[x, y, z]`, and a mode is a string rather than an integer code.

**Units are nec2++'s, and they are not uniform.** Geometry is declared in
metres, but results come back in wavelengths, because that is what nec2++
solves in. Every value carrying a unit says which one in its name --
`radiusM` going in, `atWavelengths` and `lengthWavelengths` coming back.

### Building a structure step by step

`solve()` is a convenience over a context, which mirrors nec2++'s own shape --
describe, then solve, then read -- and is what you want when a model is
assembled conditionally or solved more than once:

```js
import { createContext } from "necpp-wasm";

const nec = await createContext();
try {
  nec.wire({ tag: 1, segments: 9, from: [0, 0, 0], to: [0, 0, 1], radiusM: 1e-3 })
     .transform({ rotZDeg: 45, copies: 7, tagIncrement: 1 })
     .finishGeometry({ ground: { epsR: 13, sigmaSm: 0.005 } })
     .frequency(145.9)
     .excite({ kind: "voltage", tag: 1, segment: 5, volts: { re: 1 } })
     .load({ kind: "conductivity", tag: 0, sigmaSm: 5.8e7 });
  const result = nec.solvePattern({ ntheta: 19, nphi: 4, dtheta: 5, dphi: 90 });
} finally {
  nec.dispose();
}
```

`dispose()` is not optional: a bound object holds a wasm heap pointer, so
dropping the JS reference leaks what it points at. The context also implements
`Symbol.dispose`, so `using` works where it is supported.

### What can be described

Geometry: `wire`, `arc`, `helix`, `transform` (GM), `reflect` (GX).
Environment: `finishGeometry` (GE/GN, including radial screens),
`frequency`, `interactionDistance` (KH), `extendedThinWireKernel` (EK).
Excitation: applied voltage, current-slope discontinuity, an elementary
current source, and incident plane waves -- linear or either circular sense,
which is how a receiving antenna or a radar cross section is modelled.
Loading: `load` in all six NEC forms. Networks: `transmissionLine` and the
general two-port `network` (NT).

## What you get that a parsed deck cannot give you

- **`averagePowerGain`** -- NEC's average power gain, which stays honest over
  lossy ground. A power budget computed as input minus losses counts what the
  earth absorbs as radiated, so it reads high exactly where finite ground
  matters most. Needs `grid.average` set, and at least two points in each
  angle.
- **Per-direction polarization** -- `axialRatio`, `tiltDeg` and `sense` on
  every pattern point, not only at the peak.
- **Per-segment currents** with tag, segment, and the centre and length in wavelengths.
- **Feed current, voltage and power**, not just impedance. These come from
  nec2++'s antenna-input result rather than its C API, which has only the
  impedance.
- **No parser fragility.** `nec2c-deck`'s parsers are keyed to nec2c's exact
  column layout; there are no columns here.

Writing a deck out from the same description is not implemented; it would be
useful for feeding other NEC tools, and the model carries everything a deck
needs.

### The grid's option digits

NEC's `RP` card packs its options into the `XNDA` digits. nec2++ takes them
separately, so the grid does too: `axes` (X), `normalization` (N), `gain` (D)
and `average` (A), each defaulting to 0. There is no packed `1000`-style code.

## Errors

nec2++ signals problems by throwing, and the binding converts those into JS
`Error`s carrying nec2++'s own message. A model NEC rejects therefore throws
rather than returning an empty result.

## Build

The committed artifacts are only reproducible against the **pinned toolchain**
(emcc 6.0.3) and the **pinned submodule commit**. `build.sh` refuses to run
against a different emcc.

```sh
git submodule update --init   # emsdk and third_party/necpp
npm run build:wasm
```

`build.sh` calls `emcc` directly rather than using nec2++'s own CMake wasm
target, for two reasons. That target builds `src/nec_wasm.cpp`, which is a stub
whose `nec_process_input()` ignores its argument and reads `stdin`. And it does
not pass `-fexceptions`.

**`-fexceptions` is not optional, and it is needed at compile time, not only at
link.** nec2++ uses exceptions for ordinary control flow: `nec_context` ends a
single-frequency run by throwing to unwind to the card-input loop. Built
without exception support the matching `catch` is elided, so every *completed*
solve escapes the module as an uncaught error. Setting the flag only at link
cannot restore a `catch` already dropped from the objects. The symptom is
confusing -- every setup call succeeds and only the solve appears to fail.

## Vendoring

nec2++ is a `third_party/necpp` submodule pinned to an exact commit, not a
vendored tarball. That differs from `nec2c-wasm`, which pins a frozen Debian
release by checksum and vendors it unmodified -- nec2c 1.3.1 has not moved
since 2004, while nec2++ ships releases regularly. The submodule is carried
unpatched; everything this package needs is supplied by `build.sh`, including
the small generated `config.h` that CMake would otherwise write.

The `config.h` build date is taken from the pinned commit rather than the
clock, so rebuilding the same commit produces the same bytes.

## License

GPLv3-or-later. nec2++ is GPL-2-or-later, which permits the combination; the
corresponding source ships in the published tarball, and `build.sh` reproduces
the artifacts from it. The artifacts also embed Eigen (MPL-2.0) and
Emscripten's runtime and musl-derived libc (MIT). See
`THIRD-PARTY-NOTICES.md`.

Keep `LICENSE`, `THIRD-PARTY-NOTICES.md`, `third_party/necpp/COPYING`, and this
provenance intact when redistributing.
