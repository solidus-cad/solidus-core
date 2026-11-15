# Common environment for the build scripts (to be sourced). Works under Git Bash (Windows), Linux and macOS.
# Pinned versions: change them here to update the toolchain.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THIRD_PARTY="$ROOT/third_party"
OCCT_TAG="V7_9_3"
EMSDK_VERSION="${EMSDK_VERSION:-6.0.12}"
NLOHMANN_JSON_VERSION="v3.12.0"
CATCH2_VERSION="v3.8.1"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
  *) IS_WINDOWS=0 ;;
esac

# Without the WinGet\Links folder (links that Git Bash and MSYS2 cannot execute: "Bad address").
without_winget_links() { printf '%s' "$PATH" | tr ':' '\n' | grep -viE '/WinGet/Links/?$' | paste -sd: -; }

# Tools installed by winget without restarting the shell (CMake, Ninja, Node): their real folders, not WinGet\Links.
if [ "$IS_WINDOWS" = 1 ]; then
  winget_packages="$(cygpath -u "$LOCALAPPDATA")/Microsoft/WinGet/Packages"
  for d in "/c/Program Files/CMake/bin" "$winget_packages"/Kitware.CMake*/*/bin "$winget_packages"/Ninja-build.Ninja* \
    "/c/Program Files/nodejs" "$(cygpath -u "$APPDATA")/npm"; do
    [ -d "$d" ] && PATH="$d:$PATH"
  done
  PATH="$(without_winget_links)"
  export PATH
fi

# Activates emsdk (third_party/emsdk) without depending on emsdk_env.
use_emsdk() {
  local emsdk="$THIRD_PARTY/emsdk"
  if [ ! -x "$emsdk/emsdk" ] && [ ! -f "$emsdk/emsdk.py" ]; then
    git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$emsdk"
  fi
  if [ ! -d "$emsdk/upstream/emscripten" ]; then
    if [ "$IS_WINDOWS" = 1 ]; then
      (cd "$emsdk" && ./emsdk.bat install "$EMSDK_VERSION" && ./emsdk.bat activate "$EMSDK_VERSION")
    else
      (cd "$emsdk" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")
    fi
  fi
  export EMSDK="$emsdk"
  export EM_CONFIG="$emsdk/.emscripten"
  local node_dir py_dir
  node_dir="$(ls -d "$emsdk"/node/*/bin 2>/dev/null | tail -1 || true)"
  [ -z "$node_dir" ] && node_dir="$(ls -d "$emsdk"/node/* 2>/dev/null | tail -1 || true)"
  py_dir="$(ls -d "$emsdk"/python/* 2>/dev/null | tail -1 || true)"
  PATH="$emsdk:$emsdk/upstream/emscripten:${node_dir:+$node_dir:}${py_dir:+$py_dir:}$PATH"
  if [ -n "$py_dir" ]; then
    export EMSDK_PYTHON="$(ls "$py_dir"/python.exe "$py_dir"/bin/python3 2>/dev/null | head -1 || true)"
  fi
  export PATH
  EMSCRIPTEN_TOOLCHAIN="$emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"
}

fetch_occt() {
  if [ ! -f "$THIRD_PARTY/occt/src/TKernel/PACKAGES" ]; then
    git clone --depth 1 --branch "$OCCT_TAG" https://github.com/Open-Cascade-SAS/OCCT.git "$THIRD_PARTY/occt"
  fi
}

# Single-file dependencies: nlohmann/json (document) and Catch2 (C++ tests).
fetch_single_headers() {
  local json="$THIRD_PARTY/nlohmann_json/include/nlohmann"
  if [ ! -f "$json/json.hpp" ]; then
    mkdir -p "$json"
    curl -fsSL -o "$json/json.hpp" "https://github.com/nlohmann/json/releases/download/$NLOHMANN_JSON_VERSION/json.hpp"
  fi
  local catch="$THIRD_PARTY/catch2"
  if [ ! -f "$catch/catch_amalgamated.cpp" ]; then
    mkdir -p "$catch"
    for f in catch_amalgamated.hpp catch_amalgamated.cpp; do
      curl -fsSL -o "$catch/$f" "https://github.com/catchorg/Catch2/releases/download/$CATCH2_VERSION/$f"
    done
  fi
}

# Imports the MSVC x64 environment (vcvars64.bat) into this shell, to build with Ninja + cl.exe.
use_msvc() {
  [ "$IS_WINDOWS" = 1 ] || return 0
  command -v cl.exe > /dev/null && return 0
  local vswhere="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
  local vs
  vs="$("$vswhere" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | tr -d '\r')"
  [ -n "$vs" ] || { echo "Visual Studio Build Tools (C++) not found" >&2; exit 1; }
  # cmd.exe handles quotes passed by Bash poorly: go through a .bat file.
  # vcvars calls vswhere.exe by name: its folder must be in the PATH.
  local bat
  bat="$(cygpath -u "$TEMP")/cad-vcvars-$$.bat"
  printf '@set "PATH=%%PATH%%;%s"\r\n@call "%s" > nul\r\n@set\r\n' \
    "$(cygpath -w "$(dirname "$vswhere")")" "$(cygpath -w "$vs/VC/Auxiliary/Build/vcvars64.bat")" > "$bat"
  while IFS='=' read -r name value; do
    case "$name" in
      PATH|Path) PATH="$(cygpath -u -p "$value"):$PATH" ;;
      INCLUDE|LIB|LIBPATH|VCToolsInstallDir|VCINSTALLDIR|WindowsSdkDir|WindowsSDKVersion|UniversalCRTSdkDir|UCRTVersion)
        export "$name=$value" ;;
    esac
  done < <(cmd.exe //c "$(cygpath -w "$bat")" | tr -d '\r')
  rm -f "$bat"
  # The MSVC environment puts the Windows PATH back, WinGet\Links included.
  PATH="$(without_winget_links)"
  export PATH
}

file_size() { wc -c < "$1" | tr -d ' '; }
