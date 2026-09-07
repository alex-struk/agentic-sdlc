// The Markdown rendering of the site model: the plain-text record that lives in the
// repository and reads in a diff. It is deliberately dumb — one table per thing, no
// styling, no navigation beyond links — because its job is to be greppable and to make
// a change to the project visible as a change to a file.
import { STATES } from "../spec/criteria.mjs";
import { RESULT_VALUES, resultRows } from "./model.mjs";

// A GitHub-flavoured Markdown table built from a column-array header and one array of
// cells per row, rather than joining strings by hand at each call site: that is what
// keeps an empty column list (no target directories yet) from leaving a dangling
// `| ... |  |` with a phantom trailing column, since the separator row is always derived
// from `headerCols.length` rather than from joining a possibly-empty list of its own.
function mdTable(headerCols, rowsCols) {
  return [`| ${headerCols.join(" | ")} |`, `| ${headerCols.map(() => "---").join(" | ")} |`,
    ...rowsCols.map((cols) => `| ${cols.join(" | ")} |`)].join("\n");
}

// `<covered>/<accepted>`, with a not-testable count folded in when the domain has any —
// blank when the domain has neither a spec file nor a not-testable entry, since a bare
// `0/0` would misread as "nothing accepted" rather than "coverage not run yet".
function testsColumn(domain) {
  const { covered, missing, notTestable } = domain.coverage;
  if (!domain.hasSpecFile && notTestable.length === 0) return "";
  const accepted = covered.length + missing.length + notTestable.length;
  const nt = notTestable.length ? ` (n/t ${notTestable.length})` : "";
  return `${covered.length}/${accepted}${nt}`;
}

// `<n> pass · <n> fail · <n> unbound · <n> stale` across this domain's rows in one
// target's `latest.json` — `not-testable` rows are left out, since a not-testable
// criterion is already accounted for in the `tests` column and counting it again here
// would double-report it. Blank when the target has no results file at all yet, which is
// a different claim from every count being zero (a results file that simply has no row
// for this domain still prints zeros, honestly reporting "ran, found nothing here").
function resultCountsColumn(latest, domain) {
  if (!latest) return "";
  const rows = resultRows(latest).filter((r) => r?.domain === domain);
  return ["pass", "fail", "unbound", "stale"].map((k) => `${rows.filter((r) => r.result === k).length} ${k}`).join(" · ");
}

// A criterion's `test` cell on its domain page: the spec file's path relative to
// `tests/` when `coverage` found one, the not-testable reason when it is recorded
// instead, or `—` for a criterion coverage has nothing to say about (not accepted yet,
// or accepted but missing both).
function testCell(cov, notTestableEntries, domain, id) {
  if (cov.covered.includes(id)) return `acceptance/${domain}/${id}.spec.ts`;
  if (cov.notTestable.includes(id)) {
    const entry = notTestableEntries.find((e) => e?.id === id);
    return `not testable: ${entry?.reason ?? ""}`;
  }
  return "—";
}

// A criterion's cell in one target's column: the row's own result, with the ruling verb
// appended when a calibration ruling already answered it, or blank when the target's
// results carry no row for this criterion at all (never run against it, or a domain
// nobody has derived tests for yet).
function targetCell(latest, id) {
  const row = resultRows(latest).find((r) => r?.id === id);
  if (!row) return "";
  return row.ruled ? `${row.result} (ruled: ${row.ruled})` : row.result;
}

