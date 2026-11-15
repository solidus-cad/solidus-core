#!/usr/bin/env bash
# Builds cad-core (and its C++ tests), then, in WASM, the kernel.js + kernel.wasm bindings.
#   tools/build-kernel.sh wasm     -> packages/kernel-wasm/dist/kernel.{js,wasm,d.ts}
#   tools/build-kernel.sh native   -> build/core-native (native tests, cad-kernel for the desktop application)
#   tools/build-kernel.sh win64    -> build/core-win64 (from Linux, MinGW-w64: Windows cad-kernel.exe, tests under Wine)
# Variables: JOBS (parallel compilations), KEEP_GOING=1 (report all errors in a single build).
# Prerequisite: tools/build-occt.sh <same target>. Set TEST=0 to skip the C++ tests.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

TARGET="${1:-wasm}"
# Half of the cores by default: at full load, a laptop may shut down from overheating.
JOBS="${JOBS:-$(( ($(nproc 2>/dev/null || echo 8) + 1) / 2 ))}"
fetch_single_headers

BUILD="$ROOT/build/core-$TARGET"
OCCT="$ROOT/build/occt-$TARGET/install"
[ -d "$OCCT/lib" ] || { echo "OCCT missing: run tools/build-occt.sh $TARGET first" >&2; exit 1; }

case "$TARGET" in
  wasm|wasm-mt)
    use_emsdk
    extra=()
    [ "$TARGET" = wasm-mt ] && extra+=(-DCAD_PTHREADS=ON)
    cmake -S "$ROOT/core" -B "$BUILD" -G Ninja \
      -DCMAKE_TOOLCHAIN_FILE="$EMSCRIPTEN_TOOLCHAIN" -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CXX_FLAGS_RELEASE="-O3 -DNDEBUG" -DCMAKE_EXE_LINKER_FLAGS_RELEASE="-O3" \
      -DOCCT_PREFIX="$OCCT" "${extra[@]}"
    ;;
  native)
    use_msvc
    cmake -S "$ROOT/core" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release -DOCCT_PREFIX="$OCCT"
    ;;
  win64)
    cmake -S "$ROOT/core" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_TOOLCHAIN_FILE="$ROOT/tools/toolchain-mingw64.cmake" -DOCCT_PREFIX="$OCCT"
    ;;
  *) echo "Unknown target: $TARGET (wasm, wasm-mt, native, win64)" >&2; exit 1 ;;
esac

start=$(date +%s)
# KEEP_GOING=1: continue after a compilation error (report all errors in a single build).
cmake --build "$BUILD" --config Release --parallel "$JOBS" ${KEEP_GOING:+-- -k 0}
echo "cad-core ($TARGET): built in $(($(date +%s) - start)) s"

if [ "${TEST:-1}" = 1 ]; then
  case "$TARGET" in
    wasm|wasm-mt) (cd "$BUILD" && node cadcore_tests.js) ;;
    native)
      "$BUILD/cadcore_tests" ;;
    win64)
      if command -v wine > /dev/null; then WINEDEBUG=-all wine "$BUILD/cadcore_tests.exe"; else echo "Wine absent: C++ tests not run"; fi ;;
  esac
fi

if [ "$TARGET" = wasm ] || [ "$TARGET" = wasm-mt ]; then
  dist="$ROOT/packages/kernel-wasm/dist"
  [ "$TARGET" = wasm-mt ] && dist="$dist/mt"
  mkdir -p "$dist"
  cp "$BUILD/bindings/kernel.js" "$BUILD/bindings/kernel.wasm" "$dist/"
  [ -f "$BUILD/bindings/kernel.d.ts" ] && cp "$BUILD/bindings/kernel.d.ts" "$dist/"
  raw=$(file_size "$dist/kernel.wasm")
  gz=$(gzip -9 -c "$dist/kernel.wasm" | wc -c | tr -d ' ')
  br=""
  if command -v brotli > /dev/null; then br=", brotli $(( $(brotli -c -q 11 "$dist/kernel.wasm" | wc -c) / 1024 )) KB"; fi
  echo "kernel.wasm : $((raw / 1024)) KB, gzip -9 $((gz / 1024)) KB$br -> $dist"
fi

# Native: the kernel process (sidecar) is copied where Tauri expects it, suffixed with the target triple
# (apps/desktop/src-tauri/tauri.conf.json, bundle.externalBin).
if [ "$TARGET" = win64 ]; then
  # Same name as the MSVC build: Tauri bundles binaries/cad-kernel-<target triple>.exe.
  bin="$ROOT/apps/desktop/src-tauri/binaries"
  mkdir -p "$bin"
  cp "$BUILD/bindings/cad-kernel.exe" "$bin/cad-kernel-x86_64-pc-windows-msvc.exe"
  echo "cad-kernel : $(( $(file_size "$bin/cad-kernel-x86_64-pc-windows-msvc.exe") / 1024 )) KB -> $bin/cad-kernel-x86_64-pc-windows-msvc.exe"
fi
if [ "$TARGET" = native ]; then
  # Rust triple if installed (pipefail: a missing rustc must not stop the script).
  triple="$( (rustc -vV 2>/dev/null || true) | sed -n 's/^host: //p' | tr -d '\r')"
  if [ -z "$triple" ]; then
    case "$(uname -s)-$(uname -m)" in
      MINGW*|MSYS*|CYGWIN*) triple="x86_64-pc-windows-msvc" ;;
      Linux-x86_64) triple="x86_64-unknown-linux-gnu" ;;
      Linux-aarch64) triple="aarch64-unknown-linux-gnu" ;;
      Darwin-arm64) triple="aarch64-apple-darwin" ;;
      Darwin-x86_64) triple="x86_64-apple-darwin" ;;
    esac
  fi
  ext=""
  [ "$IS_WINDOWS" = 1 ] && ext=".exe"
  bin="$ROOT/apps/desktop/src-tauri/binaries"
  mkdir -p "$bin"
  cp "$BUILD/bindings/cad-kernel$ext" "$bin/cad-kernel-$triple$ext"
  echo "cad-kernel : $(( $(file_size "$bin/cad-kernel-$triple$ext") / 1024 )) KB -> $bin/cad-kernel-$triple$ext"
fi
