import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContract, generateTypes, writeGenerated } from "../src/spec/surface.mjs";

function project() {
  return mkdtempSync(join(tmpdir(), "sdlc-surface-"));
}

function write(dir, relPath, text) {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
}

// ---- loadContract: missing files ----

test("loadContract: a project with no contract files yet returns an empty contract, no errors", () => {
  const dir = project();
  const contract = loadContract(dir);
  assert.deepEqual(contract.surface, { pages: [] });
  assert.deepEqual(contract.personas, { personas: [] });
  assert.deepEqual(contract.observables, {});
  assert.deepEqual(contract.manifest, {});
  assert.deepEqual(contract.errors, []);
});

// ---- loadContract: surface.yaml errors ----

test("loadContract: a page without an id is an error", () => {
  const dir = project();
  write(dir, "spec/contract/surface.yaml", `pages:\n  - route: /opportunities\n`);
  const { errors } = loadContract(dir);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], {
    file: "spec/contract/surface.yaml",
    message: 'page[0] is missing "id"',
  });
});

test("loadContract: a page without a route is an error", () => {
  const dir = project();
  write(dir, "spec/contract/surface.yaml", `pages:\n  - id: opportunity\n`);
  const { errors } = loadContract(dir);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], {
    file: "spec/contract/surface.yaml",
    message: 'page "opportunity" is missing "route"',
  });
});

test("loadContract: duplicate page ids are an error", () => {
  const dir = project();
  write(
    dir,
    "spec/contract/surface.yaml",
    `pages:\n  - id: opportunity\n    route: /a\n  - id: opportunity\n    route: /b\n`,
  );
  const { errors } = loadContract(dir);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], {
    file: "spec/contract/surface.yaml",
    message: 'duplicate page id "opportunity"',
  });
});

test("loadContract: an action whose value is not an object is an error", () => {
  const dir = project();
  write(
    dir,
    "spec/contract/surface.yaml",
    `pages:\n  - id: opportunity\n    route: /a\n    actions: { publish: null }\n`,
  );
  const { errors } = loadContract(dir);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], {
    file: "spec/contract/surface.yaml",
    message: 'page "opportunity" action "publish" is not an object',
  });
});

test("loadContract: an observation whose value is not an object is an error", () => {
  const dir = project();
  write(
    dir,
    "spec/contract/surface.yaml",
    `pages:\n  - id: opportunity\n    route: /a\n    observations: { status: "not an object" }\n`,
  );
  const { errors } = loadContract(dir);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], {
    file: "spec/contract/surface.yaml",
    message: 'page "opportunity" observation "status" is not an object',
  });
});

test("loadContract: a valid page with actions and observations reports no errors", () => {
  const dir = project();
  write(
    dir,
    "spec/contract/surface.yaml",
    `pages:\n  - id: opportunity\n    route: /opportunities/:id\n    actions: { publish: { test_id: null } }\n    observations: { status: { test_id: null } }\n`,
  );
  const { surface, errors } = loadContract(dir);
  assert.deepEqual(errors, []);
  assert.equal(surface.pages.length, 1);
  assert.equal(surface.pages[0].id, "opportunity");
});

// ---- loadContract: personas.yaml errors ----

test("loadContract: a persona without an id is an error", () => {
  const dir = project();
  write(dir, "spec/contract/personas.yaml", `personas:\n  - can: [publish opportunity]\n`);
  const { errors } = loadContract(dir);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], {
    file: "spec/contract/personas.yaml",
    message: 'persona[0] is missing "id"',
  });
});

// ---- loadContract: manifest.yaml errors ----

test("loadContract: a manifest handle whose value is not a string or an object with id is an error", () => {
  const dir = project();
  write(
    dir,
    "tests/seed/manifest.yaml",
    `description: seed handles\nusers:\n  vendorOne: 42\n`,
  );
  const { errors } = loadContract(dir);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], {
    file: "tests/seed/manifest.yaml",
    message: 'manifest handle "users.vendorOne" is not a string or an object with "id"',
  });
});

test("loadContract: a manifest handle that is a bare string, or an object with id, is valid", () => {
  const dir = project();
  write(
    dir,
    "tests/seed/manifest.yaml",
    `description: seed handles\nusers:\n  vendorOne: { id: "11111111-1111-1111-1111-111111111111", email: vendor-1@example.test }\nopportunities:\n  draftCwu: "22222222-2222-2222-2222-222222222222"\n`,
  );
  const { manifest, errors } = loadContract(dir);
  assert.deepEqual(errors, []);
  assert.equal(manifest.users.vendorOne.id, "11111111-1111-1111-1111-111111111111");
  assert.equal(manifest.opportunities.draftCwu, "22222222-2222-2222-2222-222222222222");
});

