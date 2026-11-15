# Gears module

Solidus **Gears** module, part of the open core (same license as the core). "Gears" tab in the Part workbench: three parametric features created on the fly (property panel with preview, re-editing by double-click).

- **Spur gear**: involute, module, number of teeth, face width, bore, pressure angle, profile shift, **helix angle** (twisted extrusion of the kernel), detailed or simplified representation (cylinder at the pitch diameter).
- **Rack**: module, number of teeth, face width, base height, pressure angle; simplified = bar.
- **Bevel gear** (simplified): cone at the pitch diameter m·Z, cone angle according to the mating gear and the shaft angle.

Gear ratios are set in the assembly with the kernel's *Gear*, *Belt / chain* and *Rack and pinion* constraints (ZA/ZB ratio, or pinion pitch radius).

## Usage

Built into every build of the application (`apps/web/vite-extensions.js`, `BUILTIN`).
Tests: `pnpm test` (engine + kernel), `pnpm test:e2e` (Playwright, port 5180).

## Kernel requirements

Helical toothing uses `twistExtrude`, a kernel function of cad-core (`core/part/registry.cpp`).