export function renderMarkdown(model) {
  const { targets, latest } = model;
  const coverageHeader = ["Domain", ...STATES, "open questions", "total", "tests", ...targets];
  const coverageRows = model.domains.map((d) => [
    d.name, ...d.stateCounts, d.openQuestions, d.total,
    testsColumn(d), ...targets.map((t) => resultCountsColumn(latest.get(t), d.name)),
  ]);
  const totalsRow = ["**Totals**", ...model.totals.stateCounts, model.totals.openQuestions, model.totals.total, "", ...targets.map(() => "")];
  const coverageLines = ["## Coverage", "", mdTable(coverageHeader, [...coverageRows, totalsRow]), ""];

  // One page per domain that appears in the index, one section per criterion: the
  // heading names id/version/confidence/state, then the statement and whichever of
  // given/when/then, cites (recovered criteria only — an authored criterion carries no
  // citations), reconciliation, replaces/superseded-by and notes are actually set. The
  // bullet order matches `serialiseDomainFile`'s domain-file format, minus `tier` (a
  // reviewer field the coverage board has no use for) and `state` (already in the
  // heading, not repeated as a bullet here).
  const byName = new Map(model.domains.map((d) => [d.name, d]));
  const criteriaPages = model.pageDomains.map((name) => {
    const domain = byName.get(name);
    const cov = domain.coverage;
    const testsTable = mdTable(["id", "test", ...targets], domain.criteria.map((c) =>
      [c.id, testCell(cov, model.notTestable, name, c.id), ...targets.map((t) => targetCell(latest.get(t), c.id))]));
    const blocks = domain.criteria.map((c) => {
      const lines = [`### ${c.id} · v${c.version} · ${c.confidence} · ${c.state}`, "", c.statement];
      for (const cite of c.cites ?? []) lines.push(`- cites: ${cite.line !== undefined ? `${cite.path}:${cite.line}` : cite.path}`);
      if (c.reconciliation) lines.push(`- reconciliation: ${c.reconciliation}`);
      if (c.given) lines.push(`- given: ${c.given}`);
      if (c.when) lines.push(`- when: ${c.when}`);
      if (c.then) lines.push(`- then: ${c.then}`);
      if (c.replaces) lines.push(`- replaces: ${c.replaces}`);
      if (c.supersededBy) lines.push(`- superseded-by: ${c.supersededBy}`);
      for (const note of c.notes ?? []) lines.push(`- note: ${note}`);
      return lines.join("\n");
    });
    return [`site/criteria/${name}.md`, [`# ${name}`, "## Tests", testsTable, ...blocks].join("\n\n") + "\n"];
  });

  // `Cost` is what the ruling turn itself cost. A human ruling has no turn to measure
  // and its cell is blank, which is not the same claim as $0 — an agent ruling that
  // genuinely cost nothing (a mandatory escalation, a mock) does print $0.
  const gatesMd = ["# Gate log", "", "| When | Proposal | Gate | Verdict | By | Held | Cost | Sample |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...model.gates.map((g) => `| ${g.at} | ${g.name} | ${g.gate} | ${g.verdict} | ${g.by} | ${g.held_by === "agent" ? "agent-held, unsampled" : "human"} | ${g.cost === undefined ? "" : `$${g.cost}`} | ${model.sampled.has(g) ? "sample" : ""} |`), ""].join("\n");

  const runsMd = ["# Run log", "", ...model.runs.map((r) => r.text)].join("\n");

  // One section per target: every dated results file `calibrate` wrote against it
  // (`latest.json` and `applied.yaml` excluded — the first is a duplicate of the newest
  // dated file, and the second is calibration's own bookkeeping, not a run record),
  // newest first, plus whether a calibration ruling is still open for that target. No
  // targets at all — a project that has never run `calibrate` — gets a page saying so
  // rather than an empty "## " heading with nothing under it.
  const resultsMd = targets.length === 0 ? "# Results\n\nThere are no results yet.\n" :
    ["# Results", "", ...targets.map((target) => {
      const table = mdTable(["file", "at", ...RESULT_VALUES], model.resultFiles.get(target).map((e) => [e.file, e.at, ...e.counts]));
      const open = model.openCalibration.get(target);
      const proposalLine = open ? `Open calibration proposal: ${open}.` : "no calibration ruling open.";
      return [`## ${target}`, "", table, "", proposalLine].join("\n");
    }), ""].join("\n\n");

  const journalMd = ["# Journal", "", ...model.journal.slice().reverse().flatMap((e) => {
    const num = (e.file.match(/^(\d+)/) ?? [, ""])[1];
    const date = e.at ? String(e.at).slice(0, 10) : "";
    return [`## ${num} · ${e.stage} · ${date}`, "", `cost $${e.cost} · turns ${e.turns}`, "", e.body.trim(), ""];
  })].join("\n");

  const proposalPages = model.proposals.map((p) => {
    const rows = [["gate", p.front.gate ?? ""], ["opened", p.front.opened ?? ""]];
    if (p.front.tier) rows.push(["tier", p.front.tier]);
    rows.push(["holder", p.holder]);
    const table = ["| Field | Value |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
    let tail = null;
    if (p.hasRulingSection) tail = null;
    else if (!p.ruling) tail = `_Open, waiting for ${p.holder}_`;
    else if (p.ruling.verdict === "escalated") tail = `_Escalated to ${p.ruling.escalate_to}: ${p.ruling.rationale}_`;
    else tail = `_Ruled: ${p.ruling.verdict} by ${p.ruling.by}_`;
    const parts = [table, p.body.trim()];
    if (tail) parts.push(tail);
    return [`site/proposals/${p.name}.md`, parts.join("\n\n") + "\n"];
  });

  // No generation timestamp: the site is committed by whatever run or ruling regenerated
  // it, so git already dates it, and a timestamp would make every rebuild a diff — which
  // is what turns `sdlc status` on an unchanged project into a dirty tree.
  const index = [`# ${model.project.name} — state`, "", `Profile: ${model.project.profile}`, "",
    ...coverageLines,
    "## Pages", "",
    "- [Journal](journal.md)", "- [Gates](gates.md)", "- [Runs](runs.md)", "- [Results](results.md)",
    ...model.proposals.map((p) => `- [${p.name}](proposals/${p.name}.md)`), "",
    "## Criteria", "",
    ...model.pageDomains.map((d) => `- [${d}](criteria/${d}.md)`), "",
    "## Totals", "",
    `- Journal cost: $${model.costs.journal}`,
    `- Rulings cost: $${model.costs.rulings}`,
    `- Total cost: $${model.costs.total}`,
    `- Agent-held rulings: ${model.counts.agentRulings}`,
    `- Open escalations: ${model.counts.openEscalations}`,
    `- Open proposals: ${model.counts.openProposals}`, ""].join("\n");

  return [["site/index.md", index], ["site/gates.md", gatesMd], ["site/runs.md", runsMd], ["site/results.md", resultsMd],
    ["site/journal.md", journalMd], ...proposalPages, ...criteriaPages];
}
