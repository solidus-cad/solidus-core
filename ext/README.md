# ext/

Location of the modules compiled with the application but kept outside this repository (the private modules of the
official builds, or your own). This directory is ignored by git: each module is a separate repository, cloned here,
for example

```sh
git clone <module repository> ext/<name>
pnpm install
CAD_EXTENSIONS=../../ext/<name>/src/extension.tsx pnpm build
```

Without a module, the application builds and runs with the open workbenches only.
See docs/MODULES.md (and `modules/gears`, the reference example of a module).
