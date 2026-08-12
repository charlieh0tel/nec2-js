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

- [x] Average power gain -- the `RP` card's `A` digit. The honest efficiency
      figure over lossy ground, where the power budget reads high because the
      earth's absorbed share counts as radiated. Parsed into
      `averagePowerGain` as `{gain, solidAngleOverPi}`.
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

Every implementation converges exactly at and above 0.05 wavelengths of height.
Below that, all four fail, but not alike. Worst error in the feedpoint
resistance, and the value at 0.02wl:

| solver | what it is | worst | at 0.02wl |
|---|---|---|---|
| nec2c 1.3.1 | C translation, `somnec.c` | +46594% | +91.90% |
| nec2c tip of tree | the same, current upstream | -- | +91.88% |
| aegnec2 0.9.0 | C, with the original `somnec.f` linked in | +46597% | +91.92% |
| nec2++ 2.3.4 | C++ rewrite | +126% | +0.77% |
| nec2dxs | the original Fortran NEC-2D | segfault | segfault |

Current nec2c matches the vendored 1.3.1 to five digits on this case, so the
version this repo ships is not behind upstream on it.

`investigations/average-power-gain.mjs` asks the same regime a different
question, and one with a closed-form answer that needs no second solver: a
lossless antenna over a perfect conductor puts all its power into the upper
hemisphere, so the average power gain over 2 pi steradians is exactly 2. NEC
integrates that from the far field, so it is independent of the feedpoint
impedance the sweep above measures. (NEC's own POWER BUDGET cannot be used --
it reports radiated power as input minus losses, so it balances by
construction.)

Average power gain with sigma = 1e10, where the ground should absorb nothing:

| height | nec2c | nec2++ |
|---|---|---|
| 0.002wl | 0.005 | 0.886 |
| 0.01wl | **42.8** | 2.009 |
| 0.02wl | 1.043 | 1.980 |
| 0.05wl and up | 1.995 | 1.995 |

The perfect-ground column of that script stays at about 1.995 throughout, so
0.25 percent is the angular grid's own error and the floor for reading any of
this. On that scale nec2c is far outside anything the discretization explains
below 0.05wl -- 42.8 would be radiating twenty times the power supplied -- and
nec2++ holds to about 0.01wl before going the same way at 0.002wl.

Both therefore fail near enough to the ground; they differ in where. Worth
stating plainly that this is a bench observation from one geometry by people
who are not experts in the method: it says these engines stop conserving
energy in this regime, not why, and not that any particular one of them is
right about real soil.

- [x] Settled: this is NEC-2's behaviour, not a defect nec2c introduced.
      aegnec2 calls the *original Fortran* SOMNEC and reproduces nec2c's
      numbers to three digits, so nec2c's C translation is faithful. The
      original Fortran NEC-2D segfaults in the same regime rather than
      disagreeing, which is its own kind of confirmation that the regime is
      where the method comes apart. An earlier note here read this as a bug in
      nec2c; that was wrong, and only running the other three showed it.
- [x] Not a segmentation effect, though the transition sits suspiciously near
      the segment length. Holding 0.02wl and sweeping the segment count from 3
      to 81 -- a 27x range, putting the height anywhere from an eighth of a
      segment to three of them -- leaves the error at about 91% throughout. An
      earlier note here guessed the opposite. Refining a model near ground does
      not rescue it; only height does.
- [ ] There is a rule of thumb in circulation that NEC-2 wants a wire some
      0.0001wl to 0.001wl clear of the ground, and that Sommerfeld cannot have
      it touching. Unverified here, and not from a source this repo has
      checked. If it holds, it does not conflict with the measurements: every
      height swept here clears that floor and is still wrong, which would make
      the floor about the model being admissible rather than about the answer
      being trustworthy. Worth finding the actual statement in the NEC-2
      documentation before repeating it anywhere users will read it.
