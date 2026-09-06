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
- **Per-PR and per-merge sandbox deploy** through central, versioned
  workflows: `.github/workflows/pr-open.yml`, `pr-close.yml`, `merge.yml` and
  `scheduled.yml` call `bcgov/quickstart-openshift-helpers`'s reusable
  workflows (e.g.
  `bcgov/quickstart-openshift-helpers/.github/workflows/.pr-validate.yml@a11ad3d1b9288fb40757c4314a62eb86ff227931
  # v1.2.1`) and the `bcgov/action-deployer-openshift`,
  `bcgov/action-builder-ghcr`, `bcgov/action-test-and-analyse` and
  `bcgov/action-oc-runner` actions, each pinned to a commit with a version
  comment.

## What this profile adds

- The standards skill: `stacks/openshift-ts/SKILL.md`, which the build stage
  loads.
- A sandbox identity provider: a Keycloak realm dedicated to tests, added to
  `app/compose/`. It is not part of the upstream scaffold's compose file.
- A mail catcher for local and sandbox outbound mail, also added to
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
