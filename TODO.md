# TODO

What `nec2c-deck` does not yet cover. nec2c reads 34 cards (`main.c:47`,
`geometry.c:544`); `buildDeck` emits 12 of them: `CM`/`CE`, `GW`, `GM`, `GE`,
`GN`, `EK`, `LD`, `TL`, `EX`, `FR`, `RP`, `EN`.

Nothing here is a defect. This is the inventory of what a deck cannot say yet,
roughly in the order it would be worth adding.

## Cards not emitted

### Worth adding

- [ ] `NT` -- nonradiating network. The general two-port that `TL` is a special
      case of: matching networks, hybrids, couplers.
- [ ] `KH` -- interaction approximation distance. The standard runtime knob on
      large structures; nothing else here trades accuracy for speed.
- [ ] `GX` / `GR` -- reflection and cylindrical symmetry. Large speedups on
      symmetric models, since NEC solves one sector and reuses it.
- [ ] `GD` -- second ground medium (a cliff or shoreline), plus the `GN`
      fields that go with it (`epsr2`, `sig2`, `clt`, `cht`).
- [ ] `GC` -- tapered wire. Already referenced by the code: a zero `GW` radius
      means "a `GC` follows", which is why `f6nonzero` guards that field.
- [ ] `GA` arc and `GH` helix. Convenience, but a helix is painful to write as
      straight wires.

### Lower priority

- [ ] `GS` -- scale. The caller can multiply its own coordinates.
- [ ] `SP` / `SM` / `SC` -- surface patches. No patch support at all, so no
      solid-surface modelling. A large piece of work: patches change the
      geometry model, not just the card set.
- [ ] `GF` -- numerical Green's function.
- [ ] `NE` / `NH` -- near fields. Needs parser work too; the output is a
      different section, currently rejected by name.
- [ ] `XQ`, `PT`, `PQ`, `PL`, `NX`, `CP`, `WG` -- print and execution
      controls, mostly irrelevant to the fixed one-run shape of a deck.

## Partial coverage inside cards that are emitted

- [ ] `EX` types 1-4 -- plane-wave incidence (1-3) and the elementary current
      source (4). These are how you model a receiving antenna or compute radar
      cross-section. They also print sections the parsers do not read, and
      suppress the `POWER BUDGET`, so this is a parser change as much as a card
      change.
- [ ] `EX` type 5 -- current-slope-discontinuity source.
- [ ] `EX` `I4` and `F3` -- `masym` (admittance-matrix asymmetry check) and
      `iped`/`zpnorm` (impedance normalization), both hardcoded to 0.
- [ ] `FR` -- always one frequency, linear stepping. No multi-step or
      logarithmic sweep. Blocked on `parseOutput`, which handles one set of
      results per call by design; a sweep needs a result shape that records
      which frequency each row belongs to.
- [ ] `GN -1` -- nullify a previous ground. Meaningless in a single-run deck.
- [ ] `TL` shunt admittances (`F3`..`F6`) -- always zero, an unloaded line.
- [ ] `RP` -- one card per deck, far field only (mode 0). `F5`/`F6` (radial
      distance, gain normalization) not written. `grid.optionCode` can carry
      any `XNDA` code, but the `N` and `A` digits add output the parsers skip.
- [ ] `EK` -- emitted unconditionally with no field. `EK -1` restores the thin-
      wire kernel.
- [ ] `GM` cards are emitted after every `GW`, so a transform acts on the whole
      structure or, via `fromTag`, on a tail of it. Interleaving geometry and
      transforms freely -- replicate one element, *then* add more wires -- is
      not expressible. See "Interleaving GM with GW" below.

## Parser gaps

`parseOutput` reads `ANTENNA INPUT PARAMETERS`, `CURRENTS AND LOCATION`,
`RADIATION PATTERNS` and `POWER BUDGET`.

- [ ] Average power gain -- the `RP` card's `A` digit. This is the honest
      efficiency figure over a lossy ground, where the power budget reads high
      because the earth's absorbed share counts as radiated.
- [ ] `STRUCTURE IMPEDANCE LOADING` -- echoes back what each `LD` card did.
- [ ] Network and transmission-line port data.
- [ ] `SEGMENTATION DATA` -- would let a caller check its own segmentation
      against what NEC actually built.
- [ ] Normalized gain block (`RP` `N` digit).

## Open questions

### Interleaving GM with GW

