# Changesets

Every user-visible change to the published packages (`@solidus-cad/sdk`, `@solidus-cad/assembly`, `@solidus-cad/sketch`, `@solidus-cad/kernel-wasm`) comes with a changeset file:

```sh
pnpm changeset            # choose the packages and the level (patch / minor / major)
pnpm version-packages     # updates versions and CHANGELOG (locally or in the release PR)
pnpm release:dry          # prepares and simulates the publication (no publication)
```

The actual publication (`pnpm release`) is only run by the maintainers, after manual validation.
The four packages are "linked": they share the same major/minor version number.
