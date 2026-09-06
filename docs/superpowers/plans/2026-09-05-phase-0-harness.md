# Phase 0 (Harness) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable pipeline repository whose `sdlc` command can create a project from a saved config, install into it, run the structural checks, open a local proposal and record a ruling, and generate the state site; then use it to create the marketplace project and pass the phase 0 exit check.

**Architecture:** One Node package (`agentic-sdlc`) with a thin CLI dispatching to command modules. All state is files in the project repo plus git branches. Checks are pure functions returning `{id, ok, messages}` so the same code runs locally and in CI. Templates are copied once at project creation; the pipeline is otherwise referenced, never copied. The project repo is only ever produced by the pipeline.

**Tech Stack:** Node 24 (ESM, `node:test`, no test framework), exact-pinned `yaml` and `ajv` as the only dependencies, git and the GitHub CLI as external tools, bash for the Claude Code hook.

## Global Constraints

Copied from the design spec (`docs/specs/2026-09-05-marketplace-rebuild-pipeline-design.md`):

- "The pipeline repository is edited by hand. The project repository is only ever produced and changed by the pipeline."
- "Nothing in the pipeline repository, its schema, skills or scripts may name the marketplace."
- "No colleague is named, no internal ticket number or meeting is cited, and no private note is referenced by path" in either repository.
- "Nothing is pushed without the tech lead's explicit permission at that moment." No task in this plan pushes anything.
- "The schema rejects unknown keys, so a typo is an error rather than a silent default."
- "Holders are roles... Nothing in the tracked config names a person."
- "A stage is re-runnable... Re-running a stage on unchanged inputs produces a no-op."
- Scripts: "Node, no deps beyond gh and git" applies to scripts installed into project repos. The pipeline package itself may depend on exactly `yaml` and `ajv`, pinned exact (decision record 0001, Task 1).
- Phase 0 exit criterion: "Checkpoint checks green on an empty proposal branch" in the project repo, ruled by the tech-lead role.

---

## File structure

```
agentic-sdlc/
  package.json, package-lock.json, .gitignore, .nvmrc
  bin/sdlc.mjs                      entry: hands argv to src/cli.mjs
  src/cli.mjs                       parse args, dispatch, print, exit code
  src/lib/args.mjs                  parseArgs(argv) -> {pos, flags}
  src/lib/git.mjs                   git(args, cwd) helpers
  src/lib/fsx.mjs                   ensureDir, copyTree, readText, writeText
  src/lib/runrecord.mjs             appendRun(projectDir, line)
  src/config/load.mjs               parseConfig(text), loadConfig(path)
  schema/config.schema.json         the config contract
  src/profiles.mjs                  STAGES, PROFILES
  src/checks/index.mjs              runChecks(projectDir, opts) -> results[]
  src/checks/config.mjs             checkConfig
  src/checks/layout.mjs             checkLayout
  src/checks/constitution.mjs       checkConstitution
  src/checks/egress.mjs             checkEgress
  src/commands/new.mjs              newProject({dir, from})
  src/commands/init.mjs             init(projectDir)
  src/commands/packs.mjs            resolvePacks, installPacks
  src/commands/checks.mjs           CLI wrapper over src/checks
  src/commands/propose.mjs          propose(projectDir, name, {gate, question, recommendation})
  src/commands/rule.mjs             rule(projectDir, name, verdict, {by, note})
  src/commands/status.mjs           buildSite(projectDir)
  src/commands/doctor.mjs           doctor(projectDir)
  templates/project/                copied verbatim into a new project (see Task 6)
  templates/hooks/implement-guard.sh
  templates/workflows/sdlc-checkpoint.yml
  stacks/openshift-ts/SKILL.md      standards skill, first version
  stacks/openshift-ts/README.md
  skills/onboarding/SKILL.md        the interview `sdlc new` runs without --from
  fixture-project/fixture.config.yaml
  test/*.test.mjs
  docs/architecture.md, docs/config.md, docs/dependencies.md
  docs/stages/{new,init,checks,propose,rule,status,doctor}.md
  docs/decisions/0001-node-esm-two-dependencies.md
  .github/workflows/ci.yml
```

---

### Task 1: Package scaffold, CLI entry, argument parser

**Files:**
- Create: `package.json`, `.gitignore`, `.nvmrc`, `bin/sdlc.mjs`, `src/cli.mjs`, `src/lib/args.mjs`, `docs/decisions/0001-node-esm-two-dependencies.md`
- Test: `test/args.test.mjs`, `test/cli.test.mjs`

**Interfaces:**
- Produces: `parseArgs(argv: string[]) -> {pos: string[], flags: Record<string, string|true>}`; `main(argv) -> Promise<number>` in `src/cli.mjs` with a `COMMANDS` map `{name: async ({pos, flags}) => number}` that later tasks add to.

- [ ] **Step 1: Write the failing tests**

```js
// test/args.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/lib/args.mjs";

test("positionals and flags", () => {
  const r = parseArgs(["new", "../proj", "--from", "c.yaml", "--quiet"]);
  assert.deepEqual(r.pos, ["new", "../proj"]);
  assert.deepEqual(r.flags, { from: "c.yaml", quiet: true });
});

test("flag followed by flag is boolean", () => {
  const r = parseArgs(["checks", "--self", "--json"]);
  assert.deepEqual(r.flags, { self: true, json: true });
});
```

```js
// test/cli.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.mjs";

test("unknown command returns 2", async () => {
  const code = await main(["nope"]);
  assert.equal(code, 2);
});

test("help returns 0", async () => {
  assert.equal(await main(["help"]), 0);
  assert.equal(await main([]), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/alstruk/GitHub/agentic-sdlc && npm test`
Expected: FAIL, cannot find module `src/lib/args.mjs`

- [ ] **Step 3: Write the scaffold**

```json
// package.json
{
  "name": "agentic-sdlc",
  "version": "0.1.0",
  "private": true,
  "description": "Agentic SDLC pipeline: skills, checks, workflows and a runner a project installs by reference.",
  "type": "module",
  "bin": { "sdlc": "bin/sdlc.mjs" },
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test",
    "check": "node bin/sdlc.mjs checks --self"
  },
  "license": "Apache-2.0"
}
```

```
# .gitignore
node_modules/
site/
*.local.yaml
*.local.txt
```

`.nvmrc` contains `24`.

```js
// bin/sdlc.mjs
#!/usr/bin/env node
import { main } from "../src/cli.mjs";
process.exitCode = await main(process.argv.slice(2));
```

```js
// src/lib/args.mjs
export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return { pos, flags };
}
```

```js
// src/cli.mjs
import { parseArgs } from "./lib/args.mjs";

export const COMMANDS = {};

const HELP = `sdlc <command> [args] [--flags]

  new <dir> --from <config.yaml>   create a project repo from a saved config
  new <dir> --interactive          create a project repo via the onboarding interview
  new <dir> --answers <brief.md>   run the interview against a written stakeholder brief (no person needed)
  init [dir]                       install the pipeline into a project (lockfile, packs, callers)
  checks [dir] [--self] [--json]   run the structural checks
  propose <name> --gate G1 --question "..." --recommendation "..."
  rule <name> approve|return --by <role> [--note "..."]
  status [dir]                     regenerate the state site
  doctor [dir]                     check tools, config and guardrails
`;

export async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  if (!cmd || cmd === "help" || flags.help) { console.log(HELP); return 0; }
  const fn = COMMANDS[cmd];
  if (!fn) { console.error(`unknown command: ${cmd}\n${HELP}`); return 2; }
  try { return await fn({ pos: rest, flags }); }
  catch (e) { console.error(e.message); return 1; }
}
```

```markdown
<!-- docs/decisions/0001-node-esm-two-dependencies.md -->
# 0001 — Node ESM, node:test, and exactly two dependencies

**Status:** accepted · 2026-09-05

**Decision.** The pipeline package is Node (>=22) using ES modules and the
built-in `node:test` runner. It depends on exactly two packages, pinned to
exact versions: `yaml` to read configuration, `ajv` to validate it against the
schema. Scripts copied into a project repository depend on nothing but git and
the GitHub CLI.

**Why.** The design spec wants deterministic scripts a team can read and run
anywhere GitHub Actions runs. Node is already on every runner and on the
platform's quickstart. A test framework, a CLI framework and a logging library
would each add a dependency surface with no benefit at this size. YAML parsing
and JSON Schema validation are the two things not worth hand-writing.

**Consequences.** Argument parsing is a 15-line function. Tests use
`node:test` and temporary directories. Upgrading a dependency is a deliberate
commit, and the dependency register lists both.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 4 passing

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore .nvmrc bin src test docs/decisions
git commit -m "feat: package scaffold, CLI entry and argument parser"
```

---

### Task 2: Config schema and loader

**Files:**
- Create: `schema/config.schema.json`, `src/config/load.mjs`, `docs/config.md`
- Modify: `package.json` (add dependencies)
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces: `parseConfig(text: string) -> {config: object, errors: string[]}`; `loadConfig(path: string) -> same`. `config.profile` is one of `greenfield|rebuild|remediation|feature`. `config.policy.gates[G] = {holder: string, escalate_to?: string, human_sample_per_week?: number}` where `holder` is a role name or `agent:<persona>`. `config.skills.packs[] = {repo, ref, skills: string[], enabled?: boolean}`.

- [ ] **Step 1: Install the two dependencies, pinned exact**

Run: `npm install --save-exact ajv@8 yaml@2 && node -e "const p=require('./package.json');console.log(p.dependencies)"`
Expected: prints exact versions for `ajv` and `yaml` (record them in `docs/dependencies.md` in Task 13).

- [ ] **Step 2: Write the failing tests**

```js
// test/config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config/load.mjs";

const GOOD = `
pipeline: { repo: agentic-sdlc, ref: v0.1.0 }
profile: rebuild
stack: openshift-ts
project:
  name: example-service
  domains: [accounts, orders]
