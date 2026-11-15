# Contributing to Solidus

Thank you for your interest. This repository contains the open core (AGPL-3.0 with the Solidus Plugin Exception; SDK under MIT); paid modules and the library server live in private repositories (see the [README](README.md)).

## Before You Start
- Open an *issue* before any significant change, to validate the approach.
- The code in this repository must **never** import a private module (anything under `ext/`) or a server. Extensions go through `@solidus-cad/sdk` (`AppExtension`, `definePlugin`).
- No secrets, keys, or tokens in commits (an automated check runs in CI).

## Environment
Node.js 22+, pnpm 9. The C++ kernel (OCCT, Emscripten) is optional for working on the interface: `node tools/fetch-kernel.mjs` downloads the precompiled WebAssembly kernel of the release pinned in `tools/kernel-version.json` (GitHub Releases). After a change to `core/`, rebuild it (`tools/build-occt.sh wasm` then `tools/build-kernel.sh wasm`, see [core/README.md](core/README.md)).

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

## Before Opening a *Pull Request*
1. `pnpm typecheck` and `pnpm test` pass.
2. Added or modified tests cover the change.
3. UI strings are in `apps/web/src/i18n.ts`, in French **and** English.
4. You have accepted the Contributor License Agreement (see below).

## Contributor License Agreement (CLA)

Before we can merge your first pull request, you need to accept the [Solidus Contributor License Agreement](CLA.md). It takes one comment and covers all your future contributions.

**Why a CLA?** Solidus's core is open source under the AGPL-3.0 with the [Solidus Plugin Exception](LICENSES/AdditionRef-Solidus-Plugin-Exception.txt). The official builds also include paid modules (CAM, quoting, analysis…) that fund the project. To ship your contribution in those builds, the maintainer needs a licence broader than the AGPL. In return, the CLA commits the maintainer to keep your contribution open source in every version that includes it (section 4).

**What you keep:** the copyright in your work, the right to reuse it anywhere, and credit in the history.

**How:** on your first pull request, comment "I have read the Solidus CLA and I agree to it." If you contribute on behalf of your employer, ask us for the Corporate CLA first.

## Licensing of Contributions
Your contributions are published under the licence of the files they change: AGPL-3.0 with the Solidus Plugin Exception, or MIT for `packages/sdk`. Adding a third-party component requires updating [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES) and verifying its compatibility with the AGPL-3.0 (and with MIT for the SDK).

## Conduct and Security
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Vulnerabilities: **do not** open a public *issue*, see [SECURITY.md](SECURITY.md).
