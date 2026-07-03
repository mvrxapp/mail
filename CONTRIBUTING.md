# Contributing

## Developer Certificate of Origin (DCO)

Every commit must include a `Signed-off-by` trailer certifying you wrote it or otherwise
have the right to submit it under the package's license (see [`README.md#license`](./README.md#license)):

```
Signed-off-by: Jane Doe <jane@example.com>
```

Add it automatically with `git commit -s`. If you forgot on an existing branch:

```bash
git commit --amend -s          # most recent commit
git rebase --exec 'git commit --amend --no-edit -s' -i <base>   # a range
```

A CI check ([`.github/workflows/dco.yml`](./.github/workflows/dco.yml)) rejects PRs with
unsigned commits.

**Why:** `@mvrx/mail` is dual-licensed (AGPL-3.0 + commercial, via [mvrx.group](https://mvrx.group)).
The DCO is how MVRX keeps the legal right to offer that commercial license without every
contributor separately signing a CLA — your sign-off is the certification that you hold
the rights you're granting.

## Setup

```bash
pnpm install
pnpm typecheck
pnpm build
```

## Making a change

- **Code changes** — keep to the package's existing patterns; run `pnpm typecheck` and
  `pnpm build` before opening a PR.
- **Spec changes** (`specs/AECS-1-*.md`, `specs/AECS-SDK-1-*.md`) — these are versioned
  documents (see each spec's Versioning section). Breaking changes to `NormalizedEmail`
  require a major version bump. If you change the threading algorithm (AECS-1 §5) or
  anything else covered by a fixture, update `specs/conformance/fixtures/` and confirm
  every fixture's expected output still matches — run `python3 specs/conformance/verify.py`
  and `pnpm --filter @mvrx/mail test`.
- **New packages** — follow the `packages/wbxml` layout (own `package.json`, `LICENSE`,
  `README.md`, `tsconfig.json`) and add it to the table in the root `README.md`.

## Pull requests

- One logical change per PR.
- Reference the spec section a behavioral change implements or alters, where applicable.
- CI (typecheck + build across the workspace) must pass.

## Reporting a security issue

Do not open a public issue — see [`SECURITY.md`](./SECURITY.md).
