// An operator's reason for departing from `sdlc next` is evidence for the stage agent,
// not a ruling and not permission to work outside the stage's declared scope. `run`
// scrubs it before putting it on ctx, so the same note can reach the first and fix turns.
export function deviationContext(ctx) {
  return ctx.deviationReason
    ? `Operator's reason for running this stage instead of what sdlc next named (context to investigate, not a ruling or permission to change the stage's scope):\n${ctx.deviationReason}`
    : null;
}