sources:
  old: { repo: https://example.org/old.git, commit: 0123456789abcdef0123456789abcdef01234567, docs: [README.md], exclude: [tests/] }
oracle: { target: old, compose: sources/old/docker-compose.yml, seed: tests/seed/, base_url: http://localhost:3000, identity: session-route }
targets:
  new: { base_url: http://localhost:8080, identity: sandbox-idp }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead, human_sample_per_week: 5 }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
  rungs: {}
  triage: { direct_max_files: 3, direct_allowed_paths: [app/] }
  budgets: { archaeology: 4000000, build: 3000000 }
skills:
  packs:
    - { repo: mattpocock/skills, ref: 0123456789abcdef0123456789abcdef01234567, skills: [grilling, tdd] }
  extra: []
egress:
  rules: [E-1, E-2, E-3, E-4]
`;

test("valid config has no errors", () => {
  const { config, errors } = parseConfig(GOOD);
  assert.deepEqual(errors, []);
  assert.equal(config.profile, "rebuild");
});

test("unknown key is an error", () => {
  const { errors } = parseConfig(GOOD + "\nextra_key: 1\n");
  assert.ok(errors.some((e) => e.includes("additional")), errors.join("\n"));
});

test("bad profile is an error", () => {
  const { errors } = parseConfig(GOOD.replace("profile: rebuild", "profile: bespoke"));
  assert.ok(errors.length > 0);
});

test("a person-looking holder is rejected: holders are roles or agent:persona", () => {
  const { errors } = parseConfig(GOOD.replace("G1: { holder: tech-lead }", "G1: { holder: alex.struk }"));
  assert.ok(errors.length > 0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/config.test.mjs`
Expected: FAIL, cannot find module `src/config/load.mjs`

- [ ] **Step 4: Write the schema and loader**

```json
// schema/config.schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "agentic-sdlc project configuration",
  "type": "object",
  "additionalProperties": false,
  "required": ["pipeline", "profile", "stack", "project", "policy", "skills", "egress"],
  "properties": {
    "pipeline": { "type": "object", "additionalProperties": false, "required": ["repo", "ref"],
      "properties": { "repo": { "type": "string" }, "ref": { "type": "string" } } },
    "profile": { "enum": ["greenfield", "rebuild", "remediation", "feature"] },
    "stack": { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "project": { "type": "object", "additionalProperties": false, "required": ["name", "domains"],
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z0-9-]+$" },
        "domains": { "type": "array", "minItems": 1, "items": { "type": "string", "pattern": "^[a-z0-9-]+$" } } } },
    "sources": { "type": "object", "additionalProperties": false,
      "properties": { "old": { "$ref": "#/definitions/source" } } },
    "oracle": { "type": "object", "additionalProperties": false, "required": ["target", "compose", "seed", "base_url", "identity"],
      "properties": {
        "target": { "type": "string" }, "compose": { "type": "string" }, "seed": { "type": "string" },
        "base_url": { "type": "string", "format": "uri" }, "identity": { "enum": ["session-route", "sandbox-idp"] } } },
    "targets": { "type": "object", "additionalProperties": { "$ref": "#/definitions/target" } },
    "policy": { "type": "object", "additionalProperties": false, "required": ["gates", "default_tier"],
      "properties": {
        "gates": { "type": "object", "additionalProperties": false,
          "required": ["G0", "G1", "G-DESIGN", "G2", "G3", "G-POL"],
          "properties": {
            "G0": { "$ref": "#/definitions/gate" }, "G1": { "$ref": "#/definitions/gate" },
            "G-DESIGN": { "$ref": "#/definitions/gate" }, "G2": { "$ref": "#/definitions/gate" },
            "G3": { "$ref": "#/definitions/gate" }, "G-POL": { "$ref": "#/definitions/gate" } } },
        "default_tier": { "enum": ["LOW", "STANDARD", "HIGH", "CRITICAL"] },
        "rungs": { "type": "object", "additionalProperties": { "type": "string" } },
        "triage": { "type": "object", "additionalProperties": false,
          "properties": { "direct_max_files": { "type": "integer", "minimum": 1 },
                          "direct_allowed_paths": { "type": "array", "items": { "type": "string" } } } },
        "budgets": { "type": "object", "additionalProperties": { "type": "integer", "minimum": 1 } } } },
    "skills": { "type": "object", "additionalProperties": false, "required": ["packs"],
      "properties": {
        "packs": { "type": "array", "items": { "$ref": "#/definitions/pack" } },
        "extra": { "type": "array", "items": { "type": "string" } } } },
    "egress": { "type": "object", "additionalProperties": false, "required": ["rules"],
      "properties": { "rules": { "type": "array", "items": { "enum": ["E-1", "E-2", "E-3", "E-4"] } } } }
  },
  "definitions": {
    "source": { "type": "object", "additionalProperties": false, "required": ["repo", "commit"],
      "properties": {
        "repo": { "type": "string" }, "commit": { "type": "string", "pattern": "^[0-9a-f]{7,40}$" },
        "docs": { "type": "array", "items": { "type": "string" } },
        "exclude": { "type": "array", "items": { "type": "string" } } } },
    "target": { "type": "object", "additionalProperties": false, "required": ["base_url", "identity"],
      "properties": { "base_url": { "type": "string", "format": "uri" }, "identity": { "enum": ["session-route", "sandbox-idp"] } } },
    "gate": { "type": "object", "additionalProperties": false, "required": ["holder"],
      "properties": {
        "holder": { "type": "string", "pattern": "^(agent:)?[a-z][a-z0-9-]*$" },
        "escalate_to": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
        "human_sample_per_week": { "type": "integer", "minimum": 0 } } },
    "pack": { "type": "object", "additionalProperties": false, "required": ["repo", "ref", "skills"],
      "properties": {
        "repo": { "type": "string" }, "ref": { "type": "string" },
        "skills": { "type": "array", "items": { "type": "string" } },
        "enabled": { "type": "boolean" } } }
  }
}
```

The holder pattern is what enforces "roles, not people": `alex.struk` fails because of the dot, and the docs (Task 13) say role names are lowercase words joined by hyphens.

```js
// src/config/load.mjs
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import Ajv from "ajv";
import schema from "../../schema/config.schema.json" with { type: "json" };

const ajv = new Ajv({ allErrors: true, strict: true, formats: { uri: /^https?:\/\/\S+$/ } });
const validate = ajv.compile(schema);

export function parseConfig(text) {
  const config = parse(text);
  const ok = validate(config);
  const errors = ok ? [] : validate.errors.map((e) => `${e.instancePath || "/"}: ${e.message}`);
  return { config, errors };
}

export function loadConfig(path) {
  return parseConfig(readFileSync(path, "utf8"));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/config.test.mjs`
Expected: 4 passing. If ajv complains about the `format` keyword under `strict`, keep `formats` as shown (a regex format definition satisfies strict mode).

- [ ] **Step 6: Write the configuration reference**

`docs/config.md`: one heading per top-level key, one line per field with type and meaning, copied from the schema, plus the two rules the schema enforces silently: unknown keys are errors, and gate holders are roles (`tech-lead`, `ux-reviewer`) or `agent:<persona>`; people are bound to roles only where a remote needs it (code owners for pull-request approval), never in tracked config.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json schema src/config test/config.test.mjs docs/config.md
git commit -m "feat: config schema and loader with role-only gate holders"
```

---

### Task 3: Profiles and stage list

**Files:**
- Create: `src/profiles.mjs`
- Test: `test/profiles.test.mjs`

**Interfaces:**
- Produces: `STAGES: string[]` (the fifteen stage names in order), `PROFILES: Record<profile, string[]>`, `stagesFor(profile) -> string[]`.

- [ ] **Step 1: Write the failing test**

```js
// test/profiles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGES, PROFILES, stagesFor } from "../src/profiles.mjs";

test("fifteen stages in spec order", () => {
  assert.deepEqual(STAGES, ["init","intent","archaeology","ratify","derive-tests","bind-adapter",
    "calibrate","design","plan","build","verify","review-and-ship","deploy","operate","status"]);
});

test("profiles select stages as the spec says", () => {
  assert.ok(!stagesFor("greenfield").includes("archaeology"));
  assert.ok(!stagesFor("greenfield").includes("calibrate"));
  assert.deepEqual(stagesFor("rebuild"), STAGES);
  assert.ok(!stagesFor("remediation").includes("intent"));
  assert.ok(!stagesFor("remediation").includes("design"));
  assert.deepEqual(stagesFor("feature"), ["init","intent","plan","build","verify","review-and-ship","deploy","status"]);
  assert.throws(() => stagesFor("bespoke"));
  assert.equal(Object.keys(PROFILES).length, 4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/profiles.test.mjs` — Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```js
// src/profiles.mjs
export const STAGES = ["init","intent","archaeology","ratify","derive-tests","bind-adapter",
  "calibrate","design","plan","build","verify","review-and-ship","deploy","operate","status"];

const without = (...drop) => STAGES.filter((s) => !drop.includes(s));

export const PROFILES = {
  greenfield: without("archaeology", "calibrate"),
  rebuild: [...STAGES],
  remediation: without("intent", "design"),
  feature: ["init","intent","plan","build","verify","review-and-ship","deploy","status"],
};

export function stagesFor(profile) {
  const s = PROFILES[profile];
  if (!s) throw new Error(`unknown profile: ${profile}`);
  return s;
}
```

- [ ] **Step 4: Run test, expect pass. Commit**

```bash
git add src/profiles.mjs test/profiles.test.mjs
git commit -m "feat: stage list and profiles"
```

---

### Task 4: Git, filesystem and run-record helpers

**Files:**
- Create: `src/lib/git.mjs`, `src/lib/fsx.mjs`, `src/lib/runrecord.mjs`
- Test: `test/lib.test.mjs`

**Interfaces:**
- Produces: `git(args: string[], cwd) -> string` (trimmed stdout, throws on non-zero); `gitOk(args, cwd) -> boolean`; `ensureDir(p)`; `copyTree(src, dst)` (recursive, does not overwrite existing files); `readText(p)`, `writeText(p, text)` (creates parent dirs); `appendRun(projectDir, line: string) -> path` writing `.sdlc/runs/YYYY-MM-DD.md` with a `- HH:MM:SS line` entry.

- [ ] **Step 1: Write the failing test**

```js
// test/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk } from "../src/lib/git.mjs";
import { copyTree, writeText, readText } from "../src/lib/fsx.mjs";
import { appendRun } from "../src/lib/runrecord.mjs";

test("git wrapper runs and reports", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-git-"));
  git(["init", "-q", "-b", "main"], d);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.equal(gitOk(["rev-parse", "--verify", "nope"], d), false);
});

test("copyTree copies without overwriting", () => {
  const src = mkdtempSync(join(tmpdir(), "sdlc-src-"));
  const dst = mkdtempSync(join(tmpdir(), "sdlc-dst-"));
  mkdirSync(join(src, "a/b"), { recursive: true });
  writeFileSync(join(src, "a/b/f.txt"), "new");
  writeFileSync(join(dst, "keep.txt"), "old");
  mkdirSync(join(dst, "a/b"), { recursive: true });
  writeFileSync(join(dst, "a/b/f.txt"), "existing");
  copyTree(src, dst);
  assert.equal(readFileSync(join(dst, "a/b/f.txt"), "utf8"), "existing");
  assert.ok(existsSync(join(dst, "keep.txt")));
});

test("run record appends dated lines", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-run-"));
  const p = appendRun(d, "init: installed 2 packs");
  assert.match(readText(p), /^- \d\d:\d\d:\d\d init: installed 2 packs$/m);
  assert.match(p, /\.sdlc\/runs\/\d{4}-\d\d-\d\d\.md$/);
});
```

- [ ] **Step 2: Run, expect module-not-found failures**

- [ ] **Step 3: Implement**

```js
// src/lib/git.mjs
import { execFileSync } from "node:child_process";
export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function gitOk(args, cwd) {
  try { git(args, cwd); return true; } catch { return false; }
}
```

```js
// src/lib/fsx.mjs
import { mkdirSync, readdirSync, statSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
export function ensureDir(p) { mkdirSync(p, { recursive: true }); }
export function readText(p) { return readFileSync(p, "utf8"); }
export function writeText(p, text) { ensureDir(dirname(p)); writeFileSync(p, text); }
export function copyTree(src, dst) {
  ensureDir(dst);
  for (const name of readdirSync(src)) {
    const s = join(src, name), d = join(dst, name);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else if (!existsSync(d)) copyFileSync(s, d);
  }
}
```

```js
// src/lib/runrecord.mjs
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./fsx.mjs";
export function appendRun(projectDir, line) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hms = now.toTimeString().slice(0, 8);
  const dir = join(projectDir, ".sdlc", "runs");
  ensureDir(dir);
  const p = join(dir, `${day}.md`);
  if (!existsSync(p)) appendFileSync(p, `# Run record ${day}\n\n`);
  appendFileSync(p, `- ${hms} ${line}\n`);
  return p;
}
```

- [ ] **Step 4: Run tests, expect 3 passing. Commit**

```bash
git add src/lib test/lib.test.mjs
git commit -m "feat: git, filesystem and run-record helpers"
```

---

### Task 5: The four structural checks

**Files:**
- Create: `src/checks/index.mjs`, `src/checks/config.mjs`, `src/checks/layout.mjs`, `src/checks/constitution.mjs`, `src/checks/egress.mjs`
- Test: `test/checks.test.mjs`

**Interfaces:**
- Produces: each check is `(projectDir, ctx) -> {id, ok, messages: string[], warnings?: string[]}` where `ctx = {config?: object, self?: boolean}`. `runChecks(projectDir, {self}) -> Promise<results[]>`. `checkEgress` reads the name list from, in order: the file named by env `SDLC_EGRESS_NAMES`, `<projectDir>/.sdlc/egress.local.txt`, then the fixed default `~/.config/agentic-sdlc/egress-names.txt`; one name per line, `#` comments allowed. It scans only git-tracked text files. If no list exists or it is empty, the check still passes but carries a warning naming the default path, so a new installer sees what to fill in. `sdlc init` creates the default file with a comment header if it does not exist (Task 8).

- [ ] **Step 1: Write the failing tests**

```js
// test/checks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { checkConstitution } from "../src/checks/constitution.mjs";
import { checkEgress } from "../src/checks/egress.mjs";
import { checkLayout } from "../src/checks/layout.mjs";

function repo() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-chk-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  return d;
}

const GOOD_CONSTITUTION = `# Constitution — Example
## Platform articles
### P1 — Accessibility
All interfaces SHALL meet WCAG 2.1 AA.
Source: https://digital.gov.bc.ca/design/wcag/intro/
### P2 — Design system
Use the design system.
Source: convention
`;

test("constitution: placeholders and missing sources fail", () => {
  const d = repo();
  writeFileSync(join(d, "constitution.md"), GOOD_CONSTITUTION.replace("Source: convention", ""));
  let r = checkConstitution(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("P2")));
  writeFileSync(join(d, "constitution.md"), GOOD_CONSTITUTION + "### P3 — {{FILL ME}}\nSource: convention\n");
  r = checkConstitution(d, {});
  assert.equal(r.ok, false);
  writeFileSync(join(d, "constitution.md"), GOOD_CONSTITUTION);
  assert.equal(checkConstitution(d, {}).ok, true);
});

test("egress: ticket numbers, notes paths and listed names are caught in tracked files only", () => {
  const d = repo();
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, "a.md"), "See ticket AB-1234 and the folder !Private/notes\n");
  writeFileSync(join(d, "b.md"), "Jane Example agreed on the Teams call\n");
  writeFileSync(join(d, ".sdlc/egress.local.txt"), "Jane Example\n");
  writeFileSync(join(d, "untracked.md"), "AB-9999\n");
  git(["add", "a.md", "b.md"], d);
  const r = checkEgress(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("a.md") && m.includes("ticket")));
  assert.ok(r.messages.some((m) => m.includes("a.md") && m.includes("private notes")));
  assert.ok(r.messages.some((m) => m.includes("b.md") && m.includes("name")));
  assert.ok(r.messages.some((m) => m.includes("b.md") && m.includes("meeting")));
  assert.ok(!r.messages.some((m) => m.includes("untracked.md")));
});

test("egress: no name list is a warning, not a failure", () => {
  const d = repo();
  writeFileSync(join(d, "clean.md"), "nothing here\n"); git(["add", "clean.md"], d);
  const r = checkEgress(d, {});
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length === 1 && r.warnings[0].includes("egress-names.txt"));
});

test("layout: required paths for a rebuild project", () => {
  const d = repo();
  const r = checkLayout(d, { config: { profile: "rebuild" } });
  assert.equal(r.ok, false);
  for (const p of ["constitution.md", ".sdlc/config.yaml", "spec", "tests/acceptance", "evidence/pr-evidence.md"]) {
    mkdirSync(join(d, p.includes(".") ? p.split("/").slice(0, -1).join("/") || "." : p), { recursive: true });
    if (p.includes(".")) writeFileSync(join(d, p), "");
  }
  for (const p of ["intent", "design", "plan", "app", "tests/adapters", "tests/seed", "spec/features", "spec/contract"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, ".sdlc/lock.json"), "{}");
  assert.equal(checkLayout(d, { config: { profile: "rebuild" } }).ok, true);
});
```

- [ ] **Step 2: Run, expect module-not-found failures**

- [ ] **Step 3: Implement the checks**

```js
// src/checks/constitution.mjs
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fsx.mjs";

export function checkConstitution(projectDir) {
  const id = "constitution";
  const p = join(projectDir, "constitution.md");
  if (!existsSync(p)) return { id, ok: false, messages: ["constitution.md is missing"] };
  const text = readText(p);
  const messages = [];
  if (/\{\{[^}]*\}\}/.test(text)) messages.push("constitution.md still contains {{placeholders}}");
  const articles = text.split(/^### /m).slice(1);
  for (const a of articles) {
    const title = a.split("\n")[0].trim();
    if (!/^P\d+ /.test(title)) continue;
    const src = a.match(/^Source:\s*(.+)$/m);
    if (!src) messages.push(`${title.split(" ")[0]}: no "Source:" line (a URL, or the word convention)`);
    else if (!(src[1].trim() === "convention" || /^https?:\/\//.test(src[1].trim())))
      messages.push(`${title.split(" ")[0]}: Source must be a URL or "convention"`);
  }
  if (articles.filter((a) => /^P\d+ /.test(a)).length === 0) messages.push("no platform articles (### P1 …) found");
  return { id, ok: messages.length === 0, messages };
}
```

```js
// src/checks/egress.mjs
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "../lib/git.mjs";
import { readText } from "../lib/fsx.mjs";

const PATTERNS = [
  [/\b[A-Z]{2,5}-\d{2,5}\b/, "internal ticket number (rule E-2)"],
  [/(^|[\s"'(])![A-Z][A-Za-z]+\//, "private notes folder path (rule E-2)"],
  [/OneDrive/, "private notes location (rule E-2)"],
  [/\bTeams (call|chat|transcript|message|meeting)\b/i, "meeting reference (rule E-2)"],
  [/\.vtt\b/, "transcript file reference (rule E-2)"],
];
const TEXT_EXT = /\.(md|mjs|js|ts|tsx|json|ya?ml|txt|sh|feature|svg|py|html|css)$/i;

import { homedir } from "node:os";
export const DEFAULT_NAMES = join(homedir(), ".config", "agentic-sdlc", "egress-names.txt");

function nameList(projectDir) {
  const candidates = [process.env.SDLC_EGRESS_NAMES, join(projectDir, ".sdlc", "egress.local.txt"), DEFAULT_NAMES].filter(Boolean);
  for (const c of candidates) if (existsSync(c))
    return readText(c).split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  return [];
}

export function checkEgress(projectDir, ctx = {}) {
  const id = "egress";
  const names = nameList(projectDir);
  const warnings = names.length ? [] : [`no egress name list found; add colleagues' names, one per line, to ${DEFAULT_NAMES}`];
  const files = git(["ls-files"], projectDir).split("\n").filter((f) => f && TEXT_EXT.test(f) && !f.startsWith(".sdlc/packs/"));
  const scoped = ctx.self ? files.filter((f) => f.startsWith("docs/") || f.startsWith("skills/") || f.startsWith("templates/") || f.startsWith("stacks/")) : files;
  const messages = [];
  for (const f of scoped) {
    const lines = readText(join(projectDir, f)).split("\n");
    lines.forEach((line, i) => {
      for (const [re, why] of PATTERNS) if (re.test(line)) messages.push(`${f}:${i + 1}: ${why}`);
      for (const n of names) if (line.includes(n)) messages.push(`${f}:${i + 1}: listed name (rule E-2)`);
    });
  }
  return { id, ok: messages.length === 0, messages, warnings };
}
```

Note: the ticket pattern is generic on purpose (two to five capitals, a dash, digits). Version strings like `v0.1.0` and IDs like `R-12.3` do not match because they have no run of two capitals before the dash. If a legitimate token ever matches, the fix is an allowlist file, not a weaker pattern.

```js
// src/checks/layout.mjs
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stagesFor } from "../profiles.mjs";

const ALWAYS = ["constitution.md", ".sdlc/config.yaml", ".sdlc/lock.json", "intent", "spec", "spec/features",
  "spec/contract", "plan", "app", "evidence/pr-evidence.md", "tests/acceptance", "tests/adapters", "tests/seed"];
const BY_STAGE = { design: ["design"] };

export function checkLayout(projectDir, ctx = {}) {
  const id = "layout";
  const profile = ctx.config?.profile ?? "rebuild";
  const required = [...ALWAYS];
  for (const s of stagesFor(profile)) for (const p of BY_STAGE[s] ?? []) required.push(p);
  const messages = required.filter((p) => !existsSync(join(projectDir, p))).map((p) => `missing: ${p}`);
  return { id, ok: messages.length === 0, messages };
}
```

```js
// src/checks/config.mjs
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load.mjs";
import { stagesFor } from "../profiles.mjs";

export function checkConfig(projectDir) {
  const id = "config";
  const p = join(projectDir, ".sdlc", "config.yaml");
  if (!existsSync(p)) return { id, ok: false, messages: [".sdlc/config.yaml is missing"], config: null };
  const { config, errors } = loadConfig(p);
  const messages = [...errors];
  try { stagesFor(config?.profile); } catch (e) { messages.push(e.message); }
  return { id, ok: messages.length === 0, messages, config };
}
```

```js
// src/checks/index.mjs
import { checkConfig } from "./config.mjs";
import { checkLayout } from "./layout.mjs";
import { checkConstitution } from "./constitution.mjs";
import { checkEgress } from "./egress.mjs";

export async function runChecks(projectDir, opts = {}) {
  if (opts.self) return [checkEgress(projectDir, { self: true })];
  const cfg = checkConfig(projectDir);
  const ctx = { config: cfg.config };
  return [cfg, checkLayout(projectDir, ctx), checkConstitution(projectDir, ctx), checkEgress(projectDir, ctx)];
}
```

- [ ] **Step 4: Run tests, expect 3 passing. Commit**

```bash
git add src/checks test/checks.test.mjs
git commit -m "feat: structural checks for config, layout, constitution and egress"
```

---

### Task 6: Project templates, Claude Code hook, persona briefs

**Files:**
- Create under `templates/project/`: `constitution.md`, `.gitignore`, `.claude/settings.json`, `.sdlc/personas/product-owner.md`, `.sdlc/personas/architect.md`, `.sdlc/personas/reviewer.md`, `intent/.template.md`, `spec/spec.md`, `spec/features/.gitkeep`, `spec/contract/personas.yaml`, `spec/contract/surface.yaml`, `spec/contract/observables.yaml`, `spec/contract/openapi.yaml`, `tests/acceptance/.gitkeep`, `tests/adapters/.gitkeep`, `tests/seed/.gitkeep`, `design/DESIGN.md`, `plan/plan.md`, `plan/tasks.md`, `app/.gitkeep`, `evidence/pr-evidence.md`
- Create: `templates/hooks/implement-guard.sh`, `templates/workflows/sdlc-checkpoint.yml`
- Test: `test/hook.test.mjs`

**Interfaces:**
- Produces: the hook reads Claude Code's PreToolUse JSON on stdin (`tool_input.file_path`), consults `SDLC_STAGE`, and exits 2 with a message on stderr to block. Stages and their protected paths are in the script and documented in `docs/stages/init.md` (Task 13).

- [ ] **Step 1: Write the failing hook test**

```js
// test/hook.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const HOOK = new URL("../templates/hooks/implement-guard.sh", import.meta.url).pathname;
function run(path, stage) {
  return spawnSync("bash", [HOOK], { input: JSON.stringify({ tool_input: { file_path: path } }),
    env: { ...process.env, SDLC_STAGE: stage ?? "" }, encoding: "utf8" });
}

test("build stage cannot edit spec, acceptance tests, constitution or config", () => {
  for (const p of ["spec/spec.md", "tests/acceptance/x.spec.ts", "constitution.md", ".sdlc/config.yaml", ".github/workflows/a.yml"])
    assert.equal(run(p, "build").status, 2, p);
  assert.equal(run("app/src/index.ts", "build").status, 0);
});

test("derive-tests stage cannot see app or adapters", () => {
  assert.equal(run("app/src/index.ts", "derive-tests").status, 2);
  assert.equal(run("tests/adapters/new/a.ts", "derive-tests").status, 2);
  assert.equal(run("tests/acceptance/x.spec.ts", "derive-tests").status, 0);
});

test("spec stages may edit spec but not app or tests", () => {
  assert.equal(run("spec/spec.md", "archaeology").status, 0);
  assert.equal(run("app/x.ts", "archaeology").status, 2);
  assert.equal(run("tests/acceptance/x.ts", "ratify").status, 2);
});

test("unset stage behaves like build", () => {
  assert.equal(run("spec/spec.md", "").status, 2);
});
```

- [ ] **Step 2: Run, expect failures (hook file missing)**

- [ ] **Step 3: Write the hook**

```bash
#!/usr/bin/env bash
# templates/hooks/implement-guard.sh — Claude Code PreToolUse hook.
# Blocks edits outside the paths the current pipeline stage may touch.
# Stage comes from SDLC_STAGE; unset means "build", the most restrictive default.
set -uo pipefail

path="$(node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  try { const j=JSON.parse(s); const t=j.tool_input||{}; console.log(t.file_path||t.path||t.notebook_path||""); }
  catch { console.log(""); }
});')"
[[ -z "$path" ]] && exit 0
rel="${path#"$PWD"/}"

