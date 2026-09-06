import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { git, gitOk } from "../lib/git.mjs";
import { copyTree, ensureDir } from "../lib/fsx.mjs";

export function packUrl(repo) {
  if (repo.includes("://") || repo.startsWith("/") || repo.startsWith(".")) return repo;
  return `https://github.com/${repo}.git`;
}
const packName = (repo) => basename(repo.replace(/\.git$/, "")).replace(/[^a-z0-9-]/gi, "-");

export function resolvePacks(packs, cwd) {
  return packs.filter((p) => p.enabled !== false).map((p) => {
    const url = packUrl(p.repo);
    let commit = p.ref;
    if (!/^[0-9a-f]{40}$/.test(p.ref)) {
      const out = git(["ls-remote", url, p.ref], cwd);
      if (!out) throw new Error(`pack ${p.repo}: ref ${p.ref} not found`);
      commit = out.split(/\s/)[0];
    }
    return { repo: p.repo, url, ref: p.ref, commit, skills: p.skills, name: packName(p.repo) };
  });
}

function findSkill(root, skill) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const n of readdirSync(d)) {
      if (n === ".git" || n === "node_modules") continue;
      const p = join(d, n);
      if (!statSync(p).isDirectory()) continue;
      if (n === skill && existsSync(join(p, "SKILL.md"))) return p;
      stack.push(p);
    }
  }
  return null;
}

export function installPacks(projectDir, resolved) {
  const installed = [], skipped = [];
  for (const p of resolved) {
    const dst = join(projectDir, ".sdlc", "packs", p.name);
    if (!existsSync(dst)) { ensureDir(join(projectDir, ".sdlc", "packs")); git(["clone", "-q", p.url, dst], projectDir); }
    if (git(["rev-parse", "HEAD"], dst) !== p.commit) {
      if (!gitOk(["cat-file", "-e", p.commit], dst)) git(["fetch", "-q", "origin", p.commit], dst);
      git(["checkout", "-q", p.commit], dst);
    }
    for (const s of p.skills) {
      const src = findSkill(dst, s);
      const target = join(projectDir, ".claude", "skills", s);
      if (!src) { skipped.push(`${p.repo}: skill ${s} not found`); continue; }
      if (existsSync(join(target, "SKILL.md"))) continue;
      copyTree(src, target); installed.push(`${p.repo}:${s}`);
    }
  }
  return { installed, skipped };
}
