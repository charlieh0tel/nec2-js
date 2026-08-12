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

### Known issue: `GN 2` ground below about 0.05 wavelengths

Within roughly 0.05 wavelengths of the surface, `GN 2` results are not
trustworthy. Above that height it meets every check made of it here, so this is
a bad regime rather than a bad ground model -- but a ground-mounted vertical,
the obvious reason to want finite ground, sits squarely inside it.

Two independent measurements, each against a closed-form answer:

- **The conducting limit.** As conductivity rises a lossy half-space becomes a
  perfect conductor, so `GN 2` must approach `GN 1`. Below 0.05 wavelengths it
  does not: the feedpoint resistance is +91.9% out at 0.02 wavelengths, and
  worse lower down. Refining the mesh does not help -- the error holds across a
  27x range of segment lengths. Only height does.
- **Energy.** Average power gain over the upper hemisphere is exactly 2 for a
  lossless antenna over a perfect conductor. At 0.01 wavelengths, over a ground
  conductive enough to be one, nec2c reports 42.8.

This is NEC-2's behaviour rather than something nec2c introduced: aegnec2,
which links the original Fortran SOMNEC, reproduces these numbers to three
digits; a tip-of-tree nec2c matches the pinned 1.3.2; and the original
Fortran NEC-2D segfaults in the same regime. nec2++ pushes the floor down about
five-fold, to roughly 0.01 wavelengths, and then fails the same way below that.

Take all of this as a bench observation from one geometry, not an expert
assessment of the method: it says where these engines stop meeting limits they
should meet, not why, and not that any of them is right about real soil.
`TODO.md` has the figures. `test/average-power-gain.test.mjs` keeps the
energy check as a test, at heights where the method is sound -- it asserts
what must be true rather than pinning what is currently wrong.

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
  `nec2pp-wasm` does too, so both solvers are tracked the same way.
- `build.sh` compiles the `.c` files named by `nec2c_SOURCES` and needs no
  `./configure` step: `PACKAGE_STRING` is the only generated macro the code
  reads, and it is supplied on the command line.

### Why not the Debian tarball

Earlier versions of this package vendored the sources from Debian's `nec2c`
1.3.1-3 (`nec2c_1.3.1.orig.tar.bz2`, md5
`0d86f0ae43679b9e4a3a4e3877ab62f2`) and claimed they were upstream unmodified.
They were not quite, and the difference mattered.

That tree declares `char line_buf[81]` in `main()`, while `nec2c.h` defines
`LINE_LEN` as 132 and `misc.c`'s `load_line()` fills a caller's buffer with
`while (num_chr < LINE_LEN)`. **A deck line longer than 81 characters
overflowed that stack buffer by up to 52 bytes**, confirmed under
AddressSanitizer:

```
ERROR: AddressSanitizer: stack-buffer-overflow
  #0 load_line  misc.c:154
  #1 main       main.c:269
[1920, 2001) 'line_buf' (line 41) <== Memory access at offset 2001 overflows this
```

It does not usually crash, which is why it went unnoticed: `main()`'s
`infile[81]` and `otfile[81]` sit next to `line_buf`, so the stray bytes land
in those rather than on the stack canary.

Upstream widened the buffer to `LINE_LEN` in `3d8c230` before tagging
`v1.3.1`. **That reduced the overflow but did not remove it.** `load_line()`
terminates with `buff[num_chr]`, and `num_chr` equals `LINE_LEN` once the line
fills the buffer, so `char[LINE_LEN]` is still one byte short -- ASan reports
the same finding against `v1.3.2` at offset 2292 of a `[2160, 2292)` buffer.

`patches/0001-line-buf-off-by-one.patch` gives the buffer one more byte, and
`build.sh` applies it to a staged copy so the submodule checkout stays
pristine. With it, ASan is clean and an over-long line is rejected rather than
corrupting the stack. Reported upstream; drop the patch once the pin moves
past a release that carries the fix.

The exposure here was always bounded -- each run gets a fresh WebAssembly
instance, so a corrupted stack cannot outlive the call or reach the host --
but it was memory corruption on ordinary input.

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