stage="${SDLC_STAGE:-build}"
case "$stage" in
  build|verify|review-and-ship)
    blocked='^(spec/|tests/acceptance/|constitution\.md$|\.sdlc/config\.yaml$|\.github/workflows/)' ;;
  derive-tests)
    blocked='^(app/|tests/adapters/|tests/seed/|spec/|constitution\.md$|\.sdlc/)' ;;
  bind-adapter)
    blocked='^(app/|tests/acceptance/|spec/|constitution\.md$|\.sdlc/)' ;;
  intent|archaeology|ratify|design|plan)
    blocked='^(app/|tests/acceptance/|tests/adapters/|\.github/workflows/|\.sdlc/config\.yaml$)' ;;
  *)
    blocked='^$' ;;
esac

if [[ "$rel" =~ $blocked ]]; then
  echo "sdlc implement guard: stage '$stage' may not edit '$rel'. Run the stage that owns this path, or set SDLC_STAGE." >&2
  exit 2
fi
exit 0
```

`.claude/settings.json` template. The `permissions.deny` list is the local
enforcement of "agents propose, never merge": no push, no merge, no skipped
hooks, no live cluster, no secrets. It is tracked, so every project gets it,
and it applies only to the agent, never to a person's shell.

```json
{
  "permissions": {
    "deny": [
      "Bash(git push*)", "Bash(git merge*)", "Bash(git rebase*)", "Bash(git reset --hard*)",
      "Bash(git commit --no-verify*)", "Bash(git commit -n *)",
      "Bash(gh pr merge*)", "Bash(gh pr review*)", "Bash(gh pr close*)", "Bash(gh release*)", "Bash(gh secret*)",
      "Bash(oc *)", "Bash(kubectl *)", "Bash(helm *)",
      "Bash(npm publish*)", "Bash(docker push*)",
      "Read(.env*)", "Read(**/*.pem)", "Read(**/*.key)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "bash .sdlc/hooks/implement-guard.sh" }] }
    ]
  }
}
```

The `bcgov/agent-guardrails` shell wrappers are not installed by the pipeline:
they edit a person's shell profile and apply to the person, not the agent.
They stay in the dependency register as an optional extra a team may add.

- [ ] **Step 4: Run the hook test, expect 4 passing**

- [ ] **Step 5: Write the project templates**

`templates/project/constitution.md` (structure from spec-kit's constitution template, content per spec 4.1; every platform article carries a `Source:` line; project articles carry `{{placeholders}}` that `sdlc new` fills from config where it can and the tech lead fills otherwise):

```markdown
# Constitution — {{PROJECT_NAME}}

