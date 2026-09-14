// The checks behind gate G-DESIGN. A design catalogue is worth a reviewer's time only if
// it covers the screens the contract actually names, so these are about coverage and
// about the two ways a catalogue stops being a design system: a screen nobody drew, and a
// colour somebody typed in by hand.
//
// None of them renders anything. Rendering the catalogue needs a browser and a built
// Storybook, which is a second piece of machinery and a second decision; what a person can
// be told deterministically, before any of that exists, is whether every screen and every
// state the design itself declares has a story behind it.
import { existsSync, readdirSync } from "node:fs";
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

// Page ids as the contract spells them. A surface that will not parse is not this check's
// failure to report — `checkContract` owns that — so it reads as no pages rather than as
// an error here, and the catalogue check says only that it found nothing to cover.
export function surfacePageIds(projectDir) {
  const doc = readYaml(join(projectDir, SURFACE_PATH));
  const pages = doc?.pages;
  if (Array.isArray(pages)) return pages.map((p) => p?.id).filter(Boolean);
  if (pages && typeof pages === "object") return Object.keys(pages);
  return [];
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
export function checkDesignCatalogue(projectDir) {
  const id = "design-catalogue";
  const messages = [];
  const screensPath = join(projectDir, SCREENS_PATH);
  if (!existsSync(screensPath)) return { id, ok: false, messages: [`${SCREENS_PATH} is missing`] };
  const doc = readYaml(screensPath);
  const screens = Array.isArray(doc?.screens) ? doc.screens : null;
  if (!screens) return { id, ok: false, messages: [`${SCREENS_PATH}: no "screens" list`] };

  const pageIds = surfacePageIds(projectDir);
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

  for (const page of pageIds) {
    if (!declared.has(page)) messages.push(`${SCREENS_PATH}: ${page} is in the contract's surface but has no screen`);
  }
  for (const page of declared.keys()) {
    if (pageIds.length && !pageIds.includes(page)) messages.push(`${SCREENS_PATH}: ${page} is not a page the contract's surface names`);
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
const COLOUR = /(#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\()/;

export function checkDesignNoLiteralColours(projectDir) {
  const id = "design-no-literal-colours";
  const messages = [];
  const dir = join(projectDir, "design");
  if (!existsSync(dir)) return { id, ok: true, messages };
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const next = rel ? join(rel, entry.name) : entry.name;
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