// ---- generateTypes ----

// A two-page, two-persona, one-handle contract, built directly (not through
// loadContract) so the generator's own contract, not the loader, is under test.
function sampleContract() {
  return {
    surface: {
      pages: [
        {
          id: "opportunity",
          route: "/opportunities/:id",
          title: "Opportunity",
          actions: { publish: { test_id: null }, "close-early": { test_id: null } },
          observations: { status: { test_id: null } },
        },
        {
          id: "vendor-dashboard",
          route: "/vendor",
          title: "Vendor dashboard",
          actions: {},
          observations: { opportunity_count: { test_id: null } },
        },
      ],
    },
    personas: {
      personas: [
        {
          id: "public-sector-admin",
          can: ["publish opportunity"],
          sign_in: { "sandbox-idp": { username: "admin-1" } },
        },
        { id: "vendor", domain: "procurement" },
      ],
    },
    observables: { email: { via: "mail-catcher", api: "http://localhost:8025" } },
    manifest: {
      description: "seed data handles for the acceptance suite",
      users: { vendorOne: { id: "11111111-1111-1111-1111-111111111111", email: "vendor-1@example.test" } },
    },
  };
}

const EXPECTED_SURFACE_DTS = `// generated by sdlc from spec/contract and tests/seed/manifest.yaml; do not edit
import type { Persona } from "./personas";

export interface Surface {
  signIn(persona: Persona): Promise<void>;
  signOut(): Promise<void>;
  opportunity: OpportunityPage;
  vendorDashboard: VendorDashboardPage;
}

export interface OpportunityPage {
  open(params?: Record<string, string>): Promise<void>;
  publish(input?: unknown): Promise<void>;
  closeEarly(input?: unknown): Promise<void>;
  status(): Promise<string>;
}

export interface VendorDashboardPage {
  open(params?: Record<string, string>): Promise<void>;
  opportunityCount(): Promise<string>;
}
`;

const EXPECTED_PERSONAS_TS = `// generated by sdlc from spec/contract and tests/seed/manifest.yaml; do not edit
export const persona = {
  "publicSectorAdmin": {
    "id": "public-sector-admin",
    "can": [
      "publish opportunity"
    ],
    "signIn": {
      "sandbox-idp": {
        "username": "admin-1"
      }
    }
  },
  "vendor": {
    "id": "vendor",
    "can": [],
    "signIn": null
  }
} as const;

export type Persona = typeof persona[keyof typeof persona];
`;

const EXPECTED_SEED_TS = `// generated by sdlc from spec/contract and tests/seed/manifest.yaml; do not edit
export const seed = {
  "users": {
    "vendorOne": {
      "id": "11111111-1111-1111-1111-111111111111",
      "email": "vendor-1@example.test"
    }
  }
} as const;

export type Seed = typeof seed;
`;

test("generateTypes: surface.d.ts matches the expected output exactly", () => {
  const files = generateTypes(sampleContract());
  assert.equal(files["tests/generated/surface.d.ts"], EXPECTED_SURFACE_DTS);
});

test("generateTypes: personas.ts matches the expected output exactly (domain is dropped)", () => {
  const files = generateTypes(sampleContract());
  assert.equal(files["tests/generated/personas.ts"], EXPECTED_PERSONAS_TS);
});

test("generateTypes: seed.ts matches the expected output exactly (description is dropped)", () => {
  const files = generateTypes(sampleContract());
  assert.equal(files["tests/generated/seed.ts"], EXPECTED_SEED_TS);
});

test("generateTypes: is byte-stable across two calls with the same input", () => {
  const contract = sampleContract();
  const a = generateTypes(contract);
  const b = generateTypes(contract);
  assert.deepEqual(a, b);
});

