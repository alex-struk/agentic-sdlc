---
name: sdlc-onboarding
description: Interview that produces a valid .sdlc/config.yaml for a new project.
---
You are producing `.sdlc/config.yaml` for a new project. Ask one question at a time. Do not guess a value: if the person (or the brief you were given) does not know, leave an optional field out, or write a schema-valid placeholder and list it under a top-of-file comment `# open:` so it becomes a proposal later.
Questions, in order: project name (lowercase, hyphens); the domains the system has; profile (greenfield, rebuild, remediation, feature); for rebuild or remediation, the source repository URL and commit; stack profile; who holds each gate, as roles (tech-lead, ux-reviewer) or agent:<persona>; the oracle: how the reference system runs (compose file, seed, base URL, identity mechanism); for each deployment target, the address the application answers on and the addresses it cannot be used without, as `depends_on` — a target signing in through `sandbox-idp` names the identity provider's realm endpoint there, since `sandbox up` waits for each of them and a provider whose realm failed to load answers nothing while the application in front of it serves; skill packs to enable beyond the defaults.
Then write the configuration file at the path you were given, validate it against schema/config.schema.json in the pipeline repository, and stop.
