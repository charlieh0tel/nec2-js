# TODO

Open work only. Finished work is in the git history.

## nec2c-deck: cards `buildDeck` does not emit

It writes 12 of the 34 nec2c reads: `CM`/`CE`, `GW`, `GM`, `GE`, `GN`, `EK`,
`LD`, `TL`, `EX`, `FR`, `RP`, `EN`.

- [ ] `NT` -- nonradiating network, the general two-port `TL` is a case of:
      matching networks, hybrids, couplers.
- [ ] `KH` -- interaction approximation distance. The only accuracy-for-speed
      knob on large structures.
- [ ] `GX` / `GR` -- reflection and cylindrical symmetry. Large speedups, since
      NEC solves one sector and reuses it.
- [ ] `GD` -- second ground medium (cliff, shoreline), with the `GN` fields
      that go with it.
- [ ] `GC` -- tapered wire. A zero `GW` radius already means "a `GC` follows",
      which is why `f6nonzero` guards that field.
- [ ] `GA` arc, `GH` helix. A helix is painful to write as straight wires.
- [ ] `GS` scale, `GF` numerical Green's function.
- [ ] `SP` / `SM` / `SC` surface patches. Large: patches change the geometry
      model, not just the card set.
- [ ] `NE` / `NH` near fields. Needs parser work too -- a different output
      section, currently rejected by name.
- [ ] `XQ`, `PT`, `PQ`, `PL`, `NX`, `CP`, `WG` -- print and execution control,
      mostly irrelevant to a one-run deck.

## nec2c-deck: partial coverage of cards it does emit

- [ ] `EX` types 1-5: plane-wave incidence, elementary current source,
      current-slope discontinuity. Receiving patterns and radar cross-section
      live here. They print sections the parsers do not read and suppress the
      `POWER BUDGET`, so this is parser work too.
- [ ] `EX` `I4`/`F3`: `masym` and `iped`/`zpnorm`, both hardcoded 0.
- [ ] `FR`: one frequency, linear only. A sweep needs a result shape that
      records which frequency each row belongs to, so it is blocked on
      `parseOutput` handling one set of results per call.
- [ ] `RP`: one card per deck, far field only, `F5`/`F6` unwritten.
- [ ] `TL` shunt admittances (`F3`..`F6`), always zero.
- [ ] `EK` takes no field; `EK -1` restores the thin-wire kernel.
- [ ] `GN -1` nullifies a previous ground. Meaningless in a single-run deck.
- [ ] `GM` is emitted after every `GW`, so a transform acts on the whole
      structure or, via `fromTag`, a tail of it. Interleaving geometry and
      transforms -- replicate one element, *then* add wires -- is not
      expressible. Options if it ever matters: an ordered
      `geometry: (Wire | Transform)[]`, an insertion point per transform, or
      geometry as blocks of wires plus the transforms acting on them. The
      first is the only one that cannot back you into a corner. Not worth
      doing until something needs it.

## nec2c-deck: sections `parseOutput` does not read

It reads `ANTENNA INPUT PARAMETERS`, `CURRENTS AND LOCATION`,
`RADIATION PATTERNS`, `POWER BUDGET`, and the average power gain trailer.

- [ ] `STRUCTURE IMPEDANCE LOADING` -- echoes what each `LD` card did.
- [ ] Network and transmission-line port data.
- [ ] `SEGMENTATION DATA` -- lets a caller check its segmentation against what
      NEC built.
- [ ] Normalized gain block (`RP` `N` digit).

## nec2c-wasm: the carried patch

`patches/0001-line-buf-off-by-one.patch` fixes a one-byte stack overflow:
`load_line()` terminates with `buff[num_chr]` where `num_chr` reaches
`LINE_LEN`, so `char[LINE_LEN]` is always one short. Reported upstream as
[KJ7LNW/nec2c#2](https://github.com/KJ7LNW/nec2c/issues/2); the fix is
accepted, not yet released. Debian's 1.3.1-3 carries a worse 52-byte form and
has been notified.

- [ ] **Drop the patch when upstream tags a release with the fix.** Delete the
      patch, move the submodule pin, rebuild the prebuilts.
      `packages/nec2c-wasm/test/patch.test.mjs` fails when the patch stops
      being needed, and bumping the pin without removing it fails the build at
      `patch`. Both are the guard working, not a breakage.

## necpp-wasm

- [ ] `toDeck(model)`. Wanted but secondary: nec2++ is driven through its API
      and needs no deck, so this is for feeding other NEC tools, eyeballing a
      model, and filing reproducible cases upstream. The mapping is mechanical
      (`wire`/`arc`/`helix` to `GW`/`GA`/`GH`, and so on) and it is a pure
      function of the model, so it needs no wasm and is testable by string
      comparison.
  - [ ] Lift the fixed-format encoding rules from `nec2c-deck` rather than
        rediscovering them: six-decimal fields, a radius that must not round
        to zero, `E` notation for `LD` values.
  - [ ] Decide the dialect: standard NEC-2 that anything reads, or nec2++'s
        wider accepted set.
  - [ ] Decide whether reading a deck back into a model is in scope.
- [ ] Report nec2++'s missing range checks upstream. A tag or segment that
      does not exist walks off an array rather than being rejected; under wasm
      that traps. Same class as the `line_buf` finding.

## Upstream contributions in flight

- [ ] [tmolteno/necpp#129](https://github.com/tmolteno/necpp/pull/129) --
      `example/test_nec.c` does not compile against the shipped header.
- [ ] `NECPP_BUILD_WASM` does not set `-fexceptions`, so nothing that target
      builds can finish a solve. One-line CMake fix, not yet sent.
- [ ] `src/nec_wasm.cpp` is a stub whose `nec_process_input()` ignores its
      argument and reads `stdin`. Wiring it to a string is feature work, and
      better landed upstream than carried.

## Unverified

- [ ] A rule of thumb in circulation says NEC-2 wants a wire 0.0001 to 0.001
      wavelengths clear of ground, and that Sommerfeld cannot have it
      touching. Not from a source this repo has checked. Worth finding the
      statement in the NEC-2 documentation before repeating it anywhere users
      will read it.
