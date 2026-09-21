import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The pipeline's own checkout, wherever it was installed from. Everything the pipeline
// owns and a project copies — the project templates, the stack profiles, the skills — is
// read relative to this, so a module that needs one of them does not have to reach
// through a command module to find the root.
export const PIPELINE_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
