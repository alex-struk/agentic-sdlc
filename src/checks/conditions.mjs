// Whether every instruction a ruling wrote down has been accounted for.
//
// A ruling's conditions are instructions, and each kind is followed to a different place: an
// `addressed-to` line becomes a revision request the addressed stage takes up, a
// `test-overreaches` line becomes a redo entry `derive-tests` answers, and a plain condition
// on a return is carried out by the stage the proposal goes back to. What none of them had
// was a place that says, on every later run, which are still owed.
//
// That is what this reads back. It never decides whether a condition was met — that is a
// ruling, and `condition-met`/`condition-withdrawn` on a later ruling is how one is made.
// It decides whether anybody has made it.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readText } from "../lib/fsx.mjs";
import { CONDITION_MET_FORM, CONDITION_WITHDRAWN_FORM } from "../spec/criteria.mjs";
import { isOpen, read } from "../spec/owed.mjs";
import { missingTestRef, openMissingTests } from "../spec/missing-tests.mjs";
import { proposalFamily, stageForProposal } from "../stages/registry.mjs";

// Every approval recorded in this project, as `{ name, family, at }`. Only an approval's
// gate file reaches `main`, and a return's is copied there by the `--revise` run that spends
// it, so this is read off the directory rather than off any branch.
function approvals(projectDir) {
  const dir = join(projectDir, ".sdlc", "gates");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml")) continue;
    let doc;
    try { doc = parseYaml(readText(join(dir, file))); } catch { continue; }
    if (doc?.verdict !== "approve") continue;
    const name = file.replace(/\.yaml$/, "");
    out.push({ name, family: proposalFamily(name), stage: stageForProposal(name), at: String(doc.at ?? "") });
  }
  return out;
}

// The approval that makes one outstanding instruction a contradiction rather than a thing
// still in progress: the same line of work was approved afterwards and nobody said anything
// about the instruction on the way through.
//
// The line of work, not the stage. A stage revises several artifacts over a project's life —
// one domain's tests, then another's — and an approval of one says nothing about an
// instruction left on another. `proposalFamily` is what draws that line.
//
// Timestamps are ISO strings and compare as strings. An entry or a gate file with no `at` is
// left alone rather than guessed at: an instruction is reported as overtaken only where the
// order of events is actually known.
function approvedSince(all, family, at) {
  if (!family || !at) return null;
  return all.find((a) => a.family === family && a.at && a.at > at) ?? null;
}

const quote = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

// `ok` is the whole judgement this makes, and it is deliberately narrow. An instruction that
// is merely still owed is the ordinary state between a return and the revision that answers
// it, and failing on that would refuse every project for as long as any revision is in
// flight. It is a warning, on every run, which is what "still owed" deserves.
//
// It fails where the instruction has been overtaken: the stage was asked for something, its
// work was approved afterwards, and no ruling ever said whether the thing was done. At that
// point the gate files assert two things that cannot both be true, and the fix is one line
// from a ruler either way — `condition-met` if it was done, `condition-withdrawn` if it is
// not wanted. Neither is a guess about the work; both are somebody saying so.
export function checkConditions(projectDir) {
  const id = "conditions";
  const all = approvals(projectDir);
  const messages = [];
  const warnings = [];

  for (const c of read(projectDir, "condition").filter(isOpen)) {
    const where = `ruled at ${c.gate ?? "?"} on ${c.from ?? "?"} by ${c.by ?? "?"}`;
    const line = `${c.ref}: "${quote(c.text)}" — asked of ${c.stage ?? "?"}, ${where}`;
    const overtaken = approvedSince(all, c.family ?? proposalFamily(c.from), c.at);
    if (overtaken) {
      messages.push(`${line}. ${overtaken.name} was approved afterwards and no ruling has said whether this was done.`
        + ` Close it on a ruling with \`${CONDITION_MET_FORM}\` or \`${CONDITION_WITHDRAWN_FORM}\`.`);
    } else {
      warnings.push(`${line}. Still owed; close it on a ruling with \`${CONDITION_MET_FORM}\` or \`${CONDITION_WITHDRAWN_FORM}\`.`);
    }
  }

  // The same question of the other ledger. A revision request is followed from filing to
  // consumption already, but nothing read the gap back: one filed and never taken sits on the
  // list indefinitely, and a stage whose work was approved after it was filed was approved
  // without it.
  //
  // A warning either way, including where an approval has overtaken it, because the only way
  // to clear a revision request is to take it up: there is no ruling that withdraws one. A
  // failure nobody can answer except by running a stage is a failure that gets worked around,
  // and giving requests a withdrawal of their own is its own change.
  for (const r of read(projectDir, "request").filter(isOpen)) {
    // A request a run was given and could not answer carries its own account of why, and
    // that is the thing worth reading back: without it the line says only that nobody has
    // taken the request up, which is also what it said before a run tried.
    const deferred = r.deferred?.why ? ` A run${r.deferred.proposal ? ` opening ${r.deferred.proposal}` : ""} deferred it: "${quote(r.deferred.why)}"` : "";
    const line = `${r.stage ?? "?"} has an untaken revision request from ${r.from ?? "?"} (${r.gate ?? "?"}, ${r.by ?? "?"}): "${quote(r.why)}"${deferred}`;
    // A revision request names a stage rather than one of its proposals, so the stage is the
    // line of work here: what was asked for is that stage's artifact, whichever of them the
    // ruling happened to be reading when it asked.
    const overtaken = all.find((a) => a.stage === r.stage && a.at && r.at && a.at > r.at) ?? null;
    warnings.push(overtaken
      ? `${line}. ${overtaken.name} was approved afterwards without it. Take it up with \`sdlc run ${r.stage} --revise\`.`
      : `${line}. Take it up with \`sdlc run ${r.stage} --revise\`.`);
  }

  // And the tests the project is owed. Each is closed by a test that runs and by nothing a
  // ruling writes, so the only line offered is the withdrawal — which is how a person in a
  // seat, handed no prompt, finds the reference to write it against.
  for (const e of openMissingTests(projectDir)) {
    const why = quote(e.readdressed?.at(-1)?.why ?? e.why);
    warnings.push(`${missingTestRef(e.item)}: owed by ${e.stage} — "${why.length > 200 ? `${why.slice(0, 200)}…` : why}". `
      + `Open until a test for it runs; where none is owed, withdraw it on a ruling with \`${CONDITION_WITHDRAWN_FORM}\`.`);
  }

  return { id, ok: messages.length === 0, messages, warnings };
}
