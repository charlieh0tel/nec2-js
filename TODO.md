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
      transforms freely is not expressible. Options if it ever matters: an
      ordered `geometry: (Wire | Transform)[]` list; an insertion point on each
      transform; or geometry as a list of blocks, each being wires plus the
      transforms that act on them.

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

- [ ] Package [nec2++](https://github.com/tmolteno/necpp) (Tim Molteno's C++
      rewrite) as a third package? It exposes an in-memory API rather than
      deck-text-in/output-text-out, which would sidestep the column-layout
      fragility the parsers carry. Check the license first: this repo is
      GPL-3-or-later and necpp is believed to be GPL-2, which would be
      incompatible for a combined work.
