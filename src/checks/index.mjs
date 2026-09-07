import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkConfig } from "./config.mjs";
import { checkLayout } from "./layout.mjs";
import { checkConstitution } from "./constitution.mjs";
import { checkEgress } from "./egress.mjs";
import { checkCriteria, checkCriteriaIndex } from "./criteria.mjs";

export async function runChecks(projectDir, opts = {}) {
  if (opts.self) return [checkEgress(projectDir, { self: true })];
  const cfg = checkConfig(projectDir);
  const ctx = { config: cfg.config };
  const checks = [cfg, checkLayout(projectDir, ctx), checkConstitution(projectDir, ctx), checkEgress(projectDir, ctx)];
  // `spec/domains` is only meaningful once a project has run archaeology (or has hand-
  // authored criteria in it); a project that has not reached that stage yet has nothing
  // for this check to read and is not penalised for it.
  if (existsSync(join(projectDir, "spec", "domains"))) {
    checks.push(checkCriteria(projectDir, ctx));
    checks.push(checkCriteriaIndex(projectDir));
  }
  return checks;
}