- [ ] nec2++ is the outlier, and in the useful direction: two orders of
      magnitude closer to the limit at 0.02wl. Worth finding what it does
      differently before assuming it is simply better -- it may have changed
      the interpolation grid, or it may be trading this against something else.
- [x] `nec2c-wasm`'s README carries the caveat, since a ground-mounted
      vertical -- the obvious use for finite ground -- sits in that regime.

### The nec2c line_buf overflow, and the patch we carry for it

`load_line()` terminates with `buff[num_chr]`, and `num_chr` reaches
`LINE_LEN`, so a `char[LINE_LEN]` buffer is always one byte short.
`patches/0001-line-buf-off-by-one.patch` widens it; `build.sh` applies
everything in `patches/` to a staged copy, so the submodule stays pristine.

- [x] Reported upstream, <https://github.com/KJ7LNW/nec2c/issues/2>. The
      maintainer has accepted the fix; not merged or released as of writing.
- [x] Reported to Debian against `nec2c` 1.3.1-3, which ships a pre-`3d8c230`
      tarball and so has the 52-byte form rather than the one-byte one. Debian
      has not picked up v1.3.2 or v1.3.3 either, so an upstream merge alone
      will not reach it.
- [ ] **Drop the patch once upstream tags a release carrying the fix**: delete
      `packages/nec2c-wasm/patches/0001-line-buf-off-by-one.patch`, move the
      submodule pin to that tag, rebuild the prebuilts.

      Nothing decays if this is left alone: the pin is fixed, so the build
      keeps producing the same bytes indefinitely. What happens is that
      whoever next bumps the pin past the fix gets a build failure --
      `patch` exits 1 with "Reversed (or previously applied) patch detected"
      and `build.sh` runs under `set -e`. That is the intended behaviour
      rather than a hazard: it stops at the moment the patch becomes
      redundant, instead of silently double-patching or silently skipping.
      This note is here so the failure is recognised for what it is.

### Package naming

- [x] Repo renamed `nec2c-js` -> `nec2-js`. It is no longer about one solver:
      the investigations run four, and the deck writer emits standard NEC-2
      that any of them reads. GitHub redirects the old URL and npm names are
      independent, so nothing published moved.
- [x] Decided: `nec2c-deck` keeps its name and stays specific to nec2c. An
      earlier note here planned to rename it `nec2-deck` and split the deck
      writer out as solver-agnostic, so both engines could share one model.
      That was for cross-engine use, which is not wanted. `necpp-wasm` needs
      nothing from it -- its own model, and numbers straight from nec2++ --
      so the package is exactly what its name says: nec2c's deck writer and
      nec2c's parsers.
- [ ] The one thing that could reopen this is `toDeck()` in `necpp-wasm`. If
      that lands there would be two deck writers in the repo, which argues for
      sharing a writer at that point -- not for renaming anything now.

### nec2++

- [x] Licence checked, and it is not a blocker. `COPYING` in
      [tmolteno/necpp](https://github.com/tmolteno/necpp) is the GPLv2 text,
      but the source headers read "either version 2 of the License, or (at your
      option) any later version" -- GPL-2-**or-later**, which is compatible
      with this repo's GPL-3-or-later. An earlier note here said GPL-2-only and
      called it incompatible; that was wrong.
- [x] Emscripten build proven. nec2++ HEAD compiles under this repo's own
      pinned emcc 6.0.3 (`emcmake cmake -DNECPP_BUILD_WASM=ON`), no Docker
      needed despite upstream's `scripts/build_wasm_docker.sh` pinning emsdk
      4.0.7. The `libnecpp.h` C API binds through `ccall`, and the seven-wire
      example returns bit-identical numbers in all three builds:

      | build | Z (ohm) | gain max |
      |---|---|---|
      | native, necpp 2.3.4 | 595.415366 - j354.438287 | 6.328267 dB |
      | native, HEAD | 595.415366 - j354.438287 | 6.328267 dB |
      | wasm, HEAD | 595.415366 - j354.438287 | 6.328267 dB |

