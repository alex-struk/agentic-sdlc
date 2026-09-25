// The configuration a ruling reasons from.
//
// `.sdlc/config.yaml` holds two different kinds of thing under one file name. Some of it
// describes the world the project runs in now — where a target answers, what services it
// depends on, which stack profile its toolchain is, which pipeline is installed. The rest
// describes the terms a proposal was made under, which is `policy`: who holds each gate,
// where a gate escalates, what tier is assumed, how many turns a stage may spend.
//
// A ruling has the proposal's own branch checked out, so both kinds arrive as the snapshot
// taken the day the branch was opened. For the first kind that snapshot is simply wrong:
// an address the project has since moved is not the address the acceptance suite drives,
// and a ruler quoting it reasons to a conclusion that is right about the branch and wrong
// about the project. `0013` settled the same argument for a persona brief — it describes
// the ruler rather than the change, so it is read from `main` — and configuration that
// describes the host and the environment belongs to the present for the same reason.
//
// Three rules follow, and the third is what keeps the first from hiding a proposal's own
// subject:
//
//   1. `main` governs, because it is what is true now.
//   2. `policy` is read from the branch: it is the policy the proposal was made under, and
//      it is what the runner acts on when it decides which seat may rule (`0013`). A
//      proposal that changes `policy` is the exception: it is ruled at G-POL alone, and
//      under `main`'s policy, so a change cannot choose its own ruler (`0043`,
//      `proposedPolicyChange` below).
//   3. A block the proposal itself changes is read from the branch, whichever kind it is.
//      A policy proposal, a proposal that republishes a target — its change IS the thing
//      being ruled on, and a ruler shown `main`'s copy instead would be ruling on the
//      absence of the change it was asked about.
//
// Whether the proposal changes a block is a fact, not an inference: the block is compared
// between the branch and the merge base, which is the same comparison the diff the ruler
// is shown is taken over. Nothing is read out of the proposal's prose.
//
// And where the branch and `main` disagree on a block the proposal does not change, both
// values are quoted and the disagreement named. Showing one of them silently is the defect
// this module exists for; which one was shown is exactly what the ruler could not see.
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { git, gitOk } from "../lib/git.mjs";

export const CONFIG_PATH = ".sdlc/config.yaml";

// The blocks a ruling reads from the proposal's own branch whether or not the proposal
// changes them. One entry, and the reason is `0013`'s: `policy` is the terms the proposal
// was made under, and the runner has already acted on the branch's copy of it by the time
// a prompt is built — it is what chose the seat. A prompt quoting `main`'s policy would be
// telling the ruler a different rule from the one it is being ruled under.
export const BRANCH_SCOPED_BLOCKS = ["policy"];

// Why each branch-scoped block stays with the branch, in the words the ruler is given.
const BRANCH_SCOPED_BECAUSE = {
  policy: "it is the policy this proposal was made under, and it is the copy the pipeline acted on when it chose the seat ruling this gate",
};

// No quoted block takes more than this. Every block the schema allows is a handful of
// lines, so this only ever fires on a project that has put something unexpected in one,
// and a cut that says it was cut is better than a prompt budget spent on a single key.
const BLOCK_CAP = 4000;

function readAt(projectDir, rev) {
  if (!gitOk(["cat-file", "-e", `${rev}:${CONFIG_PATH}`], projectDir)) return null;
  try { return parseYaml(git(["show", `${rev}:${CONFIG_PATH}`], projectDir)) ?? null; }
  catch { return null; }
}

// Key order is how a person chose to write a file, not a difference in what it says, so
// two blocks that differ only in it are the same block. Compared on the value rather than
// on the text for the same reason: a re-indented block is not a configuration change.
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
}

function same(a, b) {
  return JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));
}

function quoteBlock(key, value) {
  const text = value === undefined ? "(the block is absent)" : stringifyYaml({ [key]: value }).trimEnd();
  return text.length > BLOCK_CAP
    ? `${text.slice(0, BLOCK_CAP)}\n# [truncated: ${text.length - BLOCK_CAP} of ${text.length} characters of this block are not shown]`
    : text;
}

// The configuration as the ruling reasons from it, block by block, with where each block
// came from and what the other revision said.
//
// `config` is the resolved document: a parsed config object the rest of the ruling path can
// read a key out of exactly as it read the checkout's before. `blocks` is the account of how
// it was assembled, which is what the prompt section below is written from.
//
// A project whose `main` carries no configuration at all falls back to the branch entirely,
// the same fallback a persona brief has for a brief written and not yet committed.
function mergeBaseConfig(projectDir, branch) {
  const baseRev = gitOk(["merge-base", "main", branch], projectDir)
    ? git(["merge-base", "main", branch], projectDir) : null;
  return baseRev ? readAt(projectDir, baseRev) : null;
}