Not worth doing until something needs it -- `fromTag` already covers
replicating a suffix of the structure, which is most real cases. If it does
come up, the options are:

- **A. Ordered geometry list.** `geometry: (Wire | Transform)[]` replaces
  `wires` and `transforms`. Mirrors what NEC actually does, since a card acts
  on the structure built so far, and leaves nothing inexpressible. Costs a
  breaking change and a discriminant field on both types: a bare `Wire` and a
  bare `Transform` are not distinguishable by shape in a way worth relying on.
- **B. Insertion point per transform.** Keep both arrays and add `afterTag` to
  `Transform`; `buildDeck` emits each `GM` after the last `GW` carrying that
  tag. Non-breaking and small, but it puts an implicit ordering relationship
  between two arrays, which reads fine and behaves surprisingly.
- **C. Geometry blocks.** `geometry: { wires: Wire[]; transforms?: Transform[]
  }[]`, each block being "some wires, then the transforms acting on them".
  Models the real idiom -- build an element, replicate it, build the next --
  and makes a transform's scope visible in the nesting. Breaking, and it forces
  a block structure on models that do not want one.

A is preferred: it is the one that cannot back you into a corner, and the
discriminant is a small price. B is tempting for being non-breaking, but
ordering encoded across two arrays is the kind of thing that passes review and
then bites.

### nec2c's Sommerfeld ground looks wrong close to earth

`investigations/sommerfeld.mjs` measures the one thing about a finite ground
that needs no judgement: as conductivity goes to infinity a lossy half-space
becomes a perfect conductor, so `GN 2` must converge to the `GN 1` answer for
the same geometry. Run it with no arguments for the bundled wasm nec2c, or pass
a solver command to compare another implementation.

nec2c converges exactly at and above 0.05 wavelengths of height, and fails
below it -- +91.9% at 0.02wl, and worse further down. Independently, a
ground-mounted vertical over soil disagreed with nec2++ by 29.6% where the two
agreed to 0.01% over perfect ground, which puts the fault in the Sommerfeld
evaluation rather than in geometry or segmentation.

- [ ] Settle whether this is nec2c's bug or NEC-2's limit. The divergence sets
      in where the height approaches the segment length, a regime NEC-2 itself
      warns about, so the sweep against nec2c alone cannot tell the two apart.
      Running the same sweep through nec2++ can: if it converges where nec2c
      does not, the method is sound and the implementation is not. That is the
      evidence the packaging question below turns on.
- [ ] Until then, say so in `nec2c-wasm`'s README. Someone modelling a
      ground-mounted vertical -- the obvious use for finite ground -- lands
      exactly in the broken regime and gets a plausible wrong number.

### nec2++

- [x] Licence checked, and it is not a blocker. `COPYING` in
      [tmolteno/necpp](https://github.com/tmolteno/necpp) is the GPLv2 text,
      but the source headers read "either version 2 of the License, or (at your
      option) any later version" -- GPL-2-**or-later**, which is compatible
      with this repo's GPL-3-or-later. An earlier note here said GPL-2-only and
      called it incompatible; that was wrong.
- [ ] Package nec2++ as a third package? What it offers over nec2c:
      - A real API. `libnecpp.h` exposes `nec_create`/`nec_delete` contexts,
        per-card calls (`nec_wire`, `nec_gm_card`, `nec_gx_card`, `nec_gn_card`,
        `nec_fr_card`, `nec_rp_card`, `nec_excitation_voltage`/`_current`/
        `_planewave`) and structured getters (`nec_gain`, `nec_gain_max`,
        `nec_gain_mean`, `nec_impedance_real`/`_imag`). Reading numbers instead
        of parsing columns removes the fragility this package's parsers carry
        and the entire "one set of results per call" restriction.
      - Cards this package cannot write yet come free: `GX`, patches
        (`SP`/`SC`), plane-wave excitation.
      - Maintained, C++17, CMake, no external dependencies (Eigen is bundled
        and header-only, so the Emscripten story should be straightforward).
      - It also ships a `necpp` executable that reads card decks from a file,
        so a text-in/text-out mode alongside the API is possible.
      Against: a larger `.wasm` than nec2c's 259 KB; a second solver to keep
      honest against the first; and `nec2c-deck`'s parsers would not apply to
      it, since they are keyed to nec2c's exact column layout. `buildDeck`
      would, being standard NEC-2 -- so the deck writer is reusable even if the
      parsers are not.
