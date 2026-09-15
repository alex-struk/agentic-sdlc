// The checks behind gate G-DESIGN. A design catalogue is worth a reviewer's time only if
// it covers the screens the contract actually names, so these are about coverage and
// about the two ways a catalogue stops being a design system: a screen nobody drew, and a
// colour somebody typed in by hand.
//
// Two of them read `design/report.json`, which `design/scan.mjs` writes after it compiles
// the catalogue and scans every story. Nothing here runs a browser: the report is produced
// outside the gate and the gate reads it, which is what lets a ruling cite a number rather
// than a claim.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readText } from "../lib/fsx.mjs";
import { git, gitOk } from "../lib/git.mjs";

export const CATALOGUE_SUFFIX = ".stories.tsx";
const SCREENS_PATH = join("design", "screens.yaml");
const SURFACE_PATH = join("spec", "contract", "surface.yaml");

function readYaml(path) {
  if (!existsSync(path)) return null;
  try { return parseYaml(readText(path)); } catch { return null; }
}

// Page ids as the contract spells them, optionally narrowed to one domain. A surface that
// will not parse is not this check's failure to report — `checkContract` owns that — so it
// reads as no pages rather than as an error here, and the catalogue check says only that it
// found nothing to cover.
export function surfacePageIds(projectDir, domain) {
  const doc = readYaml(join(projectDir, SURFACE_PATH));
  const pages = doc?.pages;
  const entries = Array.isArray(pages)
    ? pages.map((p) => [p?.id, p])
    : pages && typeof pages === "object" ? Object.entries(pages) : [];
  return entries
    .filter(([id, page]) => id && (domain === undefined || page?.domain === domain))
    .map(([id]) => id);
}

export function catalogueFiles(projectDir) {
  const dir = join(projectDir, "design", "catalogue");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(CATALOGUE_SUFFIX)).sort();
}

// `design/screens.yaml` is the one place a screen's states are written down. The catalogue
// is named from it (`<page>.<state>.stories.tsx`) rather than the other way round, so a
// state that exists only as a file nobody declared is as much a defect as a declared state
// with no file: a reviewer reads the declaration and expects the catalogue to match it.
// `domain` narrows only one half of this. Which pages must have a screen is this run's
// business — a design run covers the domain it was given, and the seven it was not are not
// its omission. Everything else stays project-wide: a story nobody declared, a screen
// declared twice, a screen naming a page the surface does not have, are all wrong however
// this run was scoped, and a check that only looked at one domain would let them survive
// every run that did not happen to touch them.
export function checkDesignCatalogue(projectDir, domain) {
  const id = "design-catalogue";
  const messages = [];
  const screensPath = join(projectDir, SCREENS_PATH);
  if (!existsSync(screensPath)) return { id, ok: false, messages: [`${SCREENS_PATH} is missing`] };
  const doc = readYaml(screensPath);
  const screens = Array.isArray(doc?.screens) ? doc.screens : null;
  if (!screens) return { id, ok: false, messages: [`${SCREENS_PATH}: no "screens" list`] };

  const mustCover = surfacePageIds(projectDir, domain);
  const allPageIds = surfacePageIds(projectDir);
  const declared = new Map();
  for (const s of screens) {
    const page = s?.page;
    if (!page) { messages.push(`${SCREENS_PATH}: a screen entry has no "page"`); continue; }
    if (declared.has(page)) { messages.push(`${SCREENS_PATH}: ${page} is declared twice`); continue; }
    const states = Array.isArray(s?.states) ? s.states.filter(Boolean) : [];
    if (!states.length) { messages.push(`${SCREENS_PATH}: ${page} declares no states`); continue; }
    // Every screen has a resting state, and naming it the same thing everywhere is what
    // lets a reviewer compare two screens at all.
    if (!states.includes("default")) messages.push(`${SCREENS_PATH}: ${page} has no "default" state`);
    declared.set(page, states);
  }

  for (const page of mustCover) {
    if (!declared.has(page)) messages.push(`${SCREENS_PATH}: ${page} is in the contract's surface but has no screen`);
  }
  for (const page of declared.keys()) {
    if (allPageIds.length && !allPageIds.includes(page)) messages.push(`${SCREENS_PATH}: ${page} is not a page the contract's surface names`);
  }

  const files = new Set(catalogueFiles(projectDir));
  const wanted = new Set();
  for (const [page, states] of declared) {
    for (const state of states) {
      const name = `${page}.${state}${CATALOGUE_SUFFIX}`;
      wanted.add(name);
      if (!files.has(name)) messages.push(`design/catalogue/${name} is missing; ${page} declares the state "${state}"`);
    }
  }
  for (const f of files) {
    if (!wanted.has(f)) messages.push(`design/catalogue/${f}: no screen declares this page and state`);
  }

  return { id, ok: messages.length === 0, messages };
}

