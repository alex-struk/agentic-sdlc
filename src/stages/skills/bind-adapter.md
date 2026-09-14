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
  a password you invent, and never the literal value written anywhere in the file you produce. When
  the entry is `{ unavailable: "<reason>" }` instead of real credentials, `signIn` throws
  `new Error("unbound: signIn.<persona id> — <reason>")` rather than attempting to sign in — the
  same shape as an unbound action or observation, so calibrate reports every criterion this persona
  is needed for as `unbound` rather than as a real failure.
- **`open(params)`** on each page navigates to that page's route, with any params substituted.
- **Every action and observation** is bound by driving the browser: open the page, find the
  control by its role, its label, its visible text, or the URL it lands you on. Never a CSS
  selector, a `data-testid`, or anything else that only makes sense with source code open next to
  you — there is none here, and the separation check refuses one on your behalf either way.
- **An action or observation you cannot bind** — nothing on the running page does what the
  contract names — throws `new Error("unbound: <page>.<member> — <reason>")` from that method
  instead of pretending to succeed.

## Two ways a page hides from you, and what to do about each

Nearly everything an adapter reports as unbound is one of these, and neither is the page failing
to offer the thing. Read both before you write a single `unbound`.

**A route that needs an identifier.** You cannot open `/opportunities/:opportunityId/edit` without
an opportunity, so you cannot see the controls on it. The identifiers are in the seed:
`tests/seed/manifest.yaml` names every record it creates and `tests/generated/seed.ts` is the same
thing typed, so `seed.opportunities.<handle>.id` is a real identifier of a real record on the
target you are looking at. Use them to navigate while you bind. A member reported unbound because
"the route needs a value and none was given" is a member you did not try to reach — the value was
in the workspace all along.

**A control behind a step you have not taken.** A field on the third page of a wizard, a tab that
only appears once a panel exists, a form the service will not show until something earlier is
done. Walk the flow: sign in as a persona who may do it, take the earlier steps, and bind the
control where it actually appears. If the flow needs a record in a particular state to reach at
all, the seed usually has one — that is what the seeded records in an advanced state are for.

Report a member unbound only when you have opened its page *in the state the contract describes*
and the thing genuinely is not there. Say in the reason what you did to reach it, not only what
you did not find: "signed in as an administrator, opened the seeded closed opportunity, walked to
the consensus tab, no control labelled X" is a finding somebody can act on. "No control labelled
X" on its own cannot be told apart from never having looked.

## When an action takes a file

A test names a file the way a person would — `{ file: "scan0001.pdf" }`, sometimes with
`content` or a size beside it — because what the criterion turns on is the name, the type or
the size, never a path on the machine the suite happens to be running on. A file chooser needs
a real file, so the harness makes one: `import { uploadFile } from "../../fixtures/upload"`,
call it with what the test gave you, and hand the path it returns to `setFiles`.

Never treat the name as a path. A test that says `scan0001.pdf` is not telling you where a
file is; it is telling you what to call the one you are about to offer.

## `bindings.yaml`

Write `tests/adapters/<target>/bindings.yaml`, naming every action and observation of every page
in the surface exactly once, as `bound` or `unbound: <reason>` — nothing named twice, nothing left
out, nothing named that is not in the surface.

Every name in this file is spelled exactly as `spec/contract/surface.yaml` spells it, not as the
TypeScript member it becomes: a page `applications-new` with an action `submit_proposal` is
`applications-new:` and `submit_proposal:` here, even though the adapter you just wrote implements
them as `applicationsNew.submitProposal`. The check compares this file against the contract, so a
camel-cased name reads as one the surface does not have and a surface name as one you left out —
two failures for one mistake.

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
