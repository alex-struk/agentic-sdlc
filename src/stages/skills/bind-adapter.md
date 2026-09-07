Your job this run is to write the one binding of the abstract `Surface` for one running target, and
nothing else — the adapter a test drives instead of a browser it can see for itself.

## What you can see, and why that is the whole point

Your workspace holds only `spec/contract/`, `tests/adapters/`, `tests/seed/`, `constitution.md`,
the pipeline's own harness, and whatever `tests/generated/*` your setup step just wrote from that
contract. There is no `app/` here and there is no source to read — the only way to learn what a
page actually does is to open it, with the Playwright browser tools, and look. If a page's
`route`, from `spec/contract/surface.yaml`, does not resolve on the running target at all, that is
not yours to guess around — say so in your journal.

## Writing the adapter

Write `tests/adapters/<target>/index.ts`, exporting `default function create(page: Page, ctx: {
baseURL: string; persona: typeof persona }): Surface`, implementing every page
`tests/generated/surface.d.ts` declares:

- **`signIn(persona)`** reads `persona.signIn[<this target's identity>]`. `session-route`:
  `page.goto(baseURL + persona.signIn["session-route"].route)` mints the session directly, no form
  involved. `sandbox-idp`: find the identity provider's own sign-in form and fill it with the
  persona's username and the password in your `SDLC_SANDBOX_PASSWORD` environment variable — never
  a password you invent, and never the literal value written anywhere in the file you produce.
- **`open(params)`** on each page navigates to that page's route, with any params substituted.
- **Every action and observation** is bound by driving the browser: open the page, find the
  control by its role, its label, its visible text, or the URL it lands you on. Never a CSS
  selector, a `data-testid`, or anything else that only makes sense with source code open next to
  you — there is none here, and the separation check refuses one on your behalf either way.
- **An action or observation you cannot bind** — nothing on the running page does what the
  contract names — throws `new Error("unbound: <page>.<member> — <reason>")` from that method
  instead of pretending to succeed.

## `bindings.yaml`

Write `tests/adapters/<target>/bindings.yaml`, naming every action and observation of every page
in the surface exactly once, as `bound` or `unbound: <reason>` — nothing named twice, nothing left
out, nothing named that is not in the surface:

```yaml
target: <target>
pages:
  <pageId>:
    actions: { <name>: bound }
    observations: { <name>: "unbound: <why>" }
```

## What you must never do

Never assert (`expect(...)`) — that is the test's job, not the adapter's, and the separation check
refuses it. Never define a `test()` block of your own. Never write under `tests/acceptance/` or
`spec/` — this workspace does not even have them for you to touch by mistake. Your territory is
`tests/adapters/<target>/` alone.

## The journal

Your final message is read by the reviewer persona who rules this proposal. Say what was bound,
what was not and why, and name any page whose route did not resolve on the target at all. Never
name a person in it, and never write the sandbox password — or any value read from the environment
— into the journal, the adapter, or the bindings file.
