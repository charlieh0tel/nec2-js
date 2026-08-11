# nec2pp-wasm

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
import { createSolver } from "nec2pp-wasm";

const solve = await createSolver();
const result = solve({
  wires: [
    { tag: 1, segments: 9, x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 1, radiusM: 0.001 },
  ],
  sources: [{ tag: 1, segment: 5, vReal: 1, vImag: 0 }],
  ground: false,
  freqMhz: 145.9,
  grid: { ntheta: 3, nphi: 2, theta0: 0, phi0: 0, dtheta: 45, dphi: 90, average: 1 },
});

result.sources[0].zReal;        // 75.2571
result.pattern[2].totalGainDb;  // 2.13 at theta 90
result.pattern[2].sense;        // "LINEAR"
result.currents.length;         // 9
result.averagePowerGain;        // 0.97
```

The model is the same shape `nec2c-deck`'s `buildDeck` takes -- `wires`,
`transforms`, `sources`, `loads`, `transmissionLines`, `ground`,
`groundConnected`, `freqMhz`, `grid` -- so one description drives either
engine.

## What you get that a parsed deck cannot give you

- **`averagePowerGain`** -- NEC's average power gain, which stays honest over
  lossy ground. A power budget computed as input minus losses counts what the
  earth absorbs as radiated, so it reads high exactly where finite ground
  matters most. Needs `grid.average` set, and at least two points in each
  angle.
- **Per-direction polarization** -- `axialRatio`, `tiltDeg` and `sense` on
  every pattern point, not only at the peak.
- **Per-segment currents** with tag, segment, centre coordinates and length.
- **No parser fragility.** `nec2c-deck`'s parsers are keyed to nec2c's exact
  column layout; there are no columns here.

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
