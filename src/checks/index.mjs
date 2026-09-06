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