> Amend by proposal. Platform articles stay; a project exception is recorded
> under J6, never by deleting platform text.

**Service:** {{SERVICE_PURPOSE}}
**Last reviewed:** {{DATE}}

## Platform articles (do not remove)

### P1 — Accessibility
All user-facing interfaces SHALL meet WCAG 2.1 Level AA. Prefer components that encode accessible behaviour. No colour-only status, unlabelled icon buttons, or missing form labels.
Source: https://digital.gov.bc.ca/design/wcag/intro/

### P2 — Design system
New BC Gov services SHOULD use `@bcgov/design-system-react-components`, `@bcgov/design-tokens` and `@bcgov/bc-sans`, and agents SHOULD consult the design system's own agent instructions before generating UI.
Source: https://www2.gov.bc.ca/gov/content/digital/design-system

### P3 — Privacy
No personal information MAY enter a system, log, model prompt or third-party API until a Privacy Impact Assessment appropriate to the classification is complete and recorded. Lower environments use synthetic or anonymised data. No secrets or tokens in the repository.
Source: https://www2.gov.bc.ca/gov/content/governments/services-for-government/information-management-technology/privacy/privacy-impact-assessments

### P4 — Deploy target
Production and lower environments SHALL target OpenShift on the BC Gov Private Cloud PaaS unless a decision record documents an exception.
Source: convention

### P5 — Spec as source of truth
Intent lives in versioned git under `spec/`. Chat is not the system of record. Decisions MUST be reconstructable from git artifacts.
Source: convention

### P6 — Human checkpoints
Humans own spec sign-off (G1), plan approval (G2) and review-and-ship (G3), directly or through a persona agent bound by policy with escalation and sampling. Agents MUST NOT self-merge.
Source: convention

### P7 — Test integrity
Acceptance tests derive from the spec in a workspace that cannot see implementation. The session that writes production code does not solely write the acceptance proof for it.
Source: convention

### P8 — Approved tools
Agents MAY use only the MCP servers, model routes and skill packs listed in `.sdlc/config.yaml` and its lockfile.
Source: convention

## Project articles

### J1 — Service purpose
{{SERVICE_PURPOSE}}

### J2 — In scope / out of scope
- In: {{IN_SCOPE}}
- Out: {{OUT_SCOPE}}

### J3 — Forbidden patterns
{{FORBIDDEN_PATTERNS}}

### J4 — Domain language
| Term | Meaning |
| --- | --- |
| {{TERM}} | {{MEANING}} |

### J5 — Non-functional baselines
{{BASELINES}}

### J6 — Recorded exceptions
| Platform article | Exception | Decision record |
| --- | --- | --- |

### J7 — Development notes
{{DEV_NOTES}}

## Amendment
Platform articles change by a proposal held at G-POL. Project articles change by an ordinary proposal at G2.
```

The four `Source: https://…` lines are verified in Task 15; any that does not state the rule becomes `Source: convention`.

`templates/project/.gitignore`:
```
node_modules/
site/
.sdlc/packs/
.sdlc/*.local.yaml
.sdlc/*.local.txt
```

`templates/project/.sdlc/personas/product-owner.md`:
```markdown
# Persona: product-owner (holds G0 when configured)

## Cares about
The problem is real for a named user group; the outcome is measurable; constraints are stated; every open question is listed rather than answered by guesswork.

## Refuses
- Any intent with an unlisted assumption presented as fact.
- Any criterion still marked `inferred` or `open`.
- Scope that contradicts J2 of the constitution.

## Escalates to the human bound to `escalate_to` when
- The item's tier is HIGH or CRITICAL.
- The producing stage reports confidence below its threshold.
- Two readings of the intent are both plausible.

## Ruling format
One paragraph: the question, the ruling (approve or return), the reason, and what would change the ruling. Written to `.sdlc/gates/<name>.yaml` by `sdlc rule` with `held_by: agent`.
```

`templates/project/.sdlc/personas/architect.md` — same shape; cares about: constitution check completed, every criterion assigned to a task, data model changes each backed by a criterion, no forbidden pattern; refuses a plan with an unassigned criterion or a stack outside the stack profile without a decision record; escalates on tier, on any schema change, or on a dependency not in the register.

`templates/project/.sdlc/personas/reviewer.md` — cares about: the PR does what its slice said, the evidence receipt lists what was checked and what could not be, verify results are green and none stale; refuses evidence-only PRs, unverified provenance without attestation, any diff touching protected paths; escalates on tier, on any residual risk the receipt marks as unaccepted, and on every Nth decision per `human_sample_per_week`.

`templates/project/intent/.template.md`:
```markdown
# Intent: {{TITLE}}
Status: draft

## Problem
Who is stuck and what hurts?

## Proposed outcome
Measurable.

## Affected users and systems

## Constraints

## Evidence
Observations that motivated this intent. Link criterion IDs (@R-xx.y) when known.

## Open questions
- [ ]
```

`templates/project/spec/spec.md`:
```markdown
# Spec — {{PROJECT_NAME}}

> Technology-free. What and why, never how. One section per domain.
> Criterion format: `R-<domain>.<n> (v<version>) [confidence: confirmed|inferred|open]` then the statement,
> then `cites:` lines for recovered criteria and `reconciliation:` for their class.

## Domains
{{DOMAIN_SECTIONS}}
```

`templates/project/spec/contract/personas.yaml`:
```yaml
# Roles a test can act as, and how a test signs in as each on every target.
# identity: sandbox-idp means a Keycloak (or OIDC mock) container seeded with these users.
personas: []
# - id: public-sector-admin
#   can: [create opportunity, publish opportunity, score proposals]
#   sign_in: { sandbox-idp: { username: admin-1 }, session-route: { role: admin } }
```

`templates/project/spec/contract/surface.yaml`:
```yaml
# Pages, and the actions and observations each offers. Test IDs are filled at the design gate.
pages: []
# - id: opportunity
#   route: /opportunities/:id
#   title: "Opportunity"
#   actions: { publish: { test_id: null } }
#   observations: { status: { test_id: null } }
```

`templates/project/spec/contract/observables.yaml`:
```yaml
# Side effects a test may observe, and how.
email: { via: mail-catcher, api: http://localhost:8025 }
files: { via: api }
```

`templates/project/spec/contract/openapi.yaml`:
```yaml
openapi: 3.1.0
info: { title: "{{PROJECT_NAME}} API", version: "0.0.0" }
paths: {}
```

`templates/project/design/DESIGN.md`: Crow's `DESIGN.template.md` structure (front matter with token groups and components, then Overview, Principles, Typography, Colour, Layout and responsive behaviour, Components, Forms and validation, Decisions and service states, Motion, Known gaps), attributed in a one-line comment to `bcgov/crow` with its version.

`templates/project/plan/plan.md`: spec-kit's plan template headings (Summary, Technical Context, Constitution Check, Project Structure, Data model, Contracts, Research) with a one-line attribution comment to `github/spec-kit`.

`templates/project/plan/tasks.md`:
```markdown
# Tasks — {{PROJECT_NAME}}

| Slice | Criteria | Independent of | Done when |
| --- | --- | --- | --- |
```

`templates/project/evidence/pr-evidence.md`:
```markdown
# Evidence — append-only

One receipt per implementation proposal. Never edit a prior receipt.

<!-- receipt template
## <proposal name> · <date>
- Criteria claimed:
- Checked:
- Could not check:
- Residual risk:
-->
```

`templates/workflows/sdlc-checkpoint.yml` (generated into the project; inert until a remote exists):
```yaml
name: sdlc checkpoint
on: { pull_request: {} }
permissions: { contents: read, pull-requests: write }
jobs:
  checks:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: "24" }
      - run: npx --yes github:{{PIPELINE_REPO}}#{{PIPELINE_REF}} checks --json
```

- [ ] **Step 6: Run the whole suite, expect all passing. Commit**

```bash
git add templates test/hook.test.mjs
git commit -m "feat: project templates, Claude Code implement guard, persona briefs"
```

---

### Task 7: Skill packs: resolve and install

**Files:**
- Create: `src/commands/packs.mjs`
- Test: `test/packs.test.mjs`

**Interfaces:**
- Produces: `resolvePacks(packs, cwd) -> [{repo, url, ref, commit, skills, enabled}]` (uses `git ls-remote` when `ref` is not a 40-char sha); `installPacks(projectDir, resolved) -> {installed: string[], skipped: string[]}` cloning each pack to `.sdlc/packs/<name>` at its commit and copying each requested skill folder (found as `**/<skill>/SKILL.md`) into `.claude/skills/<skill>/`. A `repo` of the form `owner/name` maps to `https://github.com/owner/name.git`; anything containing `://` or starting with `/` or `.` is used as-is.

- [ ] **Step 1: Write the failing test (uses a local git repo as the pack)**

```js
// test/packs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { resolvePacks, installPacks, packUrl } from "../src/commands/packs.mjs";

function makePack() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-pack-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "skills/engineering/tdd"), { recursive: true });
  writeFileSync(join(d, "skills/engineering/tdd/SKILL.md"), "---\nname: tdd\n---\n# tdd\n");
  mkdirSync(join(d, "skills/productivity/grilling"), { recursive: true });
  writeFileSync(join(d, "skills/productivity/grilling/SKILL.md"), "---\nname: grilling\n---\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "init"], d);
  return { dir: d, sha: git(["rev-parse", "HEAD"], d) };
}

test("packUrl maps owner/name to GitHub and leaves paths alone", () => {
  assert.equal(packUrl("mattpocock/skills"), "https://github.com/mattpocock/skills.git");
  assert.equal(packUrl("/tmp/x"), "/tmp/x");
  assert.equal(packUrl("https://example.org/a.git"), "https://example.org/a.git");
});

test("resolve pins a branch ref to a commit; install copies the named skills", () => {
  const { dir, sha } = makePack();
  const proj = mkdtempSync(join(tmpdir(), "sdlc-proj-"));
  const resolved = resolvePacks([{ repo: dir, ref: "main", skills: ["tdd", "grilling", "missing"] }], proj);
  assert.equal(resolved[0].commit, sha);
  const r = installPacks(proj, resolved);
  assert.ok(existsSync(join(proj, ".claude/skills/tdd/SKILL.md")));
  assert.ok(existsSync(join(proj, ".claude/skills/grilling/SKILL.md")));
  assert.ok(r.skipped.some((s) => s.includes("missing")));
  const again = installPacks(proj, resolved);
  assert.equal(again.installed.length, 0, "second install is a no-op");
});
```

