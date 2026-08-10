# nec2c-deck

Builds NEC-2 input decks and parses [nec2c](https://www.qsl.net/5b4az/) output.
Zero dependencies, no solver, no I/O -- text in, text out.

```sh
npm install nec2c-deck
```

## Usage

```js
import { buildDeck, parseOutput } from "nec2c-deck";

const deck = buildDeck({
  comments: ["a vertical dipole"],
  wires: [
    { tag: 1, segments: 9, x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 1, radiusM: 0.001 },
  ],
  sources: [{ tag: 1, segment: 5, vReal: 1, vImag: 0 }],
  ground: false,
  freqMhz: 145.9,
  grid: { ntheta: 3, nphi: 1, theta0: 0, phi0: 0, dtheta: 30, dphi: 0 },
});

const result = parseOutput(await someRunner(deck));
result.sources[0].zReal;   // 75.25
result.pattern[0].totalGainDb;
```

`comments`, `wires`, `sources`, `ground`, `freqMhz` and `grid` are required;
`transforms`, `loads`, `transmissionLines` and `groundConnected` are optional.

Supplying the solver is your problem, deliberately: the package exports a
`NecRunner = (deck: string) => Promise<string>` type and nothing that runs.
Use [`nec2c-wasm`](../nec2c-wasm), or shell out to a native `nec2c` binary.

## What it covers

`buildDeck` emits `CM`/`CE`, `GW`, `GM`, `GE`, `GN`, `EK`, `LD`, `TL`, `EX`,
`FR`, `RP`, `EN` -- one frequency and one radiation-pattern block.

That is a working subset of NEC-2, not all of it. Not emitted: the remaining
geometry cards (`GA` arc, `GH` helix, `GC` tapered wire, `GX`/`GR` symmetry,
`GS` scale, `GF`), surface patches (`SP`/`SM`/`SC`), networks (`NT`), the
second ground medium (`GD`), the interaction-approximation distance (`KH`),
near fields (`NE`/`NH`), and the print and execution controls (`XQ`, `PT`,
`PQ`, `PL`, `NX`, `CP`, `WG`).

`GM` cards are emitted after every `GW`, so a transform acts on the whole
structure or, via `fromTag`, on a tail of it. Interleaving geometry and
transforms freely is not expressible; define the part you want to replicate
last.

`EX` is written as type 0 only, an applied-voltage source. Plane-wave
incidence (types 1-3) and the elementary current source (type 4) would let you
model a receiving antenna or compute radar cross-section, and are not
supported; they also print sections the parsers do not read.

`FR` is always one frequency, linear stepping. Sweep by running one deck per
frequency -- `parseOutput` handles one set of results per call.

### Ground

`ground` takes three forms:

```js
buildDeck({ ...rest, ground: false });                        // free space
buildDeck({ ...rest, ground: true });                         // perfect conductor
buildDeck({ ...rest, ground: { epsR: 13, sigmaSm: 0.005 } }); // real earth
```

`epsR` is the relative permittivity and `sigmaSm` the conductivity in siemens
per metre; typical values are 13 and 0.005 for average ground, 5 and 0.001 for
poor, 81 and 5 for sea water.

Constants default to a Sommerfeld/Norton `GN 2` card -- slower to solve than a
perfect ground, and the accurate treatment for an antenna within a wavelength
or so of earth. `method: "reflection"` selects the faster Fresnel
reflection-coefficient approximation (`GN 0`) instead, which degrades close to
ground.

A buried radial-wire screen goes under `radials`. NEC models it as a surface
impedance rather than as wires, so it costs nothing in matrix size, but it only
exists for the reflection-coefficient ground -- asking for one implies
`method: "reflection"`, and pairing it with Sommerfeld is an error rather than
the bare `stop(-1)` nec2c would give you.

```js
ground: {
  epsR: 13,
  sigmaSm: 0.005,
  radials: { count: 32, screenRadiusM: 5, wireRadiusM: 0.0008 },
}
```

### Connecting to ground

`groundConnected: true` emits `GE 1`, telling NEC that wires touch the ground
plane and their currents continue onto the ground image. A ground-mounted
vertical fed against earth needs it; without it the base segment floats and the
feedpoint is meaningless. The default `GE -1` is for an antenna that sits above
ground without touching it. It is an error in free space.

### Loading

`loads` emits `LD` cards. `kind` picks how NEC turns the values into a segment
impedance:

| kind | fields | meaning |
|---|---|---|
| `series`, `parallel` | `resistanceOhm`, `inductanceH`, `capacitanceF` | lumped R-L-C across the segment |
| `seriesPerMeter`, `parallelPerMeter` | same | the same network per unit length, scaled by each segment |
| `impedance` | `resistanceOhm`, `reactanceOhm` | a fixed, frequency-independent R + jX |
| `conductivity` | `sigmaSm` | the wire's own metal |

`conductivity` is the one that turns a lossless model into a real one -- copper
is `5.8e7` -- and NEC computes the frequency-dependent skin-effect surface
impedance from it and the wire radius.

```js
loads: [
  { kind: "conductivity", tag: 0, sigmaSm: 5.8e7 },       // whole structure
  { kind: "impedance", tag: 1, fromSegment: 5, resistanceOhm: 50, reactanceOhm: -20 },
]
```

`tag` selects a wire; `tag: 0` addresses the structure as a whole. With a
nonzero tag, `fromSegment`/`toSegment` count segments within that tag; with tag
0 they are absolute segment numbers. Omit both to load every segment of the
tag. Load values are written in `E` notation, because a 5 pF capacitance is
`5e-12` farads and NEC reads a zero `C` as "leave the capacitor out" rather
than as the value you asked for.

### Moving and replicating geometry

`transforms` emits `GM` cards, applied after every wire is defined:

```js
// Four wires 0.5 m apart, tagged 1 through 4.
transforms: [{ copies: 3, tagIncrement: 1, moveXM: 0.5 }]
// One wire swung around the z axis into an eight-way star.
transforms: [{ copies: 7, tagIncrement: 1, rotZDeg: 45 }]
```

`rotXDeg`/`rotYDeg`/`rotZDeg` rotate (X first, then Y, then Z),
`moveXM`/`moveYM`/`moveZM` translate afterwards, and every field defaults to a
no-op. `copies: 0` (the default) moves the structure in place instead of
copying it; with more, the transform is reapplied to the last copy each time,
so 45 degrees and 7 copies sweeps a full circle. `tagIncrement` is added to
every tag on each copy, which is what keeps the copies addressable by a later
`EX` or `LD`. `fromTag` restricts the transform to that tag and everything
defined after it, so replicating part of a model means defining that part last.

`parseOutput` reads the `ANTENNA INPUT PARAMETERS`, `CURRENTS AND LOCATION`,
`RADIATION PATTERNS` and `POWER BUDGET` sections into `sources`, `currents`,
`pattern` and `power`.

### Power and efficiency

`power` carries `inputW`, `radiatedW`, `structureLossW`, `networkLossW` and
`efficiencyPercent`. It is `undefined` when nec2c printed no budget, which it
does only for a voltage source -- the only `EX` type this package writes, so in
practice it is always there.

nec2c does not measure the radiated power. It subtracts the structure and
network losses from the input power, and the efficiency is that quotient. The
number therefore answers "how much of the power I put in did the wires and
networks fail to burn", which is the radiating efficiency only when nothing
else absorbs. **Over a lossy `GN` ground it reads high**: the power the earth
absorbs appears in neither loss term, so it is still counted as radiated. NEC's
average power gain (the `RP` card's `A` digit) is the honest figure there.

Pair it with a `conductivity` load, which is what gives `structureLossW`
anything to report:

```js
const { power } = parseOutput(await runNec(buildDeck({
  ...rest,
  loads: [{ kind: "conductivity", tag: 0, sigmaSm: 5.8e7 }],
})));
power.efficiencyPercent;   // copper losses, as a percentage
```

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

**RP modes.** `parseOutput` reads far-field patterns. The column positions hold
for every far-field `RP` mode, so `grid.optionCode` can carry any `XNDA` code
you like (the default is 1000) -- but the code changes what two columns *mean*
without moving them: the gain pair is major/minor axis or vertical/horizontal
(the `X` digit), and the total is a power gain or a directive gain (`D`). Both
arrive as `totalGainDb`, so you have to know which you asked for. A near-field
run (`RP 1`) prints a different section entirely and is rejected.

**Transmission-line length.** `lengthM` is the electrical length at the
free-space wavelength, so `wavelength / 4` is a 90 degree line whatever a real
coax's velocity factor would be. Pass `TL_LENGTH_FROM_GEOMETRY` to let NEC use
the straight-line distance between the two segment centres instead; a numeric
length that would round to zero is still refused, so a computed length cannot
turn into that sentinel by accident. The card's shunt-admittance fields are not
written.

## Formats

`import "nec2c-deck"` gives you `dist/` -- compiled ES2022 with `.d.ts` and
source maps.

The TypeScript sources ship in the package too, under `src/`, and the manifest
points at them through the conventional `source` field for bundlers that
compile dependencies themselves. There is deliberately no `nec2c-deck/source`
entry point: Node refuses to strip types under `node_modules`, so importing raw
`.ts` from an installed package fails outright.

## License

GPLv3-or-later; see `LICENSE`. This package contains no nec2c code -- the card
formats come from the NEC-2 documentation and the parsers from nec2c's output
-- but it is distributed under the same terms as its sibling.