// A literal colour in a catalogue is the design system being bypassed. Caught by shape
// rather than by a list of forbidden values, since the point is that the value was typed
// at all — a token reads as `var(--surface-color-primary-button-default)` or as an import,
// never as `#036`.
const SKIP = new Set(["node_modules", "storybook-static", "report.json"]);

const COLOUR = /(#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\()/;

export function checkDesignNoLiteralColours(projectDir) {
  const id = "design-no-literal-colours";
  const messages = [];
  const dir = join(projectDir, "design");
  if (!existsSync(dir)) return { id, ok: true, messages };
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const next = rel ? join(rel, entry.name) : entry.name;
      // The harness's installed dependencies and its build output are machinery, not
      // design: both are full of written-out colours, neither was authored here, and
      // walking `node_modules` would read tens of thousands of files to say so.
      if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) { walk(next); continue; }
      if (!/\.(tsx?|jsx?|css|scss|md|ya?ml)$/.test(entry.name)) continue;
      const lines = readText(join(dir, next)).split("\n");
      lines.forEach((line, i) => {
        const m = COLOUR.exec(line);
        if (m) messages.push(`design/${next}:${i + 1}: colour written out as ${m[0].trim()}; use a design-system token`);
      });
    }
  };
  walk("");
  return { id, ok: messages.length === 0, messages };
}

// The design gate fills in test IDs, and that is the only thing it may do to the contract.
// A route, an action or an observation changed here would change what the acceptance suite
// is allowed to reach, silently and behind the gate that ruled on it — a spec change
// wearing a design stage's clothes.
export function checkDesignSurfaceScope(projectDir) {
  const id = "design-surface-scope";
  if (!gitOk(["cat-file", "-e", `HEAD:${SURFACE_PATH}`], projectDir)) return { id, ok: true, messages: [] };
  const before = parseSurfaceForComparison(git(["show", `HEAD:${SURFACE_PATH}`], projectDir));
  const after = parseSurfaceForComparison(readText(join(projectDir, SURFACE_PATH)));
  if (!before || !after) return { id, ok: true, messages: [] };
  const messages = [];
  for (const [pageId, page] of before) {
    const now = after.get(pageId);
    if (!now) { messages.push(`${SURFACE_PATH}: page ${pageId} was removed; the design gate may only add test IDs`); continue; }
    if (page.shape !== now.shape) messages.push(`${SURFACE_PATH}: page ${pageId} changed its route, actions or observations; the design gate may only add test IDs`);
  }
  for (const pageId of after.keys()) {
    if (!before.has(pageId)) messages.push(`${SURFACE_PATH}: page ${pageId} was added; the design gate may only add test IDs`);
  }
  return { id, ok: messages.length === 0, messages };
}

// Everything about a page except the test IDs, as one comparable string. A page's actions
// and observations each carry a `test_id`, written as `null` by the contract stage and
// filled in here, so the comparison keeps the action's name and drops only that one value.
// Comments and key order are not part of it: a stage that rewrites the file to fill a key
// should not be failed for having reordered it on the way.
function parseSurfaceForComparison(text) {
  let doc;
  try { doc = parseYaml(text); } catch { return null; }
  const pages = doc?.pages;
  const entries = Array.isArray(pages)
    ? pages.map((p) => [p?.id, p])
    : pages && typeof pages === "object" ? Object.entries(pages) : null;
  if (!entries) return null;
  const out = new Map();
  for (const [id, page] of entries) {
    if (!id || !page || typeof page !== "object") continue;
    out.set(id, { shape: stableJson(withoutTestIds(page)) });
  }
  return out;
}

// `test_id` is dropped wherever it appears, at any depth, because it is the one key this
// gate owns. Everything else — the route, the title, the domain, which actions and
// observations exist and what else each says about itself — has to come out unchanged.
function withoutTestIds(value) {
  if (Array.isArray(value)) return value.map(withoutTestIds);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "test_id") continue;
      out[k] = withoutTestIds(v);
    }
    return out;
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// ---- the compiled catalogue, and what the scan found in it ----

export const REPORT_PATH = join("design", "report.json");
const SCAN_COMMAND = "npm --prefix design install && npm --prefix design run scan";

// The digest `scan.mjs` records, recomputed from the catalogue as it stands now. A report
// is evidence about the stories it read, and a story edited afterwards is not covered by
// it — which is the ordinary case, since a revision fixes a story and the old report still
// says zero.
function catalogueDigest(projectDir) {
  const dir = join(projectDir, "design", "catalogue");
  if (!existsSync(dir)) return null;
  const hash = createHash("sha256");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(CATALOGUE_SUFFIX)).sort()) {
    hash.update(f).update("\0").update(readFileSync(join(dir, f))).update("\0");
  }
  return hash.digest("hex");
}