- [ ] **Step 2: Run, expect module-not-found**

- [ ] **Step 3: Implement**

```js
// src/commands/packs.mjs
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { git, gitOk } from "../lib/git.mjs";
import { copyTree, ensureDir } from "../lib/fsx.mjs";

export function packUrl(repo) {
  if (repo.includes("://") || repo.startsWith("/") || repo.startsWith(".")) return repo;
  return `https://github.com/${repo}.git`;
}
const packName = (repo) => basename(repo.replace(/\.git$/, "")).replace(/[^a-z0-9-]/gi, "-");

export function resolvePacks(packs, cwd) {
  return packs.filter((p) => p.enabled !== false).map((p) => {
    const url = packUrl(p.repo);
    let commit = p.ref;
    if (!/^[0-9a-f]{40}$/.test(p.ref)) {
      const out = git(["ls-remote", url, p.ref], cwd);
      if (!out) throw new Error(`pack ${p.repo}: ref ${p.ref} not found`);
      commit = out.split(/\s/)[0];
    }
    return { repo: p.repo, url, ref: p.ref, commit, skills: p.skills, name: packName(p.repo) };
  });
}

function findSkill(root, skill) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const n of readdirSync(d)) {
      if (n === ".git" || n === "node_modules") continue;
      const p = join(d, n);
      if (!statSync(p).isDirectory()) continue;
      if (n === skill && existsSync(join(p, "SKILL.md"))) return p;
      stack.push(p);
    }
  }
  return null;
}

export function installPacks(projectDir, resolved) {
  const installed = [], skipped = [];
  for (const p of resolved) {
    const dst = join(projectDir, ".sdlc", "packs", p.name);
    if (!existsSync(dst)) { ensureDir(join(projectDir, ".sdlc", "packs")); git(["clone", "-q", p.url, dst], projectDir); }
    if (git(["rev-parse", "HEAD"], dst) !== p.commit) {
      if (!gitOk(["cat-file", "-e", p.commit], dst)) git(["fetch", "-q", "origin", p.commit], dst);
      git(["checkout", "-q", p.commit], dst);
    }
    for (const s of p.skills) {
      const src = findSkill(dst, s);
      const target = join(projectDir, ".claude", "skills", s);
      if (!src) { skipped.push(`${p.repo}: skill ${s} not found`); continue; }
      if (existsSync(join(target, "SKILL.md"))) continue;
      copyTree(src, target); installed.push(`${p.repo}:${s}`);
    }
  }
  return { installed, skipped };
}
```

- [ ] **Step 4: Run tests, expect passing. Commit**

```bash
git add src/commands/packs.mjs test/packs.test.mjs
git commit -m "feat: resolve and install skill packs at pinned commits"
```

---

### Task 8: `sdlc new --from` and `sdlc init`

**Files:**
- Create: `src/commands/new.mjs`, `src/commands/init.mjs`, `skills/onboarding/SKILL.md`
- Modify: `src/cli.mjs` (register `new`, `init`)
- Test: `test/new-init.test.mjs`

**Interfaces:**
- Produces: `newProject({dir, from, interactive, answers}) -> {dir}`: validates the config, creates the directory and a git repo on `main`, copies `templates/project/`, writes `.sdlc/config.yaml`, fills `{{PROJECT_NAME}}`, `{{DATE}}` and `{{DOMAIN_SECTIONS}}` (one `## <domain>` heading per configured domain), installs the hook to `.sdlc/hooks/implement-guard.sh`, commits, then calls `init`. `init(projectDir) -> {lock}`: writes `.sdlc/lock.json` `{pipeline: {repo, ref, commit}, packs: [...resolved], created}` (pipeline commit is the pipeline repo's HEAD when run from a checkout, else the ref), installs packs, writes the checkpoint caller workflow with placeholders filled, appends to the run record, commits if anything changed.

- [ ] **Step 1: Write the failing end-to-end test**

```js
// test/new-init.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runChecks } from "../src/checks/index.mjs";

function makePack() { /* identical to test/packs.test.mjs makePack */ 
  const d = mkdtempSync(join(tmpdir(), "sdlc-pack-"));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "skills/tdd"), { recursive: true }); writeFileSync(join(d, "skills/tdd/SKILL.md"), "---\nname: tdd\n---\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

test("new --from creates a project that passes the structural checks", async () => {
  const pack = makePack();
  const cfgPath = join(mkdtempSync(join(tmpdir(), "sdlc-cfg-")), "example.yaml");
  writeFileSync(cfgPath, `
