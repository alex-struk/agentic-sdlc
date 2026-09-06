import { execFileSync } from "node:child_process";
export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function gitOk(args, cwd) {
  try { git(args, cwd); return true; } catch { return false; }
}
