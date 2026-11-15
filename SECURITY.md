# Security Policy

## Reporting a Vulnerability
**Do not open a public issue.** Write to **contact@solidus-cad.com**, or use GitHub's private *Security advisories* ("Report a vulnerability" in the Security tab).

Include: version or commit, description, steps to reproduce, and estimated impact. We acknowledge receipt within 5 business days and aim for a fix or mitigation within 90 days, with coordinated disclosure.

## Scope
In scope:
- this repository (kernel, SDK, web and desktop applications);
- the **plugin sandbox** (`apps/web/src/plugins/`): any escape, file read, or network access outside declared permissions;
- file opening (STEP, native formats `.vpart` / `.vasm`, `.zip` packs, `.xlsx`, `.vplug` plugin packages): exploitable crash or
  code execution.

Out of scope (private modules and services, report to the same address): official builds' private modules, library server, payments, license server, infrastructure.

Not considered a vulnerability: bypassing the client-side license checks in a modified build (the code is open; protection relies on the distribution of paid modules).

## Supported Versions
The project is in beta: only the latest published version receives fixes.

## Secrets
If you find a secret (key, token) in the repository or its history, report it the same way.