pipeline: { repo: agentic-sdlc, ref: main }
profile: rebuild
stack: openshift-ts
project: { name: example-service, domains: [accounts, orders] }
sources:
  old: { repo: https://example.org/old.git, commit: 0123456789abcdef0123456789abcdef01234567 }
oracle: { target: old, compose: sources/old/docker-compose.yml, seed: tests/seed/, base_url: http://localhost:3000, identity: session-route }
targets: { new: { base_url: http://localhost:8080, identity: sandbox-idp } }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead, human_sample_per_week: 5 }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [ { repo: ${pack}, ref: main, skills: [tdd] } ] }
egress: { rules: [E-1, E-2, E-3, E-4] }
`);
  const dir = join(mkdtempSync(join(tmpdir(), "sdlc-new-")), "example-service");
  await newProject({ dir, from: cfgPath });
  assert.ok(existsSync(join(dir, ".sdlc/lock.json")));
  assert.ok(existsSync(join(dir, ".claude/skills/tdd/SKILL.md")));
  assert.ok(existsSync(join(dir, ".sdlc/hooks/implement-guard.sh")));
  assert.ok(existsSync(join(dir, ".github/workflows/sdlc-checkpoint.yml")));
  const spec = readFileSync(join(dir, "spec/spec.md"), "utf8");
  assert.match(spec, /## accounts/); assert.match(spec, /## orders/);
  assert.equal(git(["status", "--porcelain"], dir), "", "everything committed");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
  const results = await runChecks(dir);
  const failing = results.filter((r) => !r.ok && r.id !== "constitution");
  assert.deepEqual(failing.map((r) => [r.id, r.messages]), []);
  // constitution still has {{placeholders}} for project articles: expected to fail until filled
  assert.equal(results.find((r) => r.id === "constitution").ok, false);
});
```

- [ ] **Step 2: Run, expect module-not-found**

- [ ] **Step 3: Implement `new` and `init`, and register them**

```js
// src/commands/new.mjs
import { existsSync, readFileSync, copyFileSync, chmodSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../lib/git.mjs";
import { copyTree, ensureDir, readText, writeText } from "../lib/fsx.mjs";
import { parseConfig } from "../config/load.mjs";
import { init } from "./init.mjs";
import { COMMANDS } from "../cli.mjs";

export const PIPELINE_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

export async function newProject({ dir, from, interactive = false, answers = null }) {
  dir = resolve(dir);
  if (existsSync(join(dir, ".sdlc"))) throw new Error(`${dir} already has a .sdlc folder`);
  let text;
  if (from) text = readText(from);
  else if (interactive || answers) text = await onboardingInterview(dir, { answers });
  else throw new Error("sdlc new needs --from <config.yaml>, --interactive, or --answers <file>");
  const { config, errors } = parseConfig(text);
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);

  ensureDir(dir);
  git(["init", "-q", "-b", "main"], dir);
  copyTree(join(PIPELINE_ROOT, "templates", "project"), dir);
  writeText(join(dir, ".sdlc", "config.yaml"), text);
  ensureDir(join(dir, ".sdlc", "hooks"));
  copyFileSync(join(PIPELINE_ROOT, "templates", "hooks", "implement-guard.sh"), join(dir, ".sdlc", "hooks", "implement-guard.sh"));
  chmodSync(join(dir, ".sdlc", "hooks", "implement-guard.sh"), 0o755);

  const fill = (p, map) => writeText(p, Object.entries(map).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), readText(p)));
  const date = new Date().toISOString().slice(0, 10);
  fill(join(dir, "constitution.md"), { PROJECT_NAME: config.project.name, DATE: date });
  fill(join(dir, "spec", "spec.md"), { PROJECT_NAME: config.project.name,
    DOMAIN_SECTIONS: config.project.domains.map((d) => `## ${d}\n\n_No criteria yet._\n`).join("\n") });
  fill(join(dir, "spec", "contract", "openapi.yaml"), { PROJECT_NAME: config.project.name });
  fill(join(dir, "plan", "tasks.md"), { PROJECT_NAME: config.project.name });

  git(["add", "-A"], dir);
  git(["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost", "commit", "-q", "-m", `chore: create ${config.project.name} from agentic-sdlc templates`], dir);
  await init(dir);
  return { dir };
}

async function onboardingInterview(dir, { answers = null } = {}) {
  // Runs the onboarding skill in a Claude Code session and expects it to write <dir>.config.yaml next to dir.
  // With `answers`, a second party answers instead of a person: the file is a written stakeholder brief,
  // and the session is told to interview it and never invent a value the brief does not contain.
  const { execFileSync } = await import("node:child_process");
  const out = `${dir}.config.yaml`;
  const skill = readText(join(PIPELINE_ROOT, "skills", "onboarding", "SKILL.md"));
  const schema = readText(join(PIPELINE_ROOT, "schema", "config.schema.json"));
  let prompt = `${skill}\n\nThe configuration schema is:\n${schema}\n\nWrite the finished configuration to ${out} and nothing else.`;
  if (answers) prompt += `\n\nThere is no person to ask. Answer every question only from this stakeholder brief; where the brief is silent, leave the field out if optional or write a schema-valid placeholder and list it under a top-of-file comment "# open:".\n\n${readText(answers)}`;
  const args = answers ? ["-p", prompt, "--allowedTools", "Write"] : ["-p", prompt, "--allowedTools", "Write"];
  execFileSync("claude", args, { stdio: answers ? "pipe" : "inherit" });
  if (!existsSync(out)) throw new Error("onboarding did not produce a config file");
  return readText(out);
}

COMMANDS.new = async ({ pos, flags }) => {
  const r = await newProject({ dir: pos[0], from: flags.from, interactive: !!flags.interactive, answers: flags.answers ?? null });
  console.log(`created ${r.dir}`);
  return 0;
};
```

```js
// src/commands/init.mjs
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, gitOk } from "../lib/git.mjs";
import { readText, writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { resolvePacks, installPacks } from "./packs.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { DEFAULT_NAMES } from "../checks/egress.mjs";
import { COMMANDS } from "../cli.mjs";
import { PIPELINE_ROOT } from "./new.mjs";

export async function init(projectDir = process.cwd()) {
  projectDir = resolve(projectDir);
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);

  const pipelineCommit = gitOk(["rev-parse", "HEAD"], PIPELINE_ROOT) ? git(["rev-parse", "HEAD"], PIPELINE_ROOT) : config.pipeline.ref;
  const packs = resolvePacks(config.skills.packs, projectDir);
  const lock = { pipeline: { ...config.pipeline, commit: pipelineCommit }, packs, created: new Date().toISOString() };
  const lockPath = join(projectDir, ".sdlc", "lock.json");
  const prev = existsSync(lockPath) ? JSON.parse(readText(lockPath)) : null;
  if (!prev || JSON.stringify({ ...prev, created: 0 }) !== JSON.stringify({ ...lock, created: 0 })) writeText(lockPath, JSON.stringify(lock, null, 2) + "\n");

  const r = installPacks(projectDir, packs);

  const wf = readText(join(PIPELINE_ROOT, "templates", "workflows", "sdlc-checkpoint.yml"))
    .replaceAll("{{PIPELINE_REPO}}", config.pipeline.repo).replaceAll("{{PIPELINE_REF}}", config.pipeline.ref);
  const wfPath = join(projectDir, ".github", "workflows", "sdlc-checkpoint.yml");
  if (!existsSync(wfPath) || readText(wfPath) !== wf) writeText(wfPath, wf);

  if (!existsSync(DEFAULT_NAMES)) writeText(DEFAULT_NAMES,
    "# agentic-sdlc egress name list: one colleague name per line. Never commit this file.\n# The egress check fails any tracked file that contains a name listed here.\n");

  appendRun(projectDir, `init: pipeline ${pipelineCommit.slice(0, 7)}, packs ${packs.length}, skills installed ${r.installed.length}, skipped ${r.skipped.length}`);
  for (const s of r.skipped) console.warn(`warning: ${s}`);

  if (git(["status", "--porcelain"], projectDir)) {
    git(["add", "-A"], projectDir);
    git(["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost", "commit", "-q", "-m", "chore(sdlc): init"], projectDir);
  }
  return { lock, ...r };
}

COMMANDS.init = async ({ pos }) => { const r = await init(pos[0]); console.log(`init ok: ${r.installed.length} skills installed`); return 0; };
```

Register both by importing them in `src/cli.mjs` at the bottom (side-effect imports): `import "./commands/new.mjs"; import "./commands/init.mjs";` Because `new.mjs` imports `COMMANDS` from `cli.mjs`, the import must be after `COMMANDS` is exported; ESM hoisting handles this as long as `COMMANDS` is declared with `export const` before any use at module top level. Verify with the CLI test.

`skills/onboarding/SKILL.md`:
```markdown
---
name: sdlc-onboarding
description: Interview that produces a valid .sdlc/config.yaml for a new project.
---
You are producing `.sdlc/config.yaml` for a new project. Ask one question at a time. Do not guess a value: if the person (or the brief you were given) does not know, leave an optional field out, or write a schema-valid placeholder and list it under a top-of-file comment `# open:` so it becomes a proposal later.
Questions, in order: project name (lowercase, hyphens); the domains the system has; profile (greenfield, rebuild, remediation, feature); for rebuild or remediation, the source repository URL and commit; stack profile; who holds each gate, as roles (tech-lead, ux-reviewer) or agent:<persona>; the oracle: how the reference system runs (compose file, seed, base URL, identity mechanism); skill packs to enable beyond the defaults.
Then write the configuration file at the path you were given, validate it against schema/config.schema.json in the pipeline repository, and stop.
```

- [ ] **Step 4: Write the live onboarding test (runs only when `SDLC_LIVE=1`, because it spends tokens)**

```js
// test/onboarding.live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newProject } from "../src/commands/new.mjs";
import { loadConfig } from "../src/config/load.mjs";

const BRIEF = `# Stakeholder brief: permit intake
We are building a new service called permit-intake. It has two areas: applications and fees.
It is greenfield. Deploy on OpenShift with the openshift-ts stack. The tech lead holds ratify, plan, review and policy;
the UX reviewer holds design; intent may be held by a product-owner agent escalating to the tech lead.
No source repository. Tests sign in through a sandbox identity provider at http://localhost:8080.
No extra skill packs.`;

test("onboarding interview against a written brief produces a valid config", { skip: process.env.SDLC_LIVE !== "1" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-live-"));
  const brief = join(root, "brief.md"); writeFileSync(brief, BRIEF);
  const dir = join(root, "permit-intake");
  await newProject({ dir, answers: brief });
  assert.ok(existsSync(join(dir, ".sdlc", "config.yaml")));
  const { config, errors } = loadConfig(join(dir, ".sdlc", "config.yaml"));
  assert.deepEqual(errors, []);
  assert.equal(config.profile, "greenfield");
  assert.deepEqual(config.project.domains, ["applications", "fees"]);
  assert.equal(config.policy.gates["G-DESIGN"].holder, "ux-reviewer");
});
```

Run: `SDLC_LIVE=1 node --test test/onboarding.live.test.mjs`
Expected: PASS. If the produced config fails validation, the fix is in `skills/onboarding/SKILL.md` (the interview is the code here), not in the test. Record the token cost from the run in the run record note of the commit message.

- [ ] **Step 5: Run the full suite, expect passing. Commit**

```bash
git add src/commands/new.mjs src/commands/init.mjs src/cli.mjs skills/onboarding test/new-init.test.mjs test/onboarding.live.test.mjs
git commit -m "feat: sdlc new --from, --answers and --interactive; sdlc init"
```

---

### Task 9: `sdlc checks` and `sdlc doctor` commands

**Files:**
- Create: `src/commands/checks.mjs`, `src/commands/doctor.mjs`
- Modify: `src/cli.mjs` (imports)
- Test: `test/commands.test.mjs`

**Interfaces:**
- Produces: `checks` prints one line per check (`ok  config` / `FAIL constitution` followed by indented messages and warnings), returns 0 only when all pass, `--json` prints the results array. `doctor` reports node, git, gh, claude, docker, whether the project's `.claude/settings.json` carries the deny list, whether the egress name list exists and is non-empty, and config validity; returns 1 if node, git or the config fails, 0 otherwise (everything else is a warning).

- [ ] **Step 1: Write the failing test**

```js
// test/commands.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatChecks } from "../src/commands/checks.mjs";
import { toolReport } from "../src/commands/doctor.mjs";

test("formatChecks renders ok and failures", () => {
  const out = formatChecks([{ id: "config", ok: true, messages: [] }, { id: "egress", ok: false, messages: ["a.md:3: listed name"] }]);
  assert.match(out, /^ok\s+config$/m);
  assert.match(out, /^FAIL\s+egress$/m);
  assert.match(out, /^\s+a\.md:3: listed name$/m);
});

test("toolReport finds node and git and tolerates a missing tool", () => {
  const r = toolReport(["node", "git", "definitely-not-a-tool"]);
  assert.equal(r.find((t) => t.name === "node").found, true);
  assert.equal(r.find((t) => t.name === "definitely-not-a-tool").found, false);
});
```

- [ ] **Step 2: Run, expect failures. Step 3: Implement**

```js
// src/commands/checks.mjs
import { resolve } from "node:path";
import { runChecks } from "../checks/index.mjs";
import { COMMANDS } from "../cli.mjs";

export function formatChecks(results) {
  return results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.id}`
    + r.messages.map((m) => `\n    ${m}`).join("")
    + (r.warnings ?? []).map((m) => `\n    warning: ${m}`).join("")).join("\n");
}

COMMANDS.checks = async ({ pos, flags }) => {
  const dir = resolve(pos[0] ?? process.cwd());
  const results = await runChecks(dir, { self: !!flags.self });
  console.log(flags.json ? JSON.stringify(results, null, 2) : formatChecks(results));
  return results.every((r) => r.ok) ? 0 : 1;
};
```

```js
// src/commands/doctor.mjs
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { checkConfig } from "../checks/config.mjs";
import { COMMANDS } from "../cli.mjs";

const VERSION_ARGS = { node: ["--version"], git: ["--version"], gh: ["--version"], claude: ["--version"], docker: ["--version"] };

export function toolReport(names) {
  return names.map((name) => {
    try { const v = execFileSync(name, VERSION_ARGS[name] ?? ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0]; return { name, found: true, version: v.trim() }; }
    catch { return { name, found: false }; }
  });
}

function denyListPresent(dir) {
  const p = join(dir, ".claude", "settings.json");
  try { return JSON.parse(readFileSync(p, "utf8")).permissions?.deny?.some((d) => d.startsWith("Bash(git push")) ?? false; } catch { return false; }
}
function nameListState() {
  try { const n = readFileSync(DEFAULT_NAMES, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).length; return n ? `${n} names` : "empty"; }
  catch { return "missing"; }
}

COMMANDS.doctor = async ({ pos }) => {
  const dir = resolve(pos[0] ?? process.cwd());
  const tools = toolReport(["node", "git", "gh", "claude", "docker"]);
  for (const t of tools) console.log(`${t.found ? "ok  " : "warn"} ${t.name} ${t.version ?? "(not found)"}`);
  console.log(`${denyListPresent(dir) ? "ok  " : "warn"} agent deny list ${denyListPresent(dir) ? "present in .claude/settings.json" : "missing: re-run sdlc init"}`);
  const nl = nameListState();
  console.log(`${nl === "missing" || nl === "empty" ? "warn" : "ok  "} egress name list ${nl} (${DEFAULT_NAMES})`);
  const cfg = checkConfig(dir);
  console.log(`${cfg.ok ? "ok  " : "FAIL"} config ${cfg.messages.join("; ")}`);
  const required = tools.filter((t) => ["node", "git"].includes(t.name)).every((t) => t.found);
  return required && cfg.ok ? 0 : 1;
};
```

Add `import { readFileSync } from "node:fs";` and `import { DEFAULT_NAMES } from "../checks/egress.mjs";` at the top; remove the unused `homedir` import.

- [ ] **Step 4: Run tests, expect passing. Commit**

```bash
git add src/commands/checks.mjs src/commands/doctor.mjs src/cli.mjs test/commands.test.mjs
git commit -m "feat: sdlc checks and sdlc doctor"
```

---

### Task 10: Local proposals and rulings (`sdlc propose`, `sdlc rule`)

**Files:**
- Create: `src/commands/propose.mjs`, `src/commands/rule.mjs`
- Modify: `src/cli.mjs` (imports)
- Test: `test/gates.test.mjs`

**Interfaces:**
- Produces: `propose(projectDir, name, {gate, question, recommendation, page?}) -> {branch}`: creates branch `proposal/<name>` from `main`, writes `.sdlc/proposals/<name>.md` (front matter `gate`, `question`, `recommendation`, `opened`, then the page body), commits, stays on the branch. `rule(projectDir, name, verdict, {by, note, heldBy})` where `verdict` is `approve|return`: checks out the branch, writes `.sdlc/gates/<name>.yaml` `{gate, verdict, by, held_by, note, at}`, commits; on `approve` checks out `main` and merges `--no-ff`; on `return` stays on the branch. `by` must match the gate's holder role or its `escalate_to`, else the ruling is refused. Every ruling appends to the run record.

- [ ] **Step 1: Write the failing test**

```js
// test/gates.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { propose } from "../src/commands/propose.mjs";
import { rule } from "../src/commands/rule.mjs";

const CONFIG = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: tech-lead }
    G3: { holder: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;

function project() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-gate-"));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc"), { recursive: true }); writeFileSync(join(d, ".sdlc/config.yaml"), CONFIG);
  writeFileSync(join(d, "README.md"), "x"); git(["add", "-A"], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

test("propose then approve merges into main with a gate record", () => {
  const d = project();
  const { branch } = propose(d, "harness-ready", { gate: "G1", question: "Is the harness ready?", recommendation: "Yes." });
  assert.equal(branch, "proposal/harness-ready");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), branch);
  assert.throws(() => rule(d, "harness-ready", "approve", { by: "ux-reviewer" }), /not a holder/);
  rule(d, "harness-ready", "approve", { by: "tech-lead", note: "checks green" });
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.ok(existsSync(join(d, ".sdlc/gates/harness-ready.yaml")));
  assert.match(readFileSync(join(d, ".sdlc/gates/harness-ready.yaml"), "utf8"), /verdict: approve/);
  assert.match(git(["log", "--oneline", "-3"], d), /harness-ready/);
});

test("return keeps the branch open and records the verdict", () => {
  const d = project();
  propose(d, "plan-v1", { gate: "G2", question: "Sound?", recommendation: "No." });
  rule(d, "plan-v1", "return", { by: "tech-lead", note: "criterion R-1.2 unassigned" });
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "proposal/plan-v1");
  assert.match(readFileSync(join(d, ".sdlc/gates/plan-v1.yaml"), "utf8"), /verdict: return/);
});

test("an agent-held gate records held_by agent and can escalate to the human", () => {
  const d = project();
  propose(d, "intent-1", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  rule(d, "intent-1", "approve", { by: "agent:product-owner", note: "rationale…" });
  assert.match(readFileSync(join(d, ".sdlc/gates/intent-1.yaml"), "utf8"), /held_by: agent/);
  const d2 = project();
  propose(d2, "intent-2", { gate: "G0", question: "?", recommendation: "?" });
  rule(d2, "intent-2", "approve", { by: "tech-lead" });
  assert.match(readFileSync(join(d2, ".sdlc/gates/intent-2.yaml"), "utf8"), /held_by: human/);
});
```

- [ ] **Step 2: Run, expect failures. Step 3: Implement**

```js
// src/commands/propose.mjs
import { join, resolve } from "node:path";
import { git } from "../lib/git.mjs";
import { writeText } from "../lib/fsx.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { COMMANDS } from "../cli.mjs";

const SDLC_AUTHOR = ["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost"];

export function propose(projectDir, name, { gate, question, recommendation, page = "" }) {
  projectDir = resolve(projectDir);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("proposal name: lowercase letters, digits, hyphens");
  if (!gate || !question || !recommendation) throw new Error("propose needs --gate, --question and --recommendation");
  const branch = `proposal/${name}`;
  git(["checkout", "-q", "main"], projectDir);
  git(["checkout", "-q", "-b", branch], projectDir);
  const opened = new Date().toISOString();
  writeText(join(projectDir, ".sdlc", "proposals", `${name}.md`),
    `---\ngate: ${gate}\nquestion: ${JSON.stringify(question)}\nrecommendation: ${JSON.stringify(recommendation)}\nopened: ${opened}\n---\n\n# ${question}\n\n**Recommendation.** ${recommendation}\n\n${page}\n`);
  git(["add", "-A"], projectDir);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `propose(${gate}): ${name}`], projectDir);
  appendRun(projectDir, `propose ${name} at ${gate}`);
  return { branch };
}

