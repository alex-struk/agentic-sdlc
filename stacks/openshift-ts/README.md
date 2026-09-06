# Stack profile: openshift-ts

A project selects this profile with `stack: openshift-ts` in `.sdlc/config.yaml`.

## Scaffold

- Source: `bcgov/quickstart-openshift`.
- Read at commit `af1e42ed78181f338942f29aa34c5174c0cfd635` (`git ls-remote
  https://github.com/bcgov/quickstart-openshift HEAD`), 2026-09-06.

## What the scaffold provides

Confirmed by cloning that commit:

- **Front end** (`frontend/`): React 19, Vite 8, TanStack Router
  (`@tanstack/react-router`), and the BC Design System's React components and
  font (`@bcgov/design-system-react-components`, `@bcgov/bc-sans`).
- **Back end** (`backend/`): NestJS 11 (`@nestjs/core`, `@nestjs/common`,
  `@nestjs/platform-express`) with Prisma 7 as the database client
  (`@prisma/client`, `@prisma/adapter-pg`) over Postgres (`pg`).
- **Database**: Postgres (`postgis/postgis` image) declared in
  `docker-compose.yml`.
- **Migrations**: a `migrations` service in `docker-compose.yml` that runs
  Flyway against hand-written SQL under `migrations/sql/`, alongside — not
  instead of — the Prisma client.
- **Tests**: Vitest for unit tests in both `frontend/` and `backend/`;
  Playwright (`@playwright/test`) for browser tests in `frontend/`.
- **Lint and format**: ESLint 10 and Prettier 3, configured in both packages.
  A separate `.github/workflows/analysis.yml` runs lint, coverage and
  SonarCloud analysis via `bcgov/action-test-and-analyse@8f699e3fd3fadd9a6adf6f4b1f2638ef7ecfefb9
  # v2.0.0`; it is not part of the deploy path below.
- **Per-PR and per-merge sandbox deploy**, confirmed per workflow file:
  - `pr-open.yml` calls `bcgov/action-builder-ghcr@cb2629351c87dd1c2130073e4ebb7233a9653a63
    # v4.4.1` directly, then the repo's own `reusable-deploy.yml` and
    `reusable-tests.yml` workflows.
  - `pr-close.yml` calls the reusable workflow
    `bcgov/quickstart-openshift-helpers/.github/workflows/.pr-close.yml@a11ad3d1b9288fb40757c4314a62eb86ff227931
    # v1.2.1`.
  - `merge.yml` calls `bcgov/action-get-pr@28b0adf8e4d40720d41f9c87356ce24b0a4bd6af
    # v0.3.1`, then the same `reusable-deploy.yml` and `reusable-tests.yml`
    workflows, followed by `bcgov/actions/sysdig-monitor@4ad61a784f1c17765b03d8d6de9737c1d3f4c0f2
    # v0.5.0` and `shrink/actions-docker-registry-tag@e6aaef25c595b6e0edd18bf4c7dbfea3abd43299
    # v5`.
  - `scheduled.yml` calls `bcgov/action-oc-runner@111868d1fc50db0a40417ba321d865ef5c931bbd
    # v1.7.0` and the reusable workflow
    `bcgov/quickstart-openshift-helpers/.github/workflows/.schema-spy.yml@a11ad3d1b9288fb40757c4314a62eb86ff227931
    # v1.2.1`.
  - The local `reusable-deploy.yml` workflow (called by both `pr-open.yml`
    and `merge.yml`) calls `bcgov/action-deployer-openshift@27a85b7b157bfc9c3c9bf0aca53bcd288d4d2506
    # v4.2.1`.

  All external actions and workflows above are pinned to a commit SHA with a
  version comment.

## What this profile adds

- The standards skill: `stacks/openshift-ts/SKILL.md`, which the build stage
  loads.
- A sandbox identity provider: a Keycloak realm dedicated to tests, added to
  `app/compose/`. It is not part of the upstream scaffold's compose file.
- Mailpit, a mail catcher for local and sandbox outbound mail, also added to
  `app/compose/`.

## What the plan stage must still decide

- Whether NestJS is confirmed as the back-end framework or replaced.
- Whether Prisma is kept as the client over the existing, retained database
  schema (via introspection) or replaced.
- Which migration tool the project uses going forward. The scaffold's own
  `migrations` service runs Flyway over hand-written SQL, separately from the
  Prisma client; plan must decide whether to keep Flyway, move to Prisma's own
  migration tooling, or something else, and record that as a ratified decision
  with a criterion behind it.
