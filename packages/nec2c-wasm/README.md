# nec2c-wasm

[nec2c](https://www.qsl.net/5b4az/) 1.3.2 -- Neoklis Kyriazis's (5B4AZ) C
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

### Limitation: `GN 2` close to ground

**`GN 2` is not trustworthy within about 0.05 wavelengths of the surface.**
The feedpoint resistance is roughly 92% out at 0.02 wavelengths and worse
below, and refining the mesh does not help -- only height does. A
ground-mounted vertical sits inside that regime.

This is NEC-2's method rather than a defect in nec2c. Use
[`necpp-wasm`](../necpp-wasm) there: nec2++ holds to roughly 0.01
wavelengths. Above 0.05 wavelengths both meet every check made here, and
`test/average-power-gain.test.mjs` asserts one of them.

### Performance

A fresh WebAssembly instance is created per call. nec2c keeps extensive
file-scope global state and the module is built with `EXIT_RUNTIME=1`, so
instances cannot be reused -- but the factory is imported once and is cheap to
re-invoke. Expect roughly 3-4x native runtime. Absolute numbers depend on the
machine; `npm run test:parity` reports both for your own.

## Provenance

- Source: nec2c, upstream author Neoklis Kyriazis (5B4AZ),
  <https://www.qsl.net/5b4az/>. Maintained in git at
  <https://github.com/KJ7LNW/nec2c>.
- `third_party/nec2c` is a submodule pinned to the **`v1.3.2`** tag, commit
  `265b181`. Pinning a commit rather than vendoring files is what
  `necpp-wasm` does too, so both solvers are tracked the same way.
- `build.sh` compiles the `.c` files named by `nec2c_SOURCES` and needs no
  `./configure` step: `PACKAGE_STRING` is the only generated macro the code
  reads, and it is supplied on the command line.

### The carried patch

`patches/0001-line-buf-off-by-one.patch` fixes a one-byte stack overflow.
`load_line()` fills a caller's buffer with `while (num_chr < LINE_LEN)` and
then terminates it with `buff[num_chr]`, so a line that fills the buffer
writes one past the end of `main()`'s `char line_buf[LINE_LEN]`. The patch
gives the buffer one more byte; `build.sh` applies it to a staged copy so the
submodule checkout stays pristine.

It does not crash without a sanitizer -- `main()`'s `infile[81]` and
`otfile[81]` sit next to `line_buf` and absorb the stray byte -- and the
exposure is bounded, since each run gets a fresh WebAssembly instance. It is
still an out-of-bounds write on ordinary input.

Reported as [KJ7LNW/nec2c#2](https://github.com/KJ7LNW/nec2c/issues/2). Drop
the patch once the pin moves past a release carrying the fix.

Debian's `nec2c` 1.3.1-3 carries a worse form of the same bug -- `line_buf` is
declared `[81]` there, so the overflow is up to 52 bytes -- which is one reason
this package builds from upstream git rather than the Debian tarball.

## Build

The committed artifacts are byte-for-byte reproducible, but **only against the
pinned toolchain** -- other Emscripten versions produce different (working, but
different) output. `build.sh` pins `EMCC_VERSION` and refuses to run against
anything else.

The prebuilt artifacts are committed, so this is only needed to change them:

```sh
git submodule update --init   # emsdk and third_party/nec2c
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
carry those obligations: the corresponding source is the `third_party/nec2c`
submodule, pinned to an exact commit and shipped in the published npm tarball,
and `build.sh` reproduces the artifacts from it.

The artifacts also embed Emscripten's runtime and musl-derived libc, both MIT.
`THIRD-PARTY-NOTICES.md` carries those notices, as MIT requires; the terms are
compatible with the GPL that governs the combination.

Keep `LICENSE`, `THIRD-PARTY-NOTICES.md`, `third_party/nec2c/COPYING`, and this
provenance intact when redistributing.
