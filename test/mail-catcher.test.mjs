import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGES_BY_NAME } from "../src/stages/registry.mjs";
import { calibrateEndpoint } from "../src/stages/calibrate.mjs";

// A target the pipeline builds declares its mail catcher in `.sdlc/config.yaml`
// (`targets.<t>.mail_api`). Every stage that points the acceptance suite, or an adapter
// session, at that target hands the address on as SDLC_MAIL_API, the way the oracle's own
// mail catcher is handed on from the ports `oracle up` chose.
const CONFIG = {
  project: { name: "p" },
  oracle: { target: "old" },
  targets: { new: { base_url: "http://localhost:8080", identity: "sandbox-idp", mail_api: "http://localhost:8025" } },
};

test("a binding run against a target that declares a mail catcher is given its address", (t) => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-mail-bind-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  process.env.SDLC_ORACLE = "mock";
  t.after(() => { delete process.env.SDLC_ORACLE; });
  const stage = STAGES_BY_NAME["bind-adapter"];
  const ctx = { target: "new", config: CONFIG };
  stage.preChecks(d, ctx);
  assert.equal(stage.env(ctx).SDLC_MAIL_API, "http://localhost:8025");
  assert.match(stage.prompt(ctx), /readable through a mail catcher at http:\/\/localhost:8025/);
  const bare = { target: "new", config: { ...CONFIG, targets: { new: { base_url: "http://localhost:8080", identity: "sandbox-idp" } } } };
  stage.preChecks(d, bare);
  assert.equal(stage.env(bare).SDLC_MAIL_API, "", "a target that declares none has none");
});

test("a calibration against a target the pipeline builds reads its mail catcher from the target's config", async () => {
  const r = await calibrateEndpoint("/nowhere", { config: CONFIG }, "new");
  assert.equal(r.mailApi, "http://localhost:8025");
  assert.equal(r.baseUrl, "http://localhost:8080");
});
