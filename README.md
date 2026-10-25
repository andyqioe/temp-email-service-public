# QMail

A self-hosted, receive-only email CLI and Amazon SES backend.
QMail is browser-agnostic: it discovers messages and parser candidates, not browser acceptance or rejection.

## Release status

This independent repository is preparing a public release with fresh history and generic examples.
The npm package is `@andyqioe/qmail`, with the executable `qmail` and Node.js 22+ required.
No public publication is authorized yet; the build still defaults to restricted access as a release safeguard.

## Build and install locally

```sh
npm ci --ignore-scripts
npm run check
npm run pack:cli
npm install -g ./dist/andyqioe-qmail-0.1.0.tgz
qmail setup
```

Installation does not contact AWS, deploy infrastructure, or create credentials.
The bundle includes runtime dependencies, MIT licensing, and third-party license notices.
It does not include deployment configuration or saved credentials.

## Credentials and setup

Use `qmail setup --help` for the available connection options.
Setup supports an existing API URL and token, or explicit token registration using an existing AWS identity.
AWS identity comes from the standard SDK credential chain: a local profile/SSO session or instance role.
QMail does not collect or save AWS access keys.
No AWS credentials are needed for mail commands when an API URL and QMail token are available.
Account and administrative commands still require AWS credentials and deployment configuration.

```sh
# Hidden token prompt; explicit save confirmation defaults to No.
qmail setup --method existing --api-url https://your-api.example.com
# INBOX_TOKEN supplied by your secret manager; --yes authorizes local storage.
qmail setup --method existing --api-url https://your-api.example.com --yes
# Reads existing stack outputs and registers a token only after confirmation.
qmail setup --method aws --region us-east-1 --stack SesInbox-prod --name laptop --profile my-profile
```

Noninteractive AWS setup additionally requires `--yes`.
Existing stage credentials are left unchanged unless `--replace` is supplied; replacement still requires confirmation or `--yes`.
Setup uses `--stage` to select the local credential entry and never deploys infrastructure.
AWS setup needs CloudFormation `DescribeStacks` and DynamoDB transaction-write permissions for the token table; it reads `ApiUrl`, `TableName` and optional `Domains` outputs.
Log in to an SSO profile before running setup if its session has expired.
A successful registration followed by a failed save requires revoking the named token before retrying; an ambiguous registration failure requires checking the registry first.
Remote API endpoints require HTTPS, reject URL credentials/query/fragment, and do not follow redirects; HTTP is allowed only for localhost/loopback development fixtures.
Credential writes are atomic with file mode `0600` and application-directory mode `0700`; symlinks at the credential file or application directory are rejected.
The parent configuration root is trusted, and simultaneous setup writers are not coordinated: do not run multiple setup commands against the same file.
Malformed credential files are not overwritten automatically.


For unattended mail consumers, supply `INBOX_API_URL` and `INBOX_TOKEN` using your secret manager or process environment.
Do not put tokens in command arguments, shell history, source files, or CI logs.
Saved credentials are plaintext in a private local file, not encrypted or stored in an OS keychain.
The location is `$XDG_CONFIG_HOME/ses-inbox/config.json` or `~/.config/ses-inbox/config.json`.
Never share a deployment token with untrusted users: tokens currently authorize the deployment-wide mail API, including destructive operations, not a single inbox.

## Polling and automation

```sh
qmail poll user@example.com --code jagex --mode=stream --json --since 2026-01-01T00:00:00Z --timeout 120
```

`--mode=once|stream` is independent of extraction.
Without an explicit mode, normal polling continues and `--code`/`--link` return after the first qualifying candidate.
Explicit `--mode=once` stops after one result.
`--mode=stream` continues until timeout or cancellation, including after emitting candidates.
`--once --mode=stream` is rejected.

With `--code --json`, stdout contains JSON Lines with exactly `{ "id": "...", "code": "..." }`.
With `--link --json`, records contain exactly `{ "id": "...", "link": "..." }`.
Stream parser failures or missing values are skipped with diagnostics on stderr, without printing codes in diagnostics.
There is no cross-process consumed state: restarting with the same `--since` may replay results.
IDs are deduplicated within one invocation and retained until it ends, so memory grows with observed IDs.
Parser waits remain sequential; a pending parser can delay later messages until it completes or the overall timeout expires.
Exit codes: 0 for a completed one-shot, 2 for timeout even after stream output, 4 for a one-shot parser failure/missing value, 130 for SIGINT.

## Self-hosting

The backend uses SES receiving, S3, SQS, Lambda, DynamoDB and CloudWatch, managed through CDK.
Copy `inbox.example.ts` to ignored `inbox.config.ts` and replace example domains and alert addresses with your own values before reviewing deployment commands.
Alternatively set `INBOX_CONFIG` to a private configuration file; packaged admin commands support JSON or an MJS default export.
Never commit the personal configuration.
Deployment, preflight and end-to-end tests perform real AWS operations and can incur costs; they are separate from offline checks and are never run by installation or setup.
Review `npm run deploy -- --help` and the source before deploying.

## Development and release checks

```sh
npm run check
npm audit
npm run pack:cli
```

Unit and CLI tests use local fixtures; `npm run test:e2e` deploys real AWS resources and requires separate authorization.
Review the actual tarball, not just its manifest: `tar -tzf dist/andyqioe-qmail-0.1.0.tgz`.
`dist/build-inputs.json` records bundled source inputs and stays out of the package.
A clean scan is evidence scoped to the tested patterns and artifact, not proof of absence of arbitrary secrets.
Never publish or change repository visibility without reviewing the final artifact and obtaining release approval.

## License

MIT; see `LICENSE`.
Bundled dependencies retain their own licenses, collected in `THIRD_PARTY_NOTICES.txt` in the generated package.
