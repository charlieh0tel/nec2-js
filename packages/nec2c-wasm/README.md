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
nec2c against it, and resolves to the output file's text. Parsing that text is
[`nec2c-deck`](../nec2c-deck)'s job.

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
    console.error(e.exitCode, e.output); // -1, "... GEOMETRY DATA CARD ERROR ..."
  }
}
```

nec2c reports most input problems by writing a message into its **output file**
rather than to stderr, so `e.output` is usually where the explanation is;
`e.stdout` and `e.stderr` are frequently both empty on a failed run. The error
also carries `e.deck`, so a failure can be diagnosed without re-running it.

### Performance

A fresh WebAssembly instance is created per call. nec2c keeps extensive
file-scope global state and the module is built with `EXIT_RUNTIME=1`, so
instances cannot be reused -- but the factory is imported once and is cheap to
re-invoke. Expect roughly 3-4x native runtime; the fixture deck runs in about
8 ms against 2 ms native. Sequential calls are verified identical.

## Provenance

- Source: nec2c 1.3.1, upstream author Neoklis Kyriazis (5B4AZ),
  <https://www.qsl.net/5b4az/>.
- Obtained from the Debian/Ubuntu source package `nec2c` 1.3.1-3:
  `nec2c_1.3.1.orig.tar.bz2`, md5 `0d86f0ae43679b9e4a3a4e3877ab62f2`.
- `third_party/nec2c/` holds the **pristine upstream 1.3.1 sources** from that
  tarball, unmodified.
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
reproduces the artifacts from it. Keep `LICENSE`, `third_party/nec2c/COPYING`,
and this provenance intact when redistributing.
