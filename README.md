# nec2c-js

NEC-2 antenna modeling for JavaScript, in two independent pieces:

| package | what it is | needs |
|---|---|---|
| [`nec2c-wasm`](packages/nec2c-wasm) | nec2c 1.3.1 compiled to WebAssembly. Runs in Node and browsers. | nothing |
| [`nec2c-deck`](packages/nec2c-deck) | Builds NEC-2 input decks, parses nec2c output. No solver. | nothing |

They are deliberately separable. `nec2c-deck` has no dependency on the solver --
it defines a `NecRunner` function type and lets you supply one -- so you can
drive a native `nec2c` binary from Node without pulling in a 259 KB `.wasm`, or
use the WebAssembly build without the deck helpers.

```js
import { buildDeck, parseOutput } from "nec2c-deck";
import { runNec } from "nec2c-wasm";

const deck = buildDeck(["dipole"], wires, sources, false, 145.9, grid);
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
