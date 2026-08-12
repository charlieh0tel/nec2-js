# nec2-js

NEC-2 antenna modeling for JavaScript, in three independent packages:

| package | what it is | needs |
|---|---|---|
| [`nec2c-wasm`](packages/nec2c-wasm) | nec2c 1.3.2 compiled to WebAssembly. Deck text in, output text out. | nothing |
| [`nec2c-deck`](packages/nec2c-deck) | Builds NEC-2 decks, parses nec2c output. No solver. | nothing |
| [`necpp-wasm`](packages/necpp-wasm) | nec2++ compiled to WebAssembly, driven through its C++ API. No text. | nothing |

Two solvers, reached differently. `nec2c-wasm` runs decks and hands back the
report, so `nec2c-deck` writes the one and parses the other. `necpp-wasm`
needs neither: nec2++ has an API, so a model goes in and numbers come out.

`nec2c-deck` has no dependency on a solver -- it defines a `NecRunner`
function type and lets you supply one -- so you can drive a native `nec2c`
binary from Node without pulling in a 259 KB `.wasm`.

**Which solver?** `necpp-wasm` if you are modelling anything within about
0.05 wavelengths of ground, where NEC-2's Sommerfeld evaluation stops meeting
closed-form limits; see
[`nec2c-wasm`'s README](packages/nec2c-wasm#limitation-gn-2-ground-below-about-005-wavelengths).
`nec2c-wasm` if you want decks, the smaller artifact, or the reference
implementation.

```js
import { buildDeck, parseOutput } from "nec2c-deck";
import { runNec } from "nec2c-wasm";

const deck = buildDeck({
  comments: ["dipole"],
  wires,
  sources,
  ground: false,
  freqMhz: 145.9,
  grid,
});
const result = parseOutput(await runNec(deck));
console.log(result.sources[0].zReal); // 75.25
```

No pthreads and no SharedArrayBuffer, so browsers need no COOP/COEP headers.

## License

GPLv3-or-later, both packages. nec2c is Neoklis Kyriazis's (5B4AZ) work and is
GPLv3; the WebAssembly artifacts built from it carry those obligations, so the
corresponding C source is vendored in `packages/nec2c-wasm/third_party/nec2c/`
and ships in the published tarball. See each package's README for details.

## Origin

Both packages were extracted from
[charlieh0tel/tamago](https://github.com/charlieh0tel/tamago), an eggbeater
antenna designer, where they had grown general enough to stand on their own.
