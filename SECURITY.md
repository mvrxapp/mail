# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@mvrx.app** with:

- A description of the vulnerability and its impact
- Steps to reproduce (a minimal `.eml` or code sample if applicable)
- Affected package and version

You'll get an acknowledgment within 3 business days. We'll work with you on a disclosure
timeline once the report is triaged — please give us a reasonable window to ship a fix
before any public disclosure.

## Scope

- `@mvrx/mail`, `@mvrx/wbxml`, and the reference implementations of the AECS-1 / AECS-SDK-1
  specs in this repo.
- Implementation bugs: memory safety, injection, auth/permission bypass, DoS via
  malformed input (email, WBXML) — anything where crafted input causes the SDK to do
  something other than what it documents.

## Explicitly out of scope

AECS-1 §7 and AECS-SDK-1 §11 already document that email content is untrusted and that
`content.forAI` reduces noise but does **not** sanitize against prompt injection — an
LLM acting on attacker-controlled email content in ways the *consuming application*
didn't intend is an application-layer risk, not a vulnerability in the SDK itself, unless
the SDK's own tools (`aiTools.*`, `compose.*`) fail to follow their own documented
delimiting/wrapping behavior. If you find a case where the SDK's built-in tools don't
apply the isolation they claim to, that **is** in scope — report it.

## Supported versions

Pre-1.0: only the latest published `0.x` version of each package is supported. Once
`@mvrx/mail` reaches `1.0.0`, this section will be updated with a support matrix.
