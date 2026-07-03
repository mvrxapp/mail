## What & why

<!-- One or two sentences. Link the issue/spec section if applicable. -->

## Checklist

- [ ] All commits have a `Signed-off-by` trailer (`git commit -s`) — see [CONTRIBUTING.md](../CONTRIBUTING.md#developer-certificate-of-origin-dco)
- [ ] `pnpm typecheck` and `pnpm build` pass locally
- [ ] If this changes `NormalizedEmail`, the threading algorithm, or any other spec behavior covered by `specs/conformance/fixtures/`, the fixtures are updated to match
- [ ] If this changes public API shape, `specs/AECS-SDK-1-specification.md` is updated in the same PR