export function rulingConfig(projectDir, branch) {
  const main = readAt(projectDir, "main");
  const head = readAt(projectDir, branch);
  if (!main) return { config: head, blocks: [], fallback: "branch" };
  const base = mergeBaseConfig(projectDir, branch);

  const keys = [...new Set([...Object.keys(main), ...Object.keys(head ?? {})])].sort();
  const config = {};
  const blocks = [];
  for (const key of keys) {
    const mainValue = main[key];
    const branchValue = head?.[key];
    const proposed = !same(base?.[key], branchValue);
    const branchScoped = BRANCH_SCOPED_BLOCKS.includes(key);
    const governs = proposed || branchScoped ? "branch" : "main";
    const value = governs === "branch" ? branchValue : mainValue;
    if (value !== undefined) config[key] = value;
    blocks.push({ key, governs, proposed, differs: !same(mainValue, branchValue), mainValue, branchValue });
  }
  return { config, blocks, fallback: null };
}

// What the ruler is shown about the configuration: the resolved document, which blocks in
// it are the proposal's own change, which are read from the branch by policy, and every
// place the two revisions disagree without the proposal having asked for it.
//
// A person in this seat goes and reads `.sdlc/config.yaml`, and on a checked-out proposal
// branch that is the stale copy. The section is therefore written to be read aloud: it says
// what governs and why, so a person handed it rules the same ruling an agent does.
export function configSection(resolved) {
  if (!resolved?.config) return [];
  const blocks = resolved.blocks ?? [];
  const proposed = blocks.filter((b) => b.proposed);
  const disagreeing = blocks.filter((b) => b.differs && !b.proposed && b.governs === "main");
  const branchScoped = blocks.filter((b) => b.governs === "branch" && !b.proposed);

  const lines = [
    "## The project's configuration",
    "",
    "Rule from this, not from the copy of `.sdlc/config.yaml` on the branch. The branch carries the",
    "configuration as it stood when the branch was opened; what is below is the configuration as the",
    "project stands now, which is what an address, a service or a toolchain has to be true of.",
    "",
    "```yaml",
    stringifyYaml(resolved.config).trimEnd(),
    "```",
    "",
  ];

  if (resolved.fallback === "branch") {
    lines.push("`main` carries no configuration yet, so this is the branch's own copy.", "");
    return lines;
  }

  if (proposed.length) {
    lines.push(
      `### What this proposal changes`,
      "",
      `This proposal changes ${proposed.map((b) => `\`${b.key}\``).join(", ")}, and ${proposed.length === 1 ? "that block is" : "those blocks are"}`,
      "shown above as the proposal proposes it. That change is part of what you are ruling on: rule on what",
      "it asks for, not on what the project currently has.",
      "",
    );
    for (const b of proposed) {
      lines.push(`Currently on \`main\`:`, "", "```yaml", quoteBlock(b.key, b.mainValue), "```", "");
    }
  }

  for (const b of branchScoped) {
    const because = BRANCH_SCOPED_BECAUSE[b.key] ?? "it belongs to the proposal rather than to the project";
    lines.push(`\`${b.key}\` above is the branch's own copy, because ${because}.`, "");
    if (b.differs) {
      lines.push(
        `\`main\` carries a different \`${b.key}\`. The branch's is what governs this ruling; \`main\`'s is what a`,
        "proposal opened today would be ruled under:",
        "",
        "```yaml",
        quoteBlock(b.key, b.mainValue),
        "```",
        "",
      );
    }
  }

  if (disagreeing.length) {
    lines.push(
      "### Where the branch disagrees with `main`",
      "",
      `This proposal does not change ${disagreeing.map((b) => `\`${b.key}\``).join(", ")}, and the branch's copy of`,
      `${disagreeing.length === 1 ? "it says" : "them says"} something different from the project's. \`main\` governs and is what is quoted above.`,
      "Both are given here so the difference is yours to weigh rather than something you were shown one side of.",
      "",
    );
    for (const b of disagreeing) {
      lines.push(
        `\`${b.key}\` on \`main\` (this governs):`, "", "```yaml", quoteBlock(b.key, b.mainValue), "```", "",
        `\`${b.key}\` as this branch carries it (stale):`, "", "```yaml", quoteBlock(b.key, b.branchValue), "```", "",
      );
    }
  }

  return lines;
}

// Whether the proposal on `branch` changes the `policy` block, compared the same way
// `rulingConfig` compares every block: the branch against its merge base with `main`, on
// the value rather than the text. Where it does, `mainPolicy` is the policy it is ruled
// under. A project whose `main` carries no configuration has no policy to change yet.
export function proposedPolicyChange(projectDir, branch) {
  const main = readAt(projectDir, "main");
  if (!main) return { changed: false, mainPolicy: null };
  const head = readAt(projectDir, branch);
  const base = mergeBaseConfig(projectDir, branch);
  return { changed: !same(base?.policy, head?.policy), mainPolicy: main.policy ?? null };
}
