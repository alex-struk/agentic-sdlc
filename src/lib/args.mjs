export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    let value = true;
    if (next !== undefined && !next.startsWith("--")) { value = next; i++; }
    // A flag given once is its value; given again, it is every value it was given, in the
    // order they were typed. That is what lets one invocation carry a list — `rule --condition
    // ... --condition ...` — without a separator a condition's own text could contain.
    if (key in flags) flags[key] = [...[flags[key]].flat(), value];
    else flags[key] = value;
  }
  return { pos, flags };
}
