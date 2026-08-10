# nec2c-deck

Builds NEC-2 input decks and parses [nec2c](https://www.qsl.net/5b4az/) output.
Zero dependencies, no solver, no I/O -- text in, text out.

```sh
npm install nec2c-deck
```

## Usage

```js
import { buildDeck, parseOutput } from "nec2c-deck";

const deck = buildDeck(
  ["a vertical dipole"],
  [{ tag: 1, segments: 9, x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 1, radiusM: 0.001 }],
  [{ tag: 1, segment: 5, vReal: 1, vImag: 0 }],
  false,                                                   // ground
  145.9,                                                   // MHz
  { ntheta: 3, nphi: 1, theta0: 0, phi0: 0, dtheta: 30, dphi: 0 },
);

const result = parseOutput(await someRunner(deck));
result.sources[0].zReal;   // 75.25
result.pattern[0].totalGainDb;
```

Supplying the solver is your problem, deliberately: the package exports a
`NecRunner = (deck: string) => Promise<string>` type and nothing that runs.
Use [`nec2c-wasm`](../nec2c-wasm), or shell out to a native `nec2c` binary.

## What it covers

`buildDeck` emits the cards this was written for: `CM`/`CE`, `GW`, `GE`, `GN`,
`EK`, `TL`, `EX`, `FR`, `RP`, `EN` -- one frequency, one radiation-pattern
block, perfect ground when grounded. That is a working subset of NEC-2, not all
of it; there is no `LD`, `GM`, `GS`, or `NT`.

`parseOutput` reads the `ANTENNA INPUT PARAMETERS`, `CURRENTS AND LOCATION`,
and `RADIATION PATTERNS` sections into `sources`, `currents`, and `pattern`.

It parses **one set of results per call**. nec2c emits a full set of sections
per frequency step and per `RP` card, and `NecResult` has nowhere to record
which frequency a row belongs to, so output holding more than one set is
rejected rather than silently reduced to one. Sweep by running one frequency
per deck.

It also throws rather than guessing: a malformed row inside a section, or a
non-finite number from a diverged solve, is an error, not a `NaN` field.

At a pattern null nec2c prints no polarization sense, and `sense` is
`"UNDEFINED"` there -- the axial ratio on such a row is not a measurement of
anything.

**Portability caveat.** The deck writer emits standard NEC-2 cards, but the
parsers are keyed to nec2c's exact column layout and will not read output from
other NEC implementations. Hence the package name.

## Formats

Both compiled JavaScript and TypeScript source ship:

| import | what you get |
|---|---|
| `nec2c-deck` | `dist/` -- compiled ES2022 with `.d.ts` and source maps |
| `nec2c-deck/source` | `src/index.ts` -- raw TypeScript, for bundlers that prefer it |

## License

GPLv3-or-later; see `LICENSE`. This package contains no nec2c code -- the card
formats come from the NEC-2 documentation and the parsers from nec2c's output
-- but it is distributed under the same terms as its sibling.
