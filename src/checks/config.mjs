import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load.mjs";
import { stagesFor } from "../profiles.mjs";
import { TOKEN_BUDGET_FLOOR, MAX_TURNS_CEILING } from "../runner/executor.mjs";

export function checkConfig(projectDir, ctx = {}) {
  const id = "config";
  const p = join(projectDir, ".sdlc", "config.yaml");
  if (!existsSync(p)) return { id, ok: false, messages: [".sdlc/config.yaml is missing"], config: null };
  const { config, errors } = loadConfig(p);
  const messages = [...errors];
  try { stagesFor(config?.profile); } catch (e) { messages.push(e.message); }
  // A turn budget that the runner would ignore or silently reduce is worse than no budget
  // at all: it reads as a cap that a gate approved and a run honoured, and it is neither.
  // Refusing it here puts the failure in front of whoever proposes the number, rather than
  // an hour into the stage it was meant to size.
  for (const [stage, budget] of Object.entries(config?.policy?.budgets ?? {})) {
    if (typeof budget !== "number" || budget <= 0) continue;
    if (budget >= TOKEN_BUDGET_FLOOR) {
      messages.push(`policy.budgets.${stage} is ${budget}, which reads as a token budget rather than a turn count and would be ignored; set it below ${TOKEN_BUDGET_FLOOR}`);
    } else if (budget > MAX_TURNS_CEILING) {
      messages.push(`policy.budgets.${stage} is ${budget}, above the ${MAX_TURNS_CEILING}-turn ceiling; a stage needing more turns than that needs splitting, not a larger budget`);
    }
  }
  // A target that signs its tests in through a provider the project stands up itself is
  // the one shape `sandbox up` cannot settle from the application's own address: the web
  // tier answers, and whether anybody can sign in is a different question asked somewhere
  // else. A provider whose realm failed to load answers nothing and serves nothing, while
  // the application in front of it serves normally throughout.
  //
  // This warns rather than fails. The key is optional, a project may have decided it has
  // nothing to declare, and a check that failed would turn an addition into a requirement
  // every project already written is in breach of.
  const warnings = [];
  for (const [name, t] of Object.entries(config?.targets ?? {})) {
    if (t?.identity !== "sandbox-idp" || t?.depends_on?.identity) continue;
    warnings.push(`targets.${name} signs in through sandbox-idp and declares no targets.${name}.depends_on.identity, `
      + `so "sandbox up" reports it up without establishing that anything can sign in there`);
  }
  return { id, ok: messages.length === 0, messages, warnings, config };
}