- [x] **`-fexceptions` is mandatory, at compile time and not only at link.**
      nec2++ throws `int` as ordinary control flow -- `nec_context.cpp`:
      `throw 1; // Continue card input` unwinds to the card-input loop once a
      single-frequency solve finishes. Objects compiled without exception
      support drop the matching `catch`, so the throw escapes the module and
      every solve looks like a crash. This cost most of a day: the symptom is
      `nec_rp_card` "failing" while every other call returns 0, which reads
      like a bad argument list rather than a build flag.
- [ ] Upstream's `NECPP_BUILD_WASM` target does not set `-fexceptions`, so
      nothing built by it can complete a solve. That is a one-line CMake fix
      and a genuine bug worth sending up. It also explains why the wasm
      wrapper below was never caught: no build of it could have got far enough
      to notice.
- [ ] `src/nec_wasm.cpp` is a stub, not a wrapper. `nec_process_input(ctx,
      input_text)` ignores `input_text` and calls `parse_geometry(&ctx,
      stdin)`, under the comment "For now, this is a stub showing the API
      shape". Built and run, it aborts. The text-in/text-out mode it advertises
      does not exist yet; wiring it to a string is real feature work, not a
      patch, and is better landed upstream than carried.
- [ ] `example/test_nec.c` does not compile against the shipped
      `libnecpp.h`: it calls `nec_geometry_complete(nec, 1, 0)` where the
      header declares `(nec_context*, int)`. Two call sites. Trivial PR, and
      good first contact with upstream.
- [ ] Package it as `necpp-wasm`, exposing **both** the C API and a text
      mode. The C API is the reason to want it -- structured getters remove
      the column-layout fragility and the one-set-of-results-per-call
      restriction in one go -- while text mode keeps the deck writer useful
      against both solvers. Cards this repo cannot write yet come free over
      the API: `GX`, patches (`SP`/`SC`), plane-wave excitation.
      Costs, now measured rather than guessed:
      - 549336 bytes of `.wasm` with exceptions on, against nec2c's 258665.
        About 2.1x. An earlier note here put it near parity, from a build of
        the stub that linked almost nothing.
      - A second solver to keep honest against the first.
      - A vendoring model this repo does not have yet. `nec2c-wasm` pins a
        frozen Debian tarball by checksum and vendors it unmodified; necpp is
        a live git upstream shipping releases weekly, so it needs a deliberate
        version pin and a README that says which rules apply where.
- [x] Published as `necpp-wasm`, the first nec2++ package on npm: `necpp` and
      `nec2pp` were both 404 on the registry beforehand.

### Deck output from a necpp-wasm model

Wanted, but secondary: `necpp-wasm` drives nec2++ through its API and never
needs a deck, so this is for feeding a model to other NEC tools, for checking
one by eye, and for filing a reproducible case upstream.

- [ ] Add `toDeck(model)`. The model already carries everything a deck needs
      and the mapping is mechanical: `wire`/`arc`/`helix` to `GW`/`GA`/`GH`,
      `transform`/`reflect` to `GM`/`GX`, `finishGeometry` plus ground to
      `GE`/`GN`, `excite` to `EX`, `load` to `LD`, `transmissionLine`/`network`
      to `TL`/`NT`, and the `solvePattern` grid to `RP`. It is a pure function
      of the model, so it needs no wasm and is testable by string comparison.
- [ ] Lift the fixed-format encoding rules from `nec2c-deck` rather than
      rediscovering them: six-decimal fields, a radius that must not round to
      zero (NEC reads zero as a tapered wire wanting a `GC`), and `E` notation
      for `LD` values, where 5 pF written fixed becomes a flat zero and NEC
      reads that as "omit the capacitor". The packages stay separate, but that
      knowledge was expensive and should not be learned twice.
- [ ] Decide the dialect: standard NEC-2 cards that any implementation reads,
      or nec2++'s own accepted set, which is wider than nec2c's.
- [ ] Decide whether reading a deck back into a model is in scope. Emitting is
      easy; parsing is a different job.
