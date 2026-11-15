#!/usr/bin/env bash
# Builds OCCT 7.9 (pruned) as static libraries.
#   tools/build-occt.sh wasm      -> build/occt-wasm/install         (Emscripten, -O3 -msimd128 -fwasm-exceptions)
#   tools/build-occt.sh wasm-mt   -> build/occt-wasm-mt/install      (idem + pthreads)
#   tools/build-occt.sh native    -> build/occt-native/install       (MSVC on Windows, otherwise the system compiler)
#   tools/build-occt.sh win64     -> build/occt-win64/install        (from Linux: MinGW-w64, for the Windows cad-kernel.exe)
# Measures the build time and the size of the libraries.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

TARGET="${1:-wasm}"
# Half of the cores by default: at full load, a laptop may shut down from overheating.
JOBS="${JOBS:-$(( ($(nproc 2>/dev/null || echo 8) + 1) / 2 ))}"
fetch_occt

BUILD="$ROOT/build/occt-$TARGET"
PREFIX="$BUILD/install"
case "$TARGET" in
  wasm|wasm-mt)
    use_emsdk
    extra=()
    [ "$TARGET" = wasm-mt ] && extra+=(-DOCCT_PTHREADS=ON)
    cmake -S "$ROOT/tools/occt" -B "$BUILD" -G Ninja \
      -DCMAKE_TOOLCHAIN_FILE="$EMSCRIPTEN_TOOLCHAIN" \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CXX_FLAGS_RELEASE="-O3 -DNDEBUG" -DCMAKE_C_FLAGS_RELEASE="-O3 -DNDEBUG" \
      -DOCCT_SOURCE_DIR="$THIRD_PARTY/occt" "${extra[@]}"
    ;;
  native)
    use_msvc
    cmake -S "$ROOT/tools/occt" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release -DOCCT_SOURCE_DIR="$THIRD_PARTY/occt"
    ;;
  win64)
    cmake -S "$ROOT/tools/occt" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_TOOLCHAIN_FILE="$ROOT/tools/toolchain-mingw64.cmake" -DOCCT_SOURCE_DIR="$THIRD_PARTY/occt"
    ;;
  *) echo "Unknown target: $TARGET (wasm, wasm-mt, native, win64)" >&2; exit 1 ;;
esac

start=$(date +%s)
# KEEP_GOING=1: continue after a compilation error (report all errors in a single build).
cmake --build "$BUILD" --config Release --parallel "$JOBS" ${KEEP_GOING:+-- -k 0}
end=$(date +%s)
cmake --install "$BUILD" --config Release --prefix "$PREFIX" > /dev/null

total=0
for lib in "$PREFIX"/lib/*.a "$PREFIX"/lib/*.lib; do  # .a (WASM) or .lib (MSVC)
  [ -f "$lib" ] || continue
  total=$((total + $(file_size "$lib")))
done
echo "OCCT ($TARGET): built in $((end - start)) s, static libraries: $((total / 1024 / 1024)) MB -> $PREFIX"
