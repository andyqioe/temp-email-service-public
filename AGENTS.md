# QMail public-release preparation

This is an independent repository with fresh history; do not edit the original repositories.
Keep this repository private and npm publication disabled pending explicit release approval.
The user approved MIT licensing.

- `README.md` owns onboarding, polling contracts, and release limitations.
- `npm run check` runs TypeScript, ESLint and offline tests. Never run deployment, preflight or E2E commands without separate authorization.
- `scripts/build-cli.ts` bundles the CLI, records build inputs outside the package, and gathers dependency license notices.
- `inbox.example.ts` is generic. Actual `inbox.config.ts`, credentials and environment files must remain ignored.
- Configuration validation imports parser names only; never reintroduce backend parser implementations into CLI configuration imports.
- Keep tokens out of diagnostics, command arguments, artifacts, source, and Git history. Audit the exact tarball and staged source before pushing.
- API tokens authorize the entire deployment mail API, not per-inbox access. AWS credentials remain in the standard SDK credential chain.
- Parser waits remain sequential; invocation-level dedupe is not persisted. Preserve the CLI streaming and exit-code contracts.