COMMANDS.propose = async ({ pos, flags }) => {
  const r = propose(process.cwd(), pos[0], { gate: flags.gate, question: flags.question, recommendation: flags.recommendation });
  console.log(`opened ${r.branch}`); return 0;
};
```

```js
// src/commands/rule.mjs
import { join, resolve } from "node:path";
import { git, gitOk } from "../lib/git.mjs";
import { readText, writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { COMMANDS } from "../cli.mjs";

const SDLC_AUTHOR = ["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost"];

export function rule(projectDir, name, verdict, { by, note = "" }) {
  projectDir = resolve(projectDir);
  if (!["approve", "return"].includes(verdict)) throw new Error("verdict must be approve or return");
  if (!by) throw new Error("rule needs --by <role or agent:persona>");
  const branch = `proposal/${name}`;
  if (!gitOk(["rev-parse", "--verify", branch], projectDir)) throw new Error(`no proposal branch ${branch}`);
  git(["checkout", "-q", branch], projectDir);
  const gate = readText(join(projectDir, ".sdlc", "proposals", `${name}.md`)).match(/^gate:\s*(\S+)/m)[1];
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
  const g = config.policy.gates[gate];
  if (!g) throw new Error(`gate ${gate} is not in policy`);
  const allowed = [g.holder, g.escalate_to].filter(Boolean);
  if (!allowed.includes(by)) throw new Error(`${by} is not a holder of ${gate} (allowed: ${allowed.join(", ")})`);
  const heldBy = by.startsWith("agent:") ? "agent" : "human";
  writeText(join(projectDir, ".sdlc", "gates", `${name}.yaml`),
    `gate: ${gate}\nverdict: ${verdict}\nby: ${by}\nheld_by: ${heldBy}\nnote: ${JSON.stringify(note)}\nat: ${new Date().toISOString()}\n`);
  git(["add", "-A"], projectDir);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} ${verdict} by ${by}`], projectDir);
  if (verdict === "approve") {
    git(["checkout", "-q", "main"], projectDir);
    git([...SDLC_AUTHOR, "merge", "-q", "--no-ff", "-m", `merge: ${name} approved at ${gate} by ${by}`, branch], projectDir);
  }
  appendRun(projectDir, `rule ${name} ${verdict} at ${gate} by ${by} (${heldBy})`);
  return { gate, verdict, heldBy };
}

COMMANDS.rule = async ({ pos, flags }) => {
  const r = rule(process.cwd(), pos[0], pos[1], { by: flags.by, note: flags.note ?? "" });
  console.log(`${pos[0]}: ${r.verdict} at ${r.gate}`); return 0;
};
```

- [ ] **Step 4: Run tests, expect 3 passing. Commit**

```bash
git add src/commands/propose.mjs src/commands/rule.mjs src/cli.mjs test/gates.test.mjs
git commit -m "feat: local proposals and rulings as branches and gate records"
```

---

### Task 11: `sdlc status`: the first state site

**Files:**
- Create: `src/commands/status.mjs`
- Modify: `src/cli.mjs`
- Test: `test/status.test.mjs`

**Interfaces:**
- Produces: `buildSite(projectDir) -> {pages: string[]}` writing `site/index.md` (project, profile, criteria counts by state read from `spec/criteria-index.json` if present, else zeros), `site/gates.md` (table from `.sdlc/gates/*.yaml`, newest first, with an "agent-held, unsampled" marker for `held_by: agent`), `site/runs.md` (concatenation of `.sdlc/runs/*.md`, newest first). Markdown only in phase 0; HTML rendering is a later task.

- [ ] **Step 1: Write the failing test**

```js
// test/status.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/commands/status.mjs";

test("site pages summarise criteria, gates and runs", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-site-"));
  mkdirSync(join(d, ".sdlc/gates"), { recursive: true }); mkdirSync(join(d, ".sdlc/runs"), { recursive: true }); mkdirSync(join(d, "spec"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), "profile: rebuild\nproject: { name: p, domains: [a] }\n");
  writeFileSync(join(d, "spec/criteria-index.json"), JSON.stringify({ criteria: [{ id: "R-1.1", state: "accepted" }, { id: "R-1.2", state: "proposed" }] }));
  writeFileSync(join(d, ".sdlc/gates/x.yaml"), "gate: G1\nverdict: approve\nby: agent:product-owner\nheld_by: agent\nnote: \"\"\nat: 2026-01-01T00:00:00Z\n");
  writeFileSync(join(d, ".sdlc/runs/2026-01-01.md"), "# Run record 2026-01-01\n\n- 10:00:00 init\n");
  const { pages } = buildSite(d);
  assert.equal(pages.length, 3);
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  assert.match(index, /accepted\s*\|\s*1/); assert.match(index, /proposed\s*\|\s*1/);
  assert.match(readFileSync(join(d, "site/gates.md"), "utf8"), /agent-held/);
  assert.match(readFileSync(join(d, "site/runs.md"), "utf8"), /10:00:00 init/);
});
```

- [ ] **Step 2: Run, expect failure. Step 3: Implement**

```js
// src/commands/status.mjs
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { COMMANDS } from "../cli.mjs";

const STATES = ["proposed", "accepted", "implemented", "verified", "monitored"];

export function buildSite(projectDir) {
  projectDir = resolve(projectDir);
  const cfg = parse(readText(join(projectDir, ".sdlc", "config.yaml")));
  const idxPath = join(projectDir, "spec", "criteria-index.json");
  const criteria = existsSync(idxPath) ? JSON.parse(readText(idxPath)).criteria : [];
  const counts = Object.fromEntries(STATES.map((s) => [s, criteria.filter((c) => c.state === s).length]));
  const index = [`# ${cfg.project.name} — state`, "", `Profile: ${cfg.profile} · generated ${new Date().toISOString()}`, "",
    "## Coverage", "", "| State | Criteria |", "| --- | --- |", ...STATES.map((s) => `| ${s} | ${counts[s]} |`), "",
    `Total criteria: ${criteria.length}`, "", "See [gates](gates.md) · [runs](runs.md)", ""].join("\n");

  const gatesDir = join(projectDir, ".sdlc", "gates");
  const gates = existsSync(gatesDir) ? readdirSync(gatesDir).filter((f) => f.endsWith(".yaml")).map((f) => ({ name: f.replace(/\.yaml$/, ""), ...parse(readText(join(gatesDir, f))) })) : [];
  gates.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const gatesMd = ["# Gate log", "", "| When | Proposal | Gate | Verdict | By | Held |", "| --- | --- | --- | --- | --- | --- |",
    ...gates.map((g) => `| ${g.at} | ${g.name} | ${g.gate} | ${g.verdict} | ${g.by} | ${g.held_by === "agent" ? "agent-held, unsampled" : "human"} |`), ""].join("\n");

  const runsDir = join(projectDir, ".sdlc", "runs");
  const runs = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".md")).sort().reverse().map((f) => readText(join(runsDir, f))) : [];
  const runsMd = ["# Run log", "", ...runs].join("\n");

  const pages = [["site/index.md", index], ["site/gates.md", gatesMd], ["site/runs.md", runsMd]];
  for (const [p, t] of pages) writeText(join(projectDir, p), t);
  return { pages: pages.map(([p]) => p) };
}

COMMANDS.status = async ({ pos }) => { const r = buildSite(pos[0] ?? process.cwd()); console.log(r.pages.join("\n")); return 0; };
```

- [ ] **Step 4: Run tests, expect passing. Commit**

```bash
git add src/commands/status.mjs src/cli.mjs test/status.test.mjs
git commit -m "feat: sdlc status writes the first state site as Markdown"
```

---

### Task 12: Fixture project and the pipeline's own CI

**Files:**
- Create: `fixture-project/fixture.config.yaml`, `fixture-project/README.md`, `.github/workflows/ci.yml`, `test/fixture.test.mjs`

**Interfaces:**
- Consumes: `newProject`, `runChecks`, `propose`, `rule`, `buildSite`.
- Produces: an end-to-end test that creates the fixture project from its saved config in a temp dir, fills the constitution placeholders programmatically, runs the checks (all must pass), opens a proposal, approves it as `tech-lead`, and builds the site. This is the guard against a marketplace-specific pipeline: the fixture is an unrelated two-domain application.

- [ ] **Step 1: Write the fixture config**

```yaml
# fixture-project/fixture.config.yaml — a deliberately unrelated application used to test the pipeline.
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project:
  name: permit-intake
  domains: [applications, fees]
targets:
  new: { base_url: http://localhost:8080, identity: sandbox-idp }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead, human_sample_per_week: 5 }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
  triage: { direct_max_files: 3, direct_allowed_paths: [app/] }
skills: { packs: [] }
egress: { rules: [E-1, E-2, E-3, E-4] }
```

- [ ] **Step 2: Write the failing end-to-end test**

```js
// test/fixture.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runChecks } from "../src/checks/index.mjs";
import { propose } from "../src/commands/propose.mjs";
import { rule } from "../src/commands/rule.mjs";
import { buildSite } from "../src/commands/status.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;

test("fixture project: create, fill constitution, checks green, propose, approve, site", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "sdlc-fixture-")), "permit-intake");
  await newProject({ dir, from: FROM });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  git(["add", "-A"], dir); git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "fill constitution"], dir);
  const results = await runChecks(dir);
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => [r.id, r.messages]), []);
  propose(dir, "harness-ready", { gate: "G1", question: "Is the harness ready?", recommendation: "Yes: all structural checks pass on an empty proposal." });
  rule(dir, "harness-ready", "approve", { by: "tech-lead", note: "phase 0 exit" });
  const { pages } = buildSite(dir);
  assert.equal(pages.length, 3);
  assert.ok(existsSync(join(dir, "site/gates.md")));
});
```

- [ ] **Step 3: Run, expect a failure that names the first real defect (most likely the constitution check or a missing template path). Fix in the module that owns it, not in the test. Re-run until green.**

- [ ] **Step 4: Write the CI workflow (inert until the repo has a remote)**

```yaml
# .github/workflows/ci.yml
name: ci
on: { push: { branches: [main] }, pull_request: {} }
permissions: { contents: read }
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "24", cache: npm }
      - run: npm ci
      - run: npm test
      - run: npm run check