function readReport(projectDir) {
  const p = join(projectDir, REPORT_PATH);
  if (!existsSync(p)) return { missing: true };
  try { return { report: JSON.parse(readText(p)) }; } catch (e) { return { unreadable: e.message }; }
}

// Whether the catalogue is real code. A story naming a component the design system does
// not export, or passing a prop it does not take, reads exactly like a correct one until
// something compiles it — so until this passes, every component and token name in the
// catalogue is a guess that happens to look right.
export function checkDesignCompiles(projectDir) {
  const id = "design-compiles";
  const { missing, unreadable, report } = readReport(projectDir);
  if (missing) return { id, ok: false, messages: [`${REPORT_PATH} is missing; the catalogue has not been compiled. Run: ${SCAN_COMMAND}`] };
  if (unreadable) return { id, ok: false, messages: [`${REPORT_PATH} does not parse: ${unreadable}`] };
  const messages = [];
  const steps = Array.isArray(report?.compile) ? report.compile : [];
  if (!steps.length) messages.push(`${REPORT_PATH} records no compile step`);
  for (const step of steps) {
    if (!step?.ok) messages.push(`the catalogue does not ${step?.step ?? "compile"}:\n${step?.output ?? "(no output recorded)"}`);
  }
  const now = catalogueDigest(projectDir);
  if (now && report?.catalogue && report.catalogue !== now)
    messages.push(`${REPORT_PATH} was written for a different catalogue; the stories have changed since. Run: ${SCAN_COMMAND}`);
  else if (now && !report?.catalogue)
    messages.push(`${REPORT_PATH} does not say which catalogue it read; it cannot be held against this one. Run: ${SCAN_COMMAND}`);
  return { id, ok: messages.length === 0, messages };
}

// Whether the catalogue is accessible, which for a government service is a requirement and
// not a quality. Every story is rendered and scanned; a story that would not render at all
// counts against this, because an unrendered story is an unscanned one and the zero would
// otherwise be bought by the failure.
export function checkDesignAccessibility(projectDir) {
  const id = "design-accessibility";
  const { missing, unreadable, report } = readReport(projectDir);
  if (missing || unreadable) return { id, ok: false, messages: [`${REPORT_PATH} gives no accessibility scan. Run: ${SCAN_COMMAND}`] };
  const stories = Array.isArray(report?.stories) ? report.stories : [];
  if (!stories.length) return { id, ok: false, messages: [`${REPORT_PATH} records no story; nothing was scanned`] };
  const messages = [];
  const scanned = new Set(stories.map((s) => (s?.file ?? "").split("/").pop()).filter(Boolean));
  for (const f of catalogueFiles(projectDir)) {
    if (!scanned.has(f)) messages.push(`design/catalogue/${f}: no story from this file was scanned`);
  }
  for (const s of stories) {
    if (s?.error) messages.push(`${s.id}: did not render — ${s.error}`);
    for (const v of Array.isArray(s?.violations) ? s.violations : []) {
      messages.push(`${s.id}: ${v?.id} (${v?.impact}) — ${v?.help} [${(v?.nodes ?? []).join(", ")}]`);
    }
  }
  return { id, ok: messages.length === 0, messages };
}

// The harness the catalogue is compiled and scanned with, which a design run may read and
// must not change. Its workspace carries these files so the writer can see which version of
// the design system is available and what the last scan found; the same access would let a
// failing scan be answered by editing the scanner, which is the one repair that would make
// the gate's evidence worthless. Its own dependencies are not listed: `package-lock.json`
// is written by the installer, not by anybody, and is expected to move.
const HARNESS = ["design/package.json", "design/tsconfig.json", "design/scan.mjs", "design/.storybook/main.ts", "design/.storybook/preview.ts"];

export function checkDesignHarnessUntouched(projectDir) {
  const id = "design-harness-untouched";
  const messages = [];
  for (const file of HARNESS) {
    if (!gitOk(["cat-file", "-e", `HEAD:${file}`], projectDir)) continue;
    const full = join(projectDir, file);
    if (!existsSync(full)) { messages.push(`${file} was deleted; a design run may not change the harness it is checked by`); continue; }
    // Asked of git rather than compared as text: the helper trims what it reads back, so a
    // file and its committed copy would differ by a final newline and nothing else.
    if (!gitOk(["diff", "--quiet", "HEAD", "--", file], projectDir))
      messages.push(`${file} was changed; a design run may not change the harness it is checked by`);
  }
  return { id, ok: messages.length === 0, messages };
}
