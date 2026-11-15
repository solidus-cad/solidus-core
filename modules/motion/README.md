# Motion module

Solidus **Motion** module, part of the open core (same license as the core). "Motion" workbench on an assembly: motion studies (tracks and keys on the mates, rotary and linear motors, loop playback, collision detection) and video export.

```
src/ui/            SolidJS interface and interpolation engine (engine.ts, session.ts, video.ts)
src/extension.tsx  entry point: registers tabs, panels, dialogs, document types
test/              unit tests of the motion engine (vitest)
e2e/               end-to-end tests (Playwright): the application is built with the module
```

## Usage

Built into every build of the application (`apps/web/vite-extensions.js`, `BUILTIN`).
Tests: `pnpm test` (motion engine), `pnpm test:e2e` (Playwright, port 5179).

## Usage rights

The module never reads a license token and does not contact any server: it asks `ctx.license` (`LicenseProvider`, `@solidus-cad/sdk`) for the `motion` feature. Without a license module, the core grants it.

## Video export

Videos are encoded in the browser with [Mediabunny](https://mediabunny.dev) (MPL-2.0, see THIRD_PARTY_LICENSES) and the WebCodecs API.
