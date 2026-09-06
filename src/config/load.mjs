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