```

- [ ] **Step 5: Run `npm test` and `npm run check` locally, expect both green. Commit**

```bash
git add fixture-project test/fixture.test.mjs .github/workflows/ci.yml
git commit -m "test: fixture project end to end, and the pipeline's own CI"
```

---

### Task 13: Documentation: architecture, stage contracts, dependency register

**Files:**
- Create: `docs/architecture.md`, `docs/dependencies.md`, `docs/stages/new.md`, `docs/stages/init.md`, `docs/stages/checks.md`, `docs/stages/propose.md`, `docs/stages/rule.md`, `docs/stages/status.md`, `docs/stages/doctor.md`
- Modify: `README.md` (create; the repo has none yet)

- [ ] **Step 1: Write the stage contracts.** Each `docs/stages/<name>.md` has exactly these headings, filled from the code in Tasks 8 to 11: Purpose; Inputs; Outputs; Workspace the agent sees (or "no agent"); Checks that block; Exit criterion; Re-run behaviour; Failure modes. For `init` include the implement-guard table (stage to blocked paths) copied from the hook script, the deny list and what each entry prevents, and the egress name list:

```markdown
## Egress name list
`sdlc init` creates `~/.config/agentic-sdlc/egress-names.txt` once per machine. Add colleagues'
names, one per line. The file is never committed; the egress check fails any tracked file that
contains one of them. `sdlc doctor` warns while the list is missing or empty.
```

- [ ] **Step 2: Write `docs/dependencies.md`** as the register from spec section 11, one row per dependency with: name, used for, taken as, pinned version or commit (fill `ajv` and `yaml` from `package.json`; skill packs get their commits when Task 15 pins them), and why. Include the "not adopted" list with reasons. Add a final section "Keeping in sync": the weekly drift workflow is a later task; until then `git ls-remote` each pack and compare to the lockfile.

- [ ] **Step 3: Write `docs/architecture.md`**: the runner loop (materialise workspace, pre-checks, agent, post-checks, proposal, run record), the two repositories, where state lives (git branches, `.sdlc/gates`, `.sdlc/runs`, `site/`), and the rule that the project repo is only ever produced by the pipeline. Link the spec and the poster.

- [ ] **Step 4: Write `README.md`**: what this is in three sentences, install (`npm ci`), the seven commands with one line each, how to run tests, links to docs. No names, no ticket numbers.

- [ ] **Step 5: Run `npm run check` (egress self-check over docs), expect ok. Commit**

```bash
git add README.md docs
git commit -m "docs: architecture, stage contracts, dependency register"
```

---

### Task 14: Stack profile `openshift-ts`, first version

**Files:**
- Create: `stacks/openshift-ts/README.md`, `stacks/openshift-ts/SKILL.md`

- [ ] **Step 1: Write `README.md`**: scaffold source (`bcgov/quickstart-openshift`, record the commit you read it at with `git ls-remote https://github.com/bcgov/quickstart-openshift HEAD`), what it provides (front end, back end, migrations, tests, lint, per-PR sandbox deploy, central helper workflows), what this profile adds (the standards skill, the sandbox identity provider, the mail catcher), and what the plan stage must decide (NestJS confirmed or replaced; Prisma over the existing schema; migration tool).

- [ ] **Step 2: Write `SKILL.md`** with front matter `name: stack-openshift-ts` and sections: Use when; Don't use when; Layout (`app/frontend`, `app/backend`, `app/migrations`, `app/compose/` for local services including Keycloak and Mailpit); Naming; Errors and logging (structured, no personal data in logs, per constitution P3); API (OpenAPI first: the contract's `openapi.yaml` is the source, generated clients, validation at the boundary); Auth (Keycloak OIDC, PKCE for the SPA, roles from token claims, the sandbox realm for tests); Testing (unit at seams with Vitest, acceptance only from spec, Playwright locators by role and label, test IDs from `surface.yaml`); Accessibility and plain language (WCAG 2.1 AA, Grade 8); Deploy (quickstart helpers, no production route). Each rule one line, with a `Source:` line naming `bcgov/agent-instructions`, the design system's agent instructions, `rloisell/rl-project-template` coding standards, or `convention`.

- [ ] **Step 3: Run `npm run check`, expect ok. Commit**

```bash
git add stacks
git commit -m "feat: openshift-ts stack profile and standards skill, first version"
```

---

### Task 15: Verify constitution sources and pin the real skill packs

**Files:**
- Modify: `templates/project/constitution.md` (Source lines), `docs/dependencies.md` (commits)

- [ ] **Step 1: Verify each `Source: https://…` in the constitution template.** For each of P1, P2, P3: fetch the page and confirm it states the rule (WCAG 2.1 AA for BC Gov web content; the design system as the provincial standard; the PIA requirement before collecting personal information). If a page does not state the rule, change that article's line to `Source: convention` and add a one-line note under the article saying the policy citation is still to be found. Record what was checked and the outcome in `docs/decisions/0002-constitution-sources.md`.

- [ ] **Step 2: Pin the skill packs.** Run and record:

```bash
for r in mattpocock/skills bcgov/crow bcgov/agent-skills DietrichGebert/ponytail; do
  echo "$r $(git ls-remote https://github.com/$r.git HEAD | cut -f1)"; done
```

Put the four commits in `docs/dependencies.md`. Confirm each pack's skill folder names with a shallow clone and `find . -name SKILL.md`: `grilling` and `domain-modeling` and `prototype` and `tdd` and `code-review` in mattpocock/skills; `crow-bcgov-ux` in bcgov/crow; `github-actions` and `openshift-deployment` in bcgov/agent-skills. If a name differs, use the real one.

- [ ] **Step 3: Run the full suite, expect green. Commit**

```bash
git add templates/project/constitution.md docs/dependencies.md docs/decisions/0002-constitution-sources.md
git commit -m "docs: verified constitution sources; pinned skill pack commits"
```

---

### Task 16: Create the marketplace project with the pipeline, and pass the phase 0 exit

**Files:**
- Create (outside both repos): `/home/alstruk/GitHub/configs/digital-marketplace-next.yaml`
- Produced by the pipeline: `/home/alstruk/GitHub/digital-marketplace-next/` (new repo)

The marketplace is named only in this config file and in the project it creates, never in the pipeline repo.

- [ ] **Step 1: Write the config**

```yaml
pipeline: { repo: bcgov/agentic-sdlc, ref: main }
profile: rebuild
stack: openshift-ts
project:
  name: digital-marketplace-next
  domains: [opportunities, proposals, organizations, users, evaluation, notifications, content, files]
sources:
  old:
    repo: https://github.com/bcgov/digital_marketplace
    commit: b0f0c99c768b528b9397925478d8185e2cd0b179
    docs: [README.md, docs/]
    exclude: [cypress/, tests/]
oracle:
  target: old
  compose: sources/old/docker-compose.yml
  seed: tests/seed/
  base_url: http://localhost:3000
  identity: session-route
targets:
  new: { base_url: http://localhost:8080, identity: sandbox-idp }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead, human_sample_per_week: 5 }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
  rungs: {}
  triage: { direct_max_files: 3, direct_allowed_paths: [app/] }
  budgets: { archaeology: 4000000, derive-tests: 2000000, build: 3000000, review: 1000000 }
skills:
  packs:
    - { repo: mattpocock/skills, ref: <commit from Task 15>, skills: [grilling, domain-modeling, prototype, tdd, code-review] }
    - { repo: bcgov/crow, ref: <commit from Task 15>, skills: [crow-bcgov-ux] }
    - { repo: bcgov/agent-skills, ref: <commit from Task 15>, skills: [github-actions, openshift-deployment] }
    - { repo: DietrichGebert/ponytail, ref: <commit from Task 15>, skills: [ponytail], enabled: false }
  extra: []
egress:
  rules: [E-1, E-2, E-3, E-4]
```

Replace each `<commit from Task 15>` with the recorded commit before running.

- [ ] **Step 2: Create the project through the pipeline**

```bash
cd /home/alstruk/GitHub/agentic-sdlc && node bin/sdlc.mjs new /home/alstruk/GitHub/digital-marketplace-next --from /home/alstruk/GitHub/configs/digital-marketplace-next.yaml
```

Expected: `created /home/alstruk/GitHub/digital-marketplace-next`, two commits on `main`, four packs cloned under `.sdlc/packs/`, the listed skills under `.claude/skills/`.

- [ ] **Step 3: Fill the project articles of the constitution through a proposal, not by hand on main**

```bash
cd /home/alstruk/GitHub/digital-marketplace-next
node /home/alstruk/GitHub/agentic-sdlc/bin/sdlc.mjs propose constitution-v1 --gate G-POL --question "Are the project articles of the constitution correct for the rebuild?" --recommendation "Adopt as drafted; exceptions table empty; existing Postgres schema recorded under J5."
```

Then, on that branch with `SDLC_STAGE=archaeology`, fill J1 to J7 from the old repository's README and the design spec: J1 the marketplace's purpose (administers Code With Us, Sprint With Us and Team With Us procurement); J2 in scope (the rebuild, sandbox environments) and out (production, operations, the old repository); J3 forbidden patterns (no test-only entrances in application code, no production namespace in any workflow, no personal data in fixtures, no selectors in acceptance tests); J4 the domain terms (opportunity, proposal, proponent, organisation, affiliation, evaluation stage, award, the three programs); J5 baselines (Keycloak OIDC as today; existing Postgres schema kept; WCAG 2.1 AA); J6 empty; J7 how to run the old application from its compose file. Commit on the branch.

- [ ] **Step 4: Fill the egress name list once for this machine**

Open `~/.config/agentic-sdlc/egress-names.txt` (created by `sdlc init`) and add colleagues' names, one per line. It is outside every repository and applies to every project on the machine. No role-to-person binding is needed in phase 0: rulings are made as roles, and usernames matter only once a remote exists.

- [ ] **Step 5: Run the checks and doctor on the proposal branch**

```bash
node /home/alstruk/GitHub/agentic-sdlc/bin/sdlc.mjs checks && node /home/alstruk/GitHub/agentic-sdlc/bin/sdlc.mjs doctor
```

Expected: all four checks `ok` with no egress warning; doctor reports node, git, gh, claude, docker found, the deny list present, and the name list non-empty.

- [ ] **Step 6: Read the proposal back to the tech lead and record the ruling**

Show the constitution diff and the checks output. If approved:

```bash
node /home/alstruk/GitHub/agentic-sdlc/bin/sdlc.mjs rule constitution-v1 approve --by tech-lead --note "phase 0 harness ready; checks green"
node /home/alstruk/GitHub/agentic-sdlc/bin/sdlc.mjs status
```

Expected: merged into `main`, `.sdlc/gates/constitution-v1.yaml` present, `site/gates.md` lists it as human-held. This is the phase 0 exit criterion. Nothing is pushed.

---

## Self-review against the spec

**Coverage.** Section 3.2 layout: Tasks 1, 6, 8, 12, 13, 14 (workflows/ holds one caller template; more arrive with later stages; `evals/` is deferred to the harness-evals task in phase 1 because there is no skill to test yet). Section 3.3 project layout: Task 6 templates plus Task 5 layout check. Section 3.4 install and upgrade: Task 8 covers `new` and `init`; `upgrade` is deferred to the first pipeline version bump, since there is nothing to upgrade from yet. Section 4 artifacts: templates in Task 6. Section 5.1 `init` and 5.15 `status`: Tasks 8 and 11. Section 6.1 gates as proposals without a remote, 6.2 persona agents and holder roles: Tasks 2, 6, 10. Section 9 config: Task 2. Section 10 egress including "the pipeline's own documents": Task 5 and the `check --self` script. Section 11 dependency register: Task 13 and 15. Section 12 stack profile: Task 14. Section 14 fixture project: Task 12. Section 15 phase 0 row: Task 16.

**Deferred, named so nobody looks for them here:** `sdlc run <stage>` and `resume` (phase 1, with the first agent stage), harness evals (phase 1), the HTML state site (later), the weekly drift workflow (later), the separation lint for tests and adapters (phase 2), the interactive onboarding interview is tested against a written stakeholder brief with a live Claude session when `SDLC_LIVE=1` (Task 8), and against a person only when someone runs `--interactive`.

**Placeholders.** The `{{…}}` tokens in templates are data the pipeline fills, not plan placeholders. `<commit from Task 15>` in Task 16 is filled by a named earlier step.

**Type consistency.** `runChecks(dir, {self})` returns `{id, ok, messages}[]` everywhere; `propose`/`rule` share the branch name `proposal/<name>` and the gate file path; `COMMANDS` is the single registry; `PIPELINE_ROOT` is exported once from `new.mjs` and imported by `init.mjs`.
