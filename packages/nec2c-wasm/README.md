# nec2c-wasm

[nec2c](https://www.qsl.net/5b4az/) 1.3.1 -- Neoklis Kyriazis's (5B4AZ) C
translation of NEC-2 -- compiled to a WebAssembly ES module that runs in Node
(>= 20) and browsers.

No pthreads and no SharedArrayBuffer, so browsers need no COOP/COEP headers.
The `.wasm` is prebuilt and committed, so installing needs no Emscripten.

```sh
npm install nec2c-wasm
```

## Usage

```js
import { runNec } from "nec2c-wasm";

const output = await runNec(deckText); // full text of nec2c's output file
```

`runNec(deckText, options?)` writes the deck to an in-memory filesystem, runs
nec2c against it, and resolves to the output file's text. Building that text
and parsing it back is [`nec2c-deck`](../nec2c-deck)'s job.

The deck is passed through verbatim, so this package supports every card nec2c
reads -- all 34 of them, geometry (`GW`, `GC`, `GX`, `GR`, `GS`, `GE`, `GM`,
`SP`, `SM`, `GA`, `SC`, `GH`, `GF`) and control (`FR`, `LD`, `GN`, `EX`, `NT`,
`TL`, `XQ`, `GD`, `RP`, `NX`, `PT`, `KH`, `NE`, `NH`, `PQ`, `EK`, `CP`, `PL`,
`EN`, `WG`). `nec2c-deck`'s `buildDeck` writes a subset of those, so a model
needing a card it does not emit can still be run here by writing the deck text
yourself. `TODO.md` at the repo root tracks which cards those are.

### Entry points

| import | what it loads |
|---|---|
| `nec2c-wasm` | glue module plus a sibling `nec2c.wasm` (259 KB) |
| `nec2c-wasm/inline` | one file, wasm base64-embedded (361 KB) |

The default resolves `nec2c.wasm` relative to its own URL, which is correct
under Node and any bundler that emits the two files together. Use `/inline` for
bundlers or hosts that will not emit or serve a separate `.wasm`, or pass
`locateFile` to point at it yourself:

```js
await runNec(deck, { locateFile: (path) => `/assets/${path}` });
```

### Errors

A nonzero exit throws `Nec2cError`:

```js
import { Nec2cError, runNec } from "nec2c-wasm";

try {
  await runNec(deck);
} catch (e) {
  if (e instanceof Nec2cError) {
    // exitCode is whatever nec2c returned, e.g. -1 for a bad card or -4 for
    // its internal abort path.
    console.error(e.exitCode, e.output); // "... GEOMETRY DATA CARD ERROR ..."
  }
}
```

nec2c reports most input problems by writing a message into its **output file**
rather than to stderr, so `e.output` is usually where the explanation is;
`e.stdout` and `e.stderr` are frequently both empty on a failed run. The error
also carries `e.deck`, so a failure can be diagnosed without re-running it.

### Known issue: Sommerfeld ground close to earth

nec2c's `GN 2` ground does not converge to a perfect ground plane as
conductivity goes to infinity when the antenna is within about 0.05 wavelengths
of the surface -- a limit it must satisfy, since a lossy half-space becomes a
perfect conductor there. The error reaches +91.9% at 0.02 wavelengths and grows
below that. A ground-mounted vertical, the obvious reason to want finite
ground, sits in exactly that regime.

Refining the mesh does not rescue it: the error holds at about 91% across a
27x range of segment lengths. Only height does.

This is NEC-2's behaviour rather than something nec2c introduced: aegnec2,
which links the original Fortran SOMNEC, reproduces these numbers to three
digits, and the original Fortran NEC-2D segfaults in the same regime. nec2++
does markedly better there. `investigations/sommerfeld.mjs` at the repo root
measures it and takes another solver's command to compare; `TODO.md` has the
figures.

### Performance

A fresh WebAssembly instance is created per call. nec2c keeps extensive
file-scope global state and the module is built with `EXIT_RUNTIME=1`, so
instances cannot be reused -- but the factory is imported once and is cheap to
re-invoke. Expect roughly 3-4x native runtime. Absolute numbers depend on the
machine; `npm run test:parity` reports both for your own.

## Provenance

- Source: nec2c 1.3.1, upstream author Neoklis Kyriazis (5B4AZ),
  <https://www.qsl.net/5b4az/>.
- Obtained from the Debian/Ubuntu source package `nec2c` 1.3.1-3:
  `nec2c_1.3.1.orig.tar.bz2`, md5 `0d86f0ae43679b9e4a3a4e3877ab62f2`.
- `third_party/nec2c/` holds the compiled sources and their documentation from
  that tarball, unmodified. It is a subset, not a copy of the whole tree: the
  `.c`/`.h` files named by `nec2c_SOURCES`, plus `configure.ac`, `Makefile.am`,
  `config.h.in`, `COPYING`, `README`, `AUTHORS`, `ChangeLog` and `NEWS`. The
  generated autotools files, the man page and the pixmaps are not vendored --
  `build.sh` calls `emcc` directly and needs no `./configure` step.
- The Debian packaging adds one patch, `gnome-common-migration.patch`, which
  rewrites `autogen.sh` only and changes no compiled code. It is vendored for
  provenance but is not applied by this build.

## Build

The committed artifacts are byte-for-byte reproducible, but **only against the
pinned toolchain** -- other Emscripten versions produce different (working, but
different) output. `build.sh` pins `EMCC_VERSION` and refuses to run against
anything else.

The prebuilt artifacts are committed, so this is only needed to change them:

```sh
git submodule update --init   # emsdk
npm run build:wasm            # installs/activates the pinned emcc, then compiles
```

Verify against native nec2c (Debian/Ubuntu: `apt install nec2c`):

```sh
npm run test:parity   # numeric parity, repeatability, timing
```

It is a separate script because it needs that external binary; the rest of the
repo's tests do not.

Note that nec2c has a fixed-size filename buffer and aborts on long paths; the
harness keeps its temporary files short for that reason.

## License

GPLv3-or-later. nec2c is GPLv3 and the `.mjs`/`.wasm` artifacts built from it
carry those obligations: the corresponding source is vendored under
`third_party/nec2c/` and ships in the published npm tarball, and `build.sh`
reproduces the artifacts from it.

The artifacts also embed Emscripten's runtime and musl-derived libc, both MIT.
`THIRD-PARTY-NOTICES.md` carries those notices, as MIT requires; the terms are
compatible with the GPL that governs the combination.

Keep `LICENSE`, `THIRD-PARTY-NOTICES.md`, `third_party/nec2c/COPYING`, and this
provenance intact when redistributing.
