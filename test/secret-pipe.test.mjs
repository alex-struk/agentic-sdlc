// test/secret-pipe.test.mjs — secrets handed to an MCP server through a named pipe.
//
// Every reader here is a child process: a reader in this process would block the event
// loop the pipe is served from, and the MCP server that reads it for real is a process of
// its own anyway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openSecretPipe, withMcpSecrets } from "../src/lib/secret-pipe.mjs";

const run = promisify(execFile);
const PIPE_MODULE = new URL("../src/lib/secret-pipe.mjs", import.meta.url).href;

// `readFileSync` is exactly how the Playwright MCP server reads its `--secrets` path.
async function readInChild(path) {
  const { stdout } = await run(process.execPath,
    ["-e", `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(path)}, "utf8"))`],
    { timeout: 10_000 });
  return stdout;
}

test("a reader opening the pipe reads the dotenv text, and so does the next one", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-secret-pipe-"));
  const pipe = openSecretPipe(dir, { SDLC_SANDBOX_PASSWORD: "set-for-tests" });
  t.after(() => pipe.close());
  assert.ok(statSync(pipe.path).isFIFO());
  assert.equal(statSync(pipe.path).mode & 0o777, 0o600);
  assert.equal(await readInChild(pipe.path), "SDLC_SANDBOX_PASSWORD='set-for-tests'\n");
  assert.equal(await readInChild(pipe.path), "SDLC_SANDBOX_PASSWORD='set-for-tests'\n", "a restarted server reads it again");
});

test("close() removes the pipe, can be called twice, and a pipe never closed does not keep a process alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-secret-pipe-close-"));
  const pipe = openSecretPipe(dir, { A_SECRET: "set-for-tests" });
  pipe.close();
  pipe.close();
  assert.equal(existsSync(pipe.path), false);

  // A process that opens a pipe and then has nothing left to do exits on its own; one that
  // closes its pipe exits too. Either hanging fails on the timeout.
  const childDir = mkdtempSync(join(tmpdir(), "sdlc-secret-pipe-exit-"));
  for (const tail of ["", "p.close();"]) {
    const script = `import { openSecretPipe } from ${JSON.stringify(PIPE_MODULE)};\n`
      + `const p = openSecretPipe(${JSON.stringify(childDir)}, { A_SECRET: "set-for-tests" }); ${tail}`;
    await run(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000 });
    for (const f of readdirSync(childDir)) rmSync(join(childDir, f));
  }
});

test("empty or missing values open no pipe", () => {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-secret-pipe-empty-"));
  assert.equal(openSecretPipe(dir, { SDLC_SANDBOX_PASSWORD: "" }), null);
  assert.equal(openSecretPipe(dir, { SDLC_SANDBOX_PASSWORD: undefined }), null);
  assert.equal(openSecretPipe(dir, {}), null);
  assert.deepEqual(readdirSync(dir), []);
});

test("a value is quoted so dotenv reads it back exactly, and one that cannot be is refused without being named", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-secret-pipe-quote-"));
  const pipe = openSecretPipe(dir, { A: "it's #1", B: "a'b`c" });
  t.after(() => pipe.close());
  assert.equal(await readInChild(pipe.path), "A=`it's #1`\nB=\"a'b`c\"\n");
  assert.throws(() => openSecretPipe(dir, { C: "two\nlines" }), (e) => /^C cannot be written/.test(e.message) && !e.message.includes("two"));
  assert.throws(() => openSecretPipe(dir, { D: `'"\`\\` }), /D cannot be written/);
  assert.equal(readdirSync(dir).length, 1, "a refused value creates no pipe");
});

test("withMcpSecrets adds --secrets <pipe> to the named server only, and leaves servers alone when there is nothing to give", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-secret-pipe-with-"));
  const servers = { playwright: { command: "npx", args: ["-y", "pkg"] }, other: { command: "x", args: [] } };
  const r = withMcpSecrets(dir, servers, { server: "playwright", values: { SDLC_SANDBOX_PASSWORD: "set-for-tests" } });
  t.after(() => r.pipe.close());
  assert.deepEqual(r.mcpServers.playwright.args, ["-y", "pkg", "--secrets", r.pipe.path]);
  assert.deepEqual(r.mcpServers.other, servers.other);
  assert.deepEqual(servers.playwright.args, ["-y", "pkg"], "the stage's own declaration is not changed");
  assert.ok(!JSON.stringify(r.mcpServers).includes("set-for-tests"));

  assert.deepEqual(withMcpSecrets(dir, servers, undefined), { mcpServers: servers, pipe: null });
  assert.deepEqual(withMcpSecrets(dir, servers, { server: "playwright", values: { SDLC_SANDBOX_PASSWORD: "" } }), { mcpServers: servers, pipe: null });
  assert.throws(() => withMcpSecrets(dir, servers, { server: "browser", values: { X: "y" } }), /"browser", which this stage does not declare/);
});
