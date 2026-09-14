import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDesignCatalogue, checkDesignNoLiteralColours, checkDesignSurfaceScope, surfacePageIds } from "../src/checks/design.mjs";

const SURFACE = `pages:
  - id: home
    domain: opportunities
    route: /
    title: "Home"
    actions:
      sign_in: { test_id: null }
    observations:
      heading: { test_id: null }
  - id: opportunity-list
    domain: opportunities
    route: /opportunities
    title: "Opportunities"
    actions:
      open_opportunity: { test_id: null }
    observations: {}
`;

function project(t, { surface = SURFACE, screens, catalogue = [], design = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-design-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "spec", "contract"), { recursive: true });
  writeFileSync(join(dir, "spec", "contract", "surface.yaml"), surface);
  mkdirSync(join(dir, "design", "catalogue"), { recursive: true });
  if (screens !== undefined) writeFileSync(join(dir, "design", "screens.yaml"), screens);
  for (const f of catalogue) writeFileSync(join(dir, "design", "catalogue", f), "export const Story = () => null;\n");
  for (const [rel, body] of Object.entries(design)) writeFileSync(join(dir, "design", rel), body);
  return dir;
}

const BOTH_SCREENS = `screens:
  - page: home
    states: [default, empty]
  - page: opportunity-list
    states: [default]
`;

test("the surface's page ids are read as the contract spells them", (t) => {
  assert.deepEqual(surfacePageIds(project(t)), ["home", "opportunity-list"]);
});

test("a catalogue covering every page in every declared state passes", (t) => {
  const dir = project(t, {
    screens: BOTH_SCREENS,
    catalogue: ["home.default.stories.tsx", "home.empty.stories.tsx", "opportunity-list.default.stories.tsx"],
  });
  const r = checkDesignCatalogue(dir);
  assert.equal(r.ok, true, r.messages.join(" | "));
});

test("a page the contract names and the design never drew fails", (t) => {
  const dir = project(t, {
    screens: `screens:\n  - page: home\n    states: [default]\n`,
    catalogue: ["home.default.stories.tsx"],
  });
  const r = checkDesignCatalogue(dir);
  assert.equal(r.ok, false);
  assert.match(r.messages.join("\n"), /opportunity-list is in the contract's surface but has no screen/);
});

// Both directions matter. A declared state with no story is a screen nobody drew; a story
// nobody declared is a state the reviewer was never told about.
test("a declared state with no story, and a story no screen declares, both fail", (t) => {
  const missing = project(t, { screens: BOTH_SCREENS, catalogue: ["home.default.stories.tsx", "opportunity-list.default.stories.tsx"] });
  assert.match(checkDesignCatalogue(missing).messages.join("\n"), /home\.empty\.stories\.tsx is missing/);

  const orphan = project(t, {
    screens: BOTH_SCREENS,
    catalogue: ["home.default.stories.tsx", "home.empty.stories.tsx", "opportunity-list.default.stories.tsx", "home.loading.stories.tsx"],
  });
  assert.match(checkDesignCatalogue(orphan).messages.join("\n"), /home\.loading\.stories\.tsx: no screen declares/);
});

test("a screen with no resting state fails", (t) => {
  const dir = project(t, {
    screens: `screens:\n  - page: home\n    states: [empty]\n  - page: opportunity-list\n    states: [default]\n`,
    catalogue: ["home.empty.stories.tsx", "opportunity-list.default.stories.tsx"],
  });
  assert.match(checkDesignCatalogue(dir).messages.join("\n"), /home has no "default" state/);
});

test("a colour written out by hand fails, in any of the ways it can be written", (t) => {
  for (const value of ["#036", "#003366", "rgb(3, 51, 102)", "hsla(210, 94%, 21%, 0.5)"]) {
    const dir = project(t, { design: { "DESIGN.md": `The header uses ${value} behind the title.\n` } });
    const r = checkDesignNoLiteralColours(dir);
    assert.equal(r.ok, false, value);
    assert.match(r.messages.join("\n"), /use a design-system token/);
  }
});

test("a design that names only tokens passes", (t) => {
  const dir = project(t, { design: { "DESIGN.md": "The header uses var(--surface-color-primary-button-default).\n" } });
  assert.equal(checkDesignNoLiteralColours(dir).ok, true);
});

// The design gate is the only stage that writes into the ruled surface, and the only thing
// it may write is a test ID. A route or an action changed here would change what the
// acceptance suite is allowed to reach, behind the gate that already ruled on it.
function gitProject(t, committed) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-design-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "spec", "contract"), { recursive: true });
  writeFileSync(join(dir, "spec", "contract", "surface.yaml"), committed);
  const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.test"]);
  run(["config", "user.name", "t"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "surface"]);
  return dir;
}

test("filling in a test ID is allowed; changing anything else is not", (t) => {
  const dir = gitProject(t, SURFACE);
  writeFileSync(join(dir, "spec", "contract", "surface.yaml"), SURFACE.replace("sign_in: { test_id: null }", 'sign_in: { test_id: "home-sign-in" }'));
  assert.equal(checkDesignSurfaceScope(dir).ok, true, checkDesignSurfaceScope(dir).messages.join(" | "));

  writeFileSync(join(dir, "spec", "contract", "surface.yaml"), SURFACE.replace("route: /opportunities", "route: /opportunities/all"));
  assert.match(checkDesignSurfaceScope(dir).messages.join("\n"), /opportunity-list changed its route, actions or observations/);

  writeFileSync(join(dir, "spec", "contract", "surface.yaml"), SURFACE.replace("      open_opportunity: { test_id: null }\n", ""));
  assert.match(checkDesignSurfaceScope(dir).messages.join("\n"), /opportunity-list changed its route, actions or observations/);
});

test("a page added or removed at the design gate fails", (t) => {
  const dir = gitProject(t, SURFACE);
  writeFileSync(join(dir, "spec", "contract", "surface.yaml"), `${SURFACE}  - id: invented\n    domain: opportunities\n    route: /invented\n    title: "Invented"\n    actions: {}\n    observations: {}\n`);
  assert.match(checkDesignSurfaceScope(dir).messages.join("\n"), /page invented was added/);
});
