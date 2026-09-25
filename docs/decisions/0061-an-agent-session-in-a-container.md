# 0061 · An agent session in a container

Status: accepted · 2026-09-25

## Context

`0060` records what a Codex session on the host cannot be held to. It has a full shell and no tool
allowlist; its sandbox limits what it writes, not what it reads or runs; it reads no deny list. So a
blind stage could read the application or the acceptance suite by absolute path, a stage with a
narrowed shell could run anything with the network its commands need, and nothing would record
either. The six stages that declare a Claude tool allowlist — `contract`, `bind-adapter`,
`derive-tests`, `design`, `plan`, `build` — are therefore refused on Codex unless a project accepts
the weaker stage.

This record restores those guarantees by construction rather than by instruction: the session runs
where there is nothing outside its workspace to read and no host but the ones its allowlist names to
reach.

## Decision

### 1 — Each isolated turn runs in a throwaway container

`runAgent` (`src/runner/executor.mjs`) runs a turn whose policy isolates it through
`runInContainer` (`src/runner/container.mjs`), and reads its output exactly as it reads a turn on the
host. Stage turns, repair turns, persona rulings and the one-turn sign-in check that precedes each go
the same way, so the check exercises the credential and the network the turn will use.

**The image** is the pipeline's own, `containers/agent/Dockerfile`: Node 24 (`node:24-bookworm-slim`,
pinned by digest), the system certificate store (the CLIs' TLS clients read it; without it every
request a Codex session makes fails), git (a ruling's read-only git commands) and one agent CLI at
the version `AGENT_CLIS` pins — `@openai/codex@0.157.0`, `@anthropic-ai/claude-code@2.1.282` —
passed as build arguments. The tag names the backend, the pinned version and a digest of the
Dockerfile (`agentic-sdlc-agent:codex-0.157.0-<digest>`), so a changed pin or a changed image
definition is a different image. It is built on first use, or ahead of it by
`sdlc isolation build`, and kept.

**The container** is started with:

| Setting | Why |
|---|---|
| `--rm`, a name and a session label | Removed when the turn ends, and findable by label if a run is killed before it can remove it (`sdlc isolation clean`). |
| `--user <uid>:<gid>` of the invoking account | What the session writes in the workspace belongs to the operator. The pipeline refuses to run an isolated turn as root. |
| `--cap-drop ALL`, `--security-opt no-new-privileges` | No capability, and no way to gain one. |
| `--read-only`, a `tmpfs` at `/tmp`, `HOME=/tmp` | Nothing outside the mounts persists; the CLI's scratch and a package cache live in memory and go with the container. |
| `--network <session network>` | The only network it is on (§2). |
| `-w /workspace` | The session's working root. |

It is never given `--privileged`, a device, the host's PID or IPC namespace, or an added capability.

**The mounts are these and no others:**

| In the container | From | Mode |
|---|---|---|
| `/workspace` | the stage's materialised workspace — for a stage whose workspace is the project, the project | read-write; read-only for a turn whose allowlist names no editing tool (a ruling, the sign-in check) |
| `/sdlc/home` | a private copy of the pipeline's CLI home: the sign-in, and for Codex the hook file | read-write |
| `/sdlc/home/hooks.json` | the hook the pipeline registers for Codex (`0060` §4) | read-only, so the session cannot unregister its guard |
| `/sdlc/session` | for Claude only, the stage's skill file and MCP configuration, which its arguments name by path | read-only |

No repository but the workspace, no host home, no Docker socket. Each source is relative to a private
staging directory (`0700`) the docker CLI runs in — the workspace is linked into it — so no local path
is on any command line, and the staging directory is removed when the turn ends. A stage's own
environment crosses into the container by name (`-e NAME`), so no value is on a command line either;
the variables through which a CLI would sign in with a key never cross.

**An extra directory is never bind-mounted.** A turn that names one (`--add-dir`) is refused: what a
stage needs is materialised into its workspace. No stage names one.

**The sign-in is a copy.** The pipeline's home is copied for the turn — the credential read through
the link to the operator's own, with its modification time — and the copy is mounted. When the turn
ends, the credential is kept in the pipeline's home if the session rewrote it and it is newer than the
one there: `0035`'s rule for a refresh, applied across the container boundary. A copy's timestamp can
be set only to the millisecond, so an untouched copy can read as a fraction newer than its source;
only a copy whose time moved while the session held it counts as a refresh. Nothing opens the
credential.

**Inside, Codex runs with full access to its container.** Codex's own sandbox runs each command under
bubblewrap, which cannot create a namespace in an unprivileged container; every command a session ran
failed with `bwrap: No permissions to create a new namespace`. So an isolated Codex turn passes
`--sandbox danger-full-access`, and what confines it is the container: its mounts, its network and
its account. The implement guard still runs as the session's `PreToolUse` hook.

### 2 — The network: an internal network and an egress proxy

Each isolated turn gets its own network, created with `--internal` (Docker gives it no route out) and
`com.docker.network.bridge.inhibit_ipv4=true`, which leaves the host with no address on it. Without
the second option the host has an address on the bridge, and a service listening on all of the host's
interfaces answered a connection from inside the container at that address.

The network's one way out is a forward proxy, `containers/egress-proxy/proxy.mjs`: Node's standard
library and one file, in its own image on the same pinned base. It is started on the session's
network under the alias `egress-proxy`, then connected to Docker's default network, which is its
route out. It allows an HTTPS tunnel (`CONNECT host:port`) or a plain HTTP request to a host its
allowlist names — a host exactly, or `*.domain` for subdomains only, on 443 and 80 unless the entry
names a port; an address only where it is named exactly — and answers everything else with 403. It
logs each decision as `allow|deny <method> <host>:<port>` and nothing a request carries. It runs
unprivileged, with every capability dropped and a read-only root filesystem, and is removed with the
network when the turn ends.

The agent container's environment points `HTTPS_PROXY` and `HTTP_PROXY` (in both cases) at it, with
`NO_PROXY` empty and `NODE_USE_ENV_PROXY=1`, so Node's own `fetch` in a session's commands goes the
same way; npm reads the same variables. A session that ignores them reaches nothing: the container
cannot resolve an outside name.

### 3 — Which hosts a turn may reach is policy

A turn may always reach its backend's own endpoints, `BACKENDS.<backend>.endpoints`: without them
there is no session.

| Backend | Endpoints |
|---|---|
| `codex` | `chatgpt.com` (the model), `ab.chatgpt.com` (feature flags), `auth.openai.com` (sign-in refresh) |
| `claude` | `api.anthropic.com` (the model), `console.anthropic.com`, `platform.claude.com` (sign-in refresh) |

To those it adds one named allowlist. Two are built in: `model`, which adds nothing, and `registry`,
which adds `registry.npmjs.org`. A project redefines either or adds its own under
`policy.agents.allowlists`, and names the list a stage or ruling uses with `egress:`. A stage declares
its own default — `build`, whose shell installs packages, uses `registry`; every other stage and every
ruling uses `model`. The schema holds each host to a host's shape; `checks` refuses an `egress` naming
a list nobody defines. Being under `policy`, a change to any of it is ruled at G-POL (`0043`).

### 4 — Which turns are isolated

`stageAgent` and `rulingAgent` (`src/runner/agents.mjs`) resolve isolation beside the backend, in the
same layers:

1. The default: `container` for a stage on `codex` that declares a tool allowlist and can be isolated —
   the stages `0060` refuses — and `none` for every other stage and every ruling.
2. `policy.agents.isolation`, for every turn.
3. The turn's entry: `policy.agents.stages.<stage>.isolation`; for a ruling,
   `policy.agents.rulings.<persona>` then `.<gate>`.
4. `SDLC_AGENT_ISOLATION=container`, for one run. It turns isolation on and never off: any other value
   is refused, since turning it off would run a turn with less than the policy requires.

An isolated stage is not refused on Codex. With isolation `none`, `0060`'s refusal stands unless the
stage sets `accept_weaker`, which is read only for a stage on the host.

A stage whose work needs something on the host that an isolated session is denied declares it as
`isolationBlocker(config)`. `contract` does where the project has an oracle: it proves the override it
wrote by bringing the application up through the host's Docker, and an isolated session has no
Docker socket. `bind-adapter` always does: it binds against the target running on the host through a
browser the image does not carry, and its network reaches no host service. Such a stage is not
isolated by default, so on Codex it keeps `0060`'s refusal, which then says why a container cannot lift
it; set to run in a container anyway, it is refused rather than run on the host.

An isolated turn on a machine where Docker does not answer is refused with a stage's pre-checks, or
before a ruling's turn, before anything is spent.

### 5 — Where a turn ran is recorded with what ran it

A turn's `engine` carries, for an isolated turn, `isolation: "container"`, the short id of the image
that ran it and the name of its egress allowlist; its `version` is the CLI in the image. Every record
`0060` §6 lists carries it: the run-record line and the **Worked by** and **Ruled on** lines read
`… (codex-cli 0.157.0), in container <image> with egress <list>`; the journal, the proposal page and
an agent ruling's gate file carry `isolation: "container <image>"` and `egress: "<list>"` in their
front matter, and a turn on the host carries `isolation: "none"`; the state site shows the seat as
"persona agent · codex *model* · container". `src/lib/engine.mjs` stays the one vocabulary.

### 6 — `doctor` and `sdlc isolation`

`sdlc doctor` says, per stage and per isolated ruling, the backend, whether the turn runs in a
container (and which layer decided) and the hosts it may reach; whether Docker answers; whether each
image an isolated turn needs is built; and whether a run left session containers behind. `sdlc
isolation build` builds the images ahead of the first turn that would build them; `sdlc isolation
clean` removes leftover session containers and networks.

## What it restores, against 0060's table

| Guarantee | On codex on the host (`0060`) | On codex in a container |
|---|---|---|
| **A blind stage reads only its workspace** | Not held: a session could open any path the account can read. | Held. The workspace is the only project material in the container; a path outside it does not exist there. |
| **A narrowed shell runs only its commands** | Not held: any command, with network. | Not restored as a list of commands: the session still has a full shell. What those commands can reach is restored: the workspace, the allowlisted hosts and nothing else. A push or deploy reaches no remote not on the list; no credential of the machine's is in reach but the CLI's own sign-in; there is no Docker socket. |
| **The project's deny list** | Not read. | Still not read. What it guards against outside the workspace — a remote, a secret elsewhere on the machine — is not in the container. Inside a workspace that is the project, the session can still run `git commit` or `git reset --hard` on the mounted repository, as `0060` records. |
| **The implement guard** | The hook. | The same hook, whose registration the session cannot rewrite. |
| **A ruling writes nothing** | Read-only sandbox. | An isolated ruling's workspace is mounted read-only. |
| **Sign-in, and never a key** | Operator's sign-in linked in. | A copy of it; key variables never cross; a refresh is kept. |
| **A turn cap** | Wall-clock ceiling. | The same ceiling; the container is removed when it is reached. |

## What remains

- **The model provider is reachable.** A session can send the provider anything it can read, which is
  its workspace; that is the session's job. The CLI's sign-in is readable inside the container,
  because the CLI reads it, and can be sent only to allowlisted hosts.
- **An allowlisted registry is reachable both ways.** A `build` session could try to publish to it; no
  registry credential is in the container.
- **The session can rewrite its copy of the sign-in.** A rewritten credential newer than the
  pipeline's is kept, since a refresh cannot be told from a replacement without reading it, which the
  pipeline never does. A credential the session invented fails the next sign-in check; it gains the
  session nothing it did not already hold.
- **The proxy trusts DNS for an allowlisted name.** A name on the list that resolves to an internal
  address would be reached.
- **A container is not a virtual machine.** It shares the host's kernel and relies on the Docker
  daemon. Kernel and daemon vulnerabilities, and timing and other side channels, are out of scope.
- **`bind-adapter`, and `contract` with an oracle, stay refused on Codex** unless accepted weaker,
  for the reasons in §4.
- **The build trusts the registry once.** The base image is pinned by digest and the CLI by version;
  the CLI's package is fetched from the npm registry when the image is built.

## What was established, and how

On a Linux machine with Docker 29.5.3, with `codex-cli 0.157.0` signed in with ChatGPT, one session
ran through `runAgent`, with `design`'s tool allowlist and the agent `stageAgent` resolved for a
project whose only setting was `backend: codex` — isolated by default, egress `model`. It completed
(`ok`, ten steps, a session id, token usage) and its engine named the backend, the CLI version from
the image, `container`, the image's short id and `model`. Asked to run commands and report their
output:

- `cat` of a file created outside the workspace for the purpose answered `No such file or directory`;
  `/home` held only the image's empty user directory; `/var/run/docker.sock` did not exist; `id` was
  the invoking account's uid and gid. `docker inspect` of the running container showed exactly the
  three mounts above (workspace read-write, home read-write, hook read-only), user `uid:gid`, every
  capability dropped, `no-new-privileges`, a read-only root filesystem, and one network, internal,
  with `inhibit_ipv4`, holding the agent and the proxy.
- `fetch("https://github.com")` failed; the proxy logged `deny CONNECT github.com:443`. The same
  request with the proxy variables ignored failed to resolve (`EAI_AGAIN`). Every model request went
  through the proxy as `allow CONNECT chatgpt.com:443`, with `ab.chatgpt.com` beside it; a request the
  CLI made to a content host not on the list was denied, and the session went on without it.
- It wrote a file in the workspace, which was there afterwards; the containers, the network and the
  staging directory were gone.

A one-turn Claude session (`2.1.282`) ran isolated the same way and reached only `api.anthropic.com`;
a telemetry host it tried was denied without effect.

Established while building it: that `codex exec` honours `HTTPS_PROXY`; that without the certificate
store every Codex request failed; that bubblewrap cannot run inside the container; that the host
answered on an internal network's gateway address until `inhibit_ipv4` was set; and that relative
bind-mount sources, including through a link, resolve against the docker CLI's working directory.

Not established: a sign-in refresh inside a container (the refresh hosts are on the list; no session
needed one); a whole stage's run isolated, including `build` installing packages through the proxy
(npm reads the proxy variables by its own documentation).

## Consequences

- A project runs `derive-tests`, `design`, `plan`, `build`, and `contract` where it has no oracle, on
  Codex with `backend: codex` and nothing else, provided Docker is available; `doctor` says so, stage
  by stage.
- Claude turns may be isolated the same way, by setting `isolation: container`.
- Every record of a turn says where it ran, and a host turn says `none`.
- Running isolated needs Docker and costs a container start per turn, including the sign-in check.

## What was considered instead

**Mounting the workspace at its host path.** It would keep absolute paths in prompts meaningful, but
it puts a local path on the command line and inside the container, and nothing in a stage's prompt
depends on one.

**Codex's own sandbox inside the container.** It needs user namespaces, which means `--privileged` or
a relaxed seccomp profile, each a weaker container than the one it would sandbox inside.

**An iptables or nftables egress filter.** It needs root or `NET_ADMIN` on the host and a new host
dependency; a proxy on an internal network needs Docker alone.

**A distribution's squid or tinyproxy image.** A configuration surface of its own, and a third-party
image; a hundred-line proxy is read in full, tested in-process, and shares the agent image's base.

**Giving `contract` the Docker socket.** The socket is root on the host, which would undo everything
else here.

**One network for every session.** Sessions running at once could reach each other's proxies, and
their allowlists differ; a network per turn costs a second.
