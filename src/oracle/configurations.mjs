// The configurations the approved contract names: settings the target reads once at start-up,
// which a test therefore cannot reach by acting on a running service. Each is written in
// `spec/contract/observables.yaml` under `configurations:`, keyed by name:
//
//   configurations:
//     <name>:
//       for: [<criterion id>, ...]
//       select: <VARIABLE>=<value>        # one or more, space-separated; or a mapping
//       tag: "@<name>"
//
// `select` is the environment an oracle instance is started with to be in that configuration,
// and each variable it names is one the oracle override interpolates. `tag` is what every test
// written for that configuration carries. The suite's ordinary run leaves those tests out, and
// they run on their own against an instance started with `select`
// (`docs/decisions/0071-a-configuration-gets-its-own-oracle.md`).
//
// Every other key under a configuration (`default`, `sets`, `observable`, `notes`) is for the
// test writer and the ruler, and nothing here reads it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { oracleOverridePath } from "./paths.mjs";
import { TAG_RE, taggedSpecFiles } from "../testrun/tags.mjs";

const OBSERVABLES = "spec/contract/observables.yaml";
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// A YAML file as plain data, with tags it does not know — Compose's `!override` and `!reset`
// — read as the value they are attached to, and without the warning those tags would print.
function readYaml(abs) {
  const doc = parseDocument(readFileSync(abs, "utf8"));
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  return doc.toJS();
}

// `select` as `{ VARIABLE: value }`. A string holds one or more `VARIABLE=value` pairs,
// separated by spaces or commas; a mapping is taken as it stands.
function parseSelect(select, where, errors) {
  const env = {};
  if (select && typeof select === "object" && !Array.isArray(select)) {
    for (const [k, v] of Object.entries(select)) env[k] = String(v ?? "");
  } else if (typeof select === "string" && select.trim()) {
    for (const pair of select.trim().split(/[\s,]+/)) {
      const eq = pair.indexOf("=");
      if (eq <= 0) { errors.push(`${where}.select: "${pair}" is not VARIABLE=value`); continue; }
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  } else {
    errors.push(`${where}.select: missing; it names the environment an oracle is started with to be in this configuration`);
    return env;
  }
  for (const k of Object.keys(env)) if (!VARIABLE.test(k)) errors.push(`${where}.select: "${k}" is not an environment variable name`);
  if (!Object.keys(env).length && !errors.length) errors.push(`${where}.select: names no variable`);
  return env;
}

// Every configuration the contract on disk names, in the order it names them, and what is
// wrong with any of them. A project with no contract, or a contract with no `configurations:`
// block, has none.
export function readConfigurations(projectDir) {
  const abs = join(projectDir, OBSERVABLES);
  if (!existsSync(abs)) return { configurations: [], errors: [] };
  let doc;
  try { doc = readYaml(abs) ?? {}; } catch (e) { return { configurations: [], errors: [`${OBSERVABLES} does not parse: ${e.message}`] }; }
  const block = doc?.configurations;
  if (block === undefined || block === null) return { configurations: [], errors: [] };
  if (typeof block !== "object" || Array.isArray(block)) {
    return { configurations: [], errors: [`${OBSERVABLES} configurations: is not a mapping of name to configuration`] };
  }
  const configurations = [];
  const errors = [];
  const tags = new Map();
  for (const [name, entry] of Object.entries(block)) {
    const where = `${OBSERVABLES} configurations.${name}`;
    const before = errors.length;
    if (!NAME.test(name)) errors.push(`${where}: the name may hold only letters, digits, "_" and "-"`);
    if (!entry || typeof entry !== "object") { errors.push(`${where}: is not a mapping`); continue; }
    const env = parseSelect(entry.select, where, errors);
    const tag = typeof entry.tag === "string" ? entry.tag.trim() : "";
    if (!TAG_RE.test(tag)) errors.push(`${where}.tag: ${tag ? `"${tag}" is not a tag (an "@" and then letters, digits, "_", ".", ":" or "-")` : "missing; it is how the tests written for this configuration are selected"}`);
    else if (tags.has(tag)) errors.push(`${where}.tag: "${tag}" is also configurations.${tags.get(tag)}'s tag`);
    else tags.set(tag, name);
    if (errors.length > before) continue;
    configurations.push({ name, tag, env, for: Array.isArray(entry.for) ? entry.for.map(String) : [] });
  }
  return { configurations, errors };
}

// The names a Compose file interpolates from the environment: `${NAME}`, `${NAME:-default}`
// and the rest of that family, and bare `$NAME`. Read from the parsed values, so a name that
// appears only in a comment does not count; `$$` is Compose's literal dollar sign and names
// nothing.
function interpolated(value, into) {
  if (typeof value === "string") {
    const text = value.replace(/\$\$/g, "");
    for (const m of text.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g)) into.add(m[1] ?? m[2]);
  } else if (Array.isArray(value)) {
    for (const v of value) interpolated(v, into);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { interpolated(k, into); interpolated(v, into); }
  }
  return into;
}

// The variables the oracle override reads, or `null` with the reason when it cannot be read.
export function overrideVariables(projectDir, config) {
  const rel = oracleOverridePath(config);
  const abs = join(projectDir, rel);
  if (!existsSync(abs)) return { rel, variables: null, error: `${rel} is missing` };
  try { return { rel, variables: interpolated(readYaml(abs), new Set()) }; }
  catch (e) { return { rel, variables: null, error: `${rel} does not parse: ${e.message}` }; }
}

// Why the oracle cannot be started in `configuration`: each variable its `select` names has to
// be one the override reads, or the instance started "in" it is the default instance under
// another name.
export function unreadVariables(projectDir, config, configuration) {
  const { rel, variables, error } = overrideVariables(projectDir, config);
  if (!variables) return [`configurations.${configuration.name}: ${error}, so nothing can start the oracle in this configuration`];
  const unread = Object.keys(configuration.env).filter((k) => !variables.has(k));
  return unread.map((k) => `configurations.${configuration.name} selects ${k}, which ${rel} does not read, so an oracle started with it would be the default one`);
}

// Why a calibration run cannot route `configurations`: a variable the override does not read,
// or a tag no acceptance test carries. The second is a configuration whose tests the default
// run would leave out and no other run would find, or a tag spelled differently in the tests.
export function configurationProblems(projectDir, config, configurations) {
  const problems = [];
  for (const c of configurations) {
    problems.push(...unreadVariables(projectDir, config, c));
    if (!taggedSpecFiles(projectDir, c.tag).length) {
      problems.push(`configurations.${c.name}: no test under tests/acceptance/ carries its tag ${c.tag}, so nothing would run against an oracle started in it`);
    }
  }
  return problems;
}

// The compose project a configuration's copy runs as. Compose accepts lower-case letters,
// digits, "_" and "-", so a name is folded into that.
export function configurationProject(base, name) {
  return `${base}-${name.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
}
