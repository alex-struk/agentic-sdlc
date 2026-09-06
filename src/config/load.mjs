import { readFileSync } from "node:fs";
import { parse } from "yaml";
import Ajv from "ajv";
import schema from "../../schema/config.schema.json" with { type: "json" };

const ajv = new Ajv({ allErrors: true, strict: true, formats: { uri: /^https?:\/\/\S+$/ } });
const validate = ajv.compile(schema);

export function parseConfig(text) {
  let config;
  // A YAML syntax error is a finding about the configuration, not a crash: `checks` and
  // `doctor` exist to report it, and both used to throw out of the middle of a run
  // instead of printing a line saying the file does not parse.
  try { config = parse(text); }
  catch (e) { return { config: null, errors: [`config.yaml is not valid YAML: ${e.message}`] }; }
  const ok = validate(config);
  const errors = ok ? [] : validate.errors.map((e) => `${e.instancePath || "/"}: ${e.message}`);
  return { config, errors };
}

export function loadConfig(path) {
  return parseConfig(readFileSync(path, "utf8"));
}