test("generateTypes: kebab-case page ids become camelCase properties and PascalCase page types", () => {
  const contract = {
    surface: {
      pages: [
        {
          id: "opportunity-cwu-view",
          route: "/opportunities/:id/cwu",
          actions: { filter_by_program: { test_id: null } },
          observations: {},
        },
      ],
    },
    personas: { personas: [] },
    observables: {},
    manifest: {},
  };
  const dts = generateTypes(contract)["tests/generated/surface.d.ts"];
  assert.match(dts, /opportunityCwuView: OpportunityCwuViewPage;/);
  assert.match(dts, /export interface OpportunityCwuViewPage \{/);
  assert.match(dts, /filterByProgram\(input\?: unknown\): Promise<void>;/);
});

test("generateTypes: a persona's sign_in unavailable reason passes through personas.ts unchanged", () => {
  const contract = {
    surface: { pages: [] },
    personas: {
      personas: [
        {
          id: "second-staff-reviewer",
          can: ["countersign an award"],
          sign_in: { "sandbox-idp": { unavailable: "the old application seeds only one staff account" } },
        },
      ],
    },
    observables: {},
    manifest: {},
  };
  const ts = generateTypes(contract)["tests/generated/personas.ts"];
  assert.match(ts, /"unavailable": "the old application seeds only one staff account"/);
  assert.match(ts, /"sandbox-idp": \{/);
});

// ---- writeGenerated ----

test("writeGenerated: writes tests/generated/* into the project and reports the paths written", () => {
  const dir = project();
  write(
    dir,
    "spec/contract/surface.yaml",
    `pages:\n  - id: opportunity\n    route: /opportunities/:id\n    actions: { publish: {} }\n    observations: { status: {} }\n`,
  );
  write(
    dir,
    "spec/contract/personas.yaml",
    `personas:\n  - id: public-sector-admin\n    can: [publish opportunity]\n    sign_in: { session-route: { role: admin } }\n`,
  );
  write(dir, "tests/seed/manifest.yaml", `description: seed handles\nusers: {}\n`);

  const written = writeGenerated(dir);
  assert.deepEqual(new Set(written), new Set([
    "tests/generated/surface.d.ts",
    "tests/generated/personas.ts",
    "tests/generated/seed.ts",
  ]));
  assert.ok(existsSync(join(dir, "tests/generated/surface.d.ts")));
  const dts = readFileSync(join(dir, "tests/generated/surface.d.ts"), "utf8");
  assert.match(dts, /export interface OpportunityPage/);
});

test("writeGenerated: a second run with no changes writes nothing", () => {
  const dir = project();
  write(
    dir,
    "spec/contract/surface.yaml",
    `pages:\n  - id: opportunity\n    route: /opportunities/:id\n`,
  );
  writeGenerated(dir);
  const written = writeGenerated(dir);
  assert.deepEqual(written, []);
});

test("writeGenerated: changing one input file rewrites only the generated file it affects", () => {
  const dir = project();
  write(
    dir,
    "spec/contract/surface.yaml",
    `pages:\n  - id: opportunity\n    route: /opportunities/:id\n`,
  );
  writeGenerated(dir);
  write(
    dir,
    "spec/contract/personas.yaml",
    `personas:\n  - id: vendor\n    can: []\n`,
  );
  const written = writeGenerated(dir);
  assert.deepEqual(written, ["tests/generated/personas.ts"]);
});

test("writeGenerated: throws with the errors listed when the contract is invalid", () => {
  const dir = project();
  write(dir, "spec/contract/surface.yaml", `pages:\n  - route: /opportunities\n`);
  assert.throws(() => writeGenerated(dir), /page\[0\] is missing "id"/);
});

// ---- generateTypes: how a contract name becomes a TypeScript member ----

test("generateTypes: a name already in camel case keeps its capitals; a multi-word one is joined", () => {
  const contract = {
    surface: {
      pages: [{
        id: "applications-new",
        route: "/applications",
        title: "New application",
        actions: { submit_proposal: { test_id: null }, viewStatus: { test_id: null } },
        observations: { amountDue: { test_id: null } },
      }],
    },
    personas: { personas: [] },
    observables: {},
    manifest: {},
  };
  const files = generateTypes(contract);
  const surface = files["tests/generated/surface.d.ts"];
  assert.match(surface, /applicationsNew: ApplicationsNewPage;/);
  assert.match(surface, /submitProposal\(input\?: unknown\): Promise<void>;/);
  // `viewStatus` would have come out as `viewstatus` if the whole first segment were
  // lowercased, and no adapter member would ever have matched it.
  assert.match(surface, /viewStatus\(input\?: unknown\): Promise<void>;/);
  assert.match(surface, /amountDue\(\): Promise<string>;/);
});
