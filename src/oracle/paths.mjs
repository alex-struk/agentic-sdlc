// Paths the oracle's own files live at, in one place because two callers that must agree
// on them sit on opposite sides of the pipeline: `contract` writes the Compose override
// (`src/stages/registry.mjs`) and `sdlc oracle` reads it back
// (`src/commands/oracle.mjs`). Kept out of both so neither has to import the other.

// The default path for the Compose override `contract` writes when a project configures
// an oracle at all — `.sdlc/oracle/compose.yml`, applied here in code rather than in the
// schema, so a project that never sets `oracle.compose_override` still gets a fixed,
// predictable path for `sdlc oracle` (and `contract`'s own post-check) to find.
export function oracleOverridePath(config) {
  return config?.oracle?.compose_override ?? ".sdlc/oracle/compose.yml";
}
