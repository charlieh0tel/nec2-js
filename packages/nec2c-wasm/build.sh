#!/usr/bin/env bash
#
# Build nec2c as a WebAssembly ES module.
#
# Compiles the vendored nec2c 1.3.1 C sources (third_party/nec2c) with emcc and
# emits the committed prebuilt artifacts:
#   prebuilts/nec2c.mjs         + prebuilts/nec2c.wasm   (separate .wasm)
#   prebuilts/nec2c-inline.mjs                           (.wasm embedded)
#
# The build is byte-for-byte reproducible, but only against the pinned emcc
# version below -- other versions produce different (working, but different)
# output. The emsdk submodule at the repo root is installed and activated
# automatically unless emcc is already on PATH at the right version.

set -euo pipefail

# Pinned toolchain. The committed artifacts were built with exactly this
# version; changing it changes the output bytes, so bump it deliberately and
# recommit the prebuilts in the same change.
EMCC_VERSION=6.0.3

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
vendor="$here/third_party/nec2c"
outdir="$here/prebuilts"
emsdk="$repo_root/emsdk"

emcc_version() { emcc --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

if [ "$(emcc_version)" != "$EMCC_VERSION" ]; then
  if [ ! -f "$emsdk/emsdk" ]; then
    echo "error: emcc $EMCC_VERSION not on PATH and the emsdk submodule is missing." >&2
    echo "       run: git submodule update --init" >&2
    exit 1
  fi
  "$emsdk/emsdk" install "$EMCC_VERSION"
  "$emsdk/emsdk" activate "$EMCC_VERSION"
  # shellcheck disable=SC1091
  source "$emsdk/emsdk_env.sh" >/dev/null 2>&1
fi

if [ "$(emcc_version)" != "$EMCC_VERSION" ]; then
  echo "error: emcc is $(emcc_version), expected $EMCC_VERSION." >&2
  echo "       the committed artifacts only reproduce against the pinned version." >&2
  exit 1
fi

mkdir -p "$outdir"

# nec2c source files (from Makefile.am nec2c_SOURCES, headers excluded).
sources=(
  calculations.c
  geometry.c
  input.c
  matrix.c
  network.c
  shared.c
  fields.c
  ground.c
  main.c
  misc.c
  radiation.c
  somnec.c
)

srcpaths=()
for s in "${sources[@]}"; do
  srcpaths+=("$vendor/$s")
done

# PACKAGE_STRING is the only autoconf/config.h macro referenced by the code
# (main.c, printed by -v). We supply it directly rather than generating
# config.h so the build needs no ./configure step.
common_flags=(
  -O2
  -DPACKAGE_STRING='"nec2c 1.3.1"'
  -I"$vendor"
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createNec2c
  -sEXPORTED_RUNTIME_METHODS=FS,callMain
  -sINVOKE_RUN=0
  -sEXIT_RUNTIME=1
  -sALLOW_MEMORY_GROWTH=1
  -sENVIRONMENT=web,node
)

emcc "${common_flags[@]}" "${srcpaths[@]}" -o "$outdir/nec2c.mjs"

# SINGLE_FILE embeds the wasm as base64 in the glue (about a third larger, but
# one file with no asset resolution), for bundlers that will not emit a
# sibling .wasm.
emcc "${common_flags[@]}" -sSINGLE_FILE=1 "${srcpaths[@]}" -o "$outdir/nec2c-inline.mjs"

echo "built with emcc $EMCC_VERSION:"
ls -l "$outdir/nec2c.mjs" "$outdir/nec2c.wasm" "$outdir/nec2c-inline.mjs"
