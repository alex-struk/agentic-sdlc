// test/design-screens.test.mjs — pictures of a design proposal's screens, taken for its ruler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureScreens } from "../src/runner/catalogue.mjs";

const SURFACE = `pages:
  - { id: application-list, domain: applications, route: /applications }
  - { id: application-view, domain: applications, route: /applications/:id }
  - { id: invoice-list, domain: billing, route: /invoices }
`;

function project(t, { scan = "// node scan.mjs --screens <dir> --only <files>\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-screens-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "spec", "contract"), { recursive: true });
  writeFileSync(join(dir, "spec", "contract", "surface.yaml"), SURFACE);
  mkdirSync(join(dir, "design", "catalogue"), { recursive: true });
  mkdirSync(join(dir, "design", "node_modules"), { recursive: true });
  writeFileSync(join(dir, "design", "package.json"), "{}\n");
  writeFileSync(join(dir, "design", "scan.mjs"), scan);
  for (const f of ["application-list.default.stories.tsx", "application-list.empty.stories.tsx", "application-view.default.stories.tsx", "invoice-list.default.stories.tsx", "layout.tsx"]) {
    writeFileSync(join(dir, "design", "catalogue", f), "export {};\n");
  }
  return dir;
}

// Stands in for `node scan.mjs`: writes one picture per story file it was asked for.
function fakeScan(calls) {
  return (cmd, args, cwd) => {
    calls.push(args);
    const out = join(cwd, args[args.indexOf("--screens") + 1]);
    mkdirSync(out, { recursive: true });
    for (const f of args[args.indexOf("--only") + 1].split(",")) writeFileSync(join(out, f.replace(".stories.tsx", ".png")), "png");
    return { status: 0, stderr: "" };
  };
}

test("only the domain's own stories are photographed, into a folder outside the history", (t) => {
  const dir = project(t);
  const calls = [];
  const shots = captureScreens(dir, "applications", { exec: fakeScan(calls), ensure: () => ({ status: 0 }) });
  assert.equal(shots.error, null);
  assert.deepEqual(calls[0].slice(0, 3), ["scan.mjs", "--screens", "screenshots"]);
  assert.deepEqual(calls[0][4].split(","), ["application-list.default.stories.tsx", "application-list.empty.stories.tsx", "application-view.default.stories.tsx"]);
  assert.deepEqual(shots.files, [
    "design/screenshots/application-list.default.png",
    "design/screenshots/application-list.empty.png",
    "design/screenshots/application-view.default.png",
  ]);
});

test("pictures left by an earlier ruling are cleared, so a ruler never sees another proposal's screens", (t) => {
  const dir = project(t);
  mkdirSync(join(dir, "design", "screenshots"), { recursive: true });
  writeFileSync(join(dir, "design", "screenshots", "invoice-list.default.png"), "old");
  const shots = captureScreens(dir, "applications", { exec: fakeScan([]), ensure: () => ({ status: 0 }) });
  assert.ok(!shots.files.some((f) => f.includes("invoice-list")));
});

test("a scanner that predates screenshots says how to get one that does", (t) => {
  const dir = project(t, { scan: "// typecheck, build, scan\n" });
  const shots = captureScreens(dir, "applications", { exec: () => assert.fail("must not run"), ensure: () => ({ status: 0 }) });
  assert.deepEqual(shots.files, []);
  assert.match(shots.error, /sdlc init/);
});

test("a run that produced no pictures carries the scanner's own last words", (t) => {
  const dir = project(t);
  const shots = captureScreens(dir, "applications", { exec: () => ({ status: 1, stderr: "warming up\nthe catalogue does not build" }), ensure: () => ({ status: 0 }) });
  assert.deepEqual(shots.files, []);
  assert.match(shots.error, /the catalogue does not build/);
});

test("a domain with no stories is told so rather than photographed empty", (t) => {
  const dir = project(t);
  const shots = captureScreens(dir, "reports", { exec: () => assert.fail("must not run"), ensure: () => ({ status: 0 }) });
  assert.match(shots.error, /no story/);
});
