import { mkdirSync, readdirSync, statSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
export function ensureDir(p) { mkdirSync(p, { recursive: true }); }
export function readText(p) { return readFileSync(p, "utf8"); }
export function writeText(p, text) { ensureDir(dirname(p)); writeFileSync(p, text); }
export function copyTree(src, dst) {
  ensureDir(dst);
  for (const name of readdirSync(src)) {
    const s = join(src, name), d = join(dst, name);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else if (!existsSync(d)) copyFileSync(s, d);
  }
}
