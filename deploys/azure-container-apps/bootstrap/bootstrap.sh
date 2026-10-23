#!/usr/bin/env bash
# Provisioning for Azure Container Apps, run on the machine of the person running the deploy stage,
# signed in to Azure as themselves, after the preflight: within a deploy run once the session's
# files pass their checks, or alone with `--setup`. Everything goes in one resource group, the
# development environment's: the container registry, the identity the application pulls its images
# as, the identity GitHub deploys as, and whatever the project's definition,
# deploy/<platform>/main.bicep with its main.bicepparam, names. The definition is shown as a
# what-if and then deployed into the group. GitHub's identity is then given the right to change
# the container apps the definition stood up and to push images, and nothing else: a deploy
# creates nothing (`docs/decisions/0117`). An SRE agent, when one is named, is given read access to
# the group and set to watch it. The repository gets its development environment. The choices go
# to $SDLC_SETTINGS_FILE, with SETUP=complete once nothing a deploy needs is owed.
#
# Every question can be answered ahead of time by setting the variable it names, so a run with no
# terminal asks nothing. The settings are names, ids and a region. A secret the definition reads
# from the environment is asked for without being shown, or taken from the environment, and is
# never written or printed. Sign-in from GitHub is OpenID Connect against a managed identity, so
# there is no credential to store anywhere.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

: "${SDLC_SETTINGS_FILE:?the deploy stage sets SDLC_SETTINGS_FILE}"
PROJECT_DIR="${SDLC_PROJECT_DIR:-$PWD}"
PLATFORM="${SDLC_PLATFORM:-azure-container-apps}"
DEFINITION_DIR="$PROJECT_DIR/deploy/$PLATFORM"
TEMPLATE="$DEFINITION_DIR/main.bicep"
PARAMS="$DEFINITION_DIR/main.bicepparam"
PROVIDERS=(Microsoft.App Microsoft.OperationalInsights Microsoft.Insights Microsoft.ContainerRegistry Microsoft.ManagedIdentity)
READER_ROLES=("Reader" "Monitoring Reader" "Log Analytics Reader")
# What provisioning hands the definition through the environment; any other variable the
# parameters file reads with no default is a secret the person provides.
PROVIDED=(NAME_PREFIX LOCATION REGISTRY_SERVER PULL_IDENTITY_ID EXISTING_IMAGES)
# The one GitHub environment, and the branches it admits deploys from: a push to main, and a push
# to the branch a deploy's trial is pushed to.
ENV=development
ENV_BRANCHES="main development"
OWED=()
GITHUB_OWED=()
REQUIRED_MISSING=0

# ---- the definition ----------------------------------------------------------------------------

for f in "$TEMPLATE" "$PARAMS"; do
  [ -f "$f" ] || fail "deploy/$PLATFORM/$(basename "$f") is missing; a deploy run writes the definition, and provisioning deploys it"
done

# Each secret the definition reads, asked for or taken from the environment before anything is
# created, so a run that would stop for one stops having changed nothing.
mapfile -t SECRETS < <(grep -oE "readEnvironmentVariable\(\s*'[A-Za-z_][A-Za-z0-9_]*'\s*\)" "$PARAMS" | grep -oE "'[^']+'" | tr -d "'" | sort -u)
for name in "${SECRETS[@]}"; do
  [[ " ${PROVIDED[*]} " == *" $name "* ]] && continue
  [ -n "$(printenv "$name" || true)" ] && continue
  interactive || fail "$name is not set and there is no terminal to ask for it; the definition reads it, so set $name in the environment and run again"
  value=""
  while [ -z "$value" ]; do read -r -s -p "$name, which the definition reads (not shown, not saved): " value >&2 || value=""; say ""; done
  export "$name=$value"
  unset value
done

# ---- saved settings ----------------------------------------------------------------------------

if [ -f "$SDLC_SETTINGS_FILE" ]; then
  if grep -qvE '^([A-Z_][A-Z0-9_]*=[A-Za-z0-9/._:,@-]*)?$' "$SDLC_SETTINGS_FILE"; then
    warn "the saved settings hold a line that is not NAME=value; they are ignored"
  elif confirm "Use the settings saved by the last provisioning ($(grep -E '^(RESOURCE_GROUP|REGISTRY|LOCATION)=' "$SDLC_SETTINGS_FILE" | paste -sd' ' -))?" y; then
    set -a; . "$SDLC_SETTINGS_FILE"; set +a
  fi
fi

# ---- subscription ------------------------------------------------------------------------------

ask AZURE_SUBSCRIPTION_ID "Azure subscription id to deploy into" "$(az account show --query id -o tsv)"
az account set --subscription "$AZURE_SUBSCRIPTION_ID" || fail "cannot select subscription $AZURE_SUBSCRIPTION_ID"
AZURE_TENANT_ID="$(az account show --query tenantId -o tsv)"
SUB_SCOPE="/subscriptions/$AZURE_SUBSCRIPTION_ID"

# ---- create or reuse ---------------------------------------------------------------------------

choose DEPLOY_MODE "Create the resource group and registry, or use existing ones?" create create existing
default_prefix="$(slug "$(basename "$PROJECT_DIR")" 20)"
ask NAME_PREFIX "Short name the resources are named from" "${default_prefix:-app}"
NAME_PREFIX="$(slug "$NAME_PREFIX" 20)"

aca_regions="$(az provider show --namespace Microsoft.App \
  --query "resourceTypes[?resourceType=='managedEnvironments'].locations[]" -o tsv 2>/dev/null \
  | tr -d ' ' | tr '[:upper:]' '[:lower:]' | sort -u)"
region_ok() { [ -z "$aca_regions" ] || grep -qx "$1" <<< "$aca_regions"; }
ask_region() {
  local default="${1-}"
  [ -n "$aca_regions" ] && interactive && [ -z "${LOCATION:-}" ] && say "Regions with Container Apps: $(paste -sd' ' - <<< "$aca_regions")"
  while :; do
    ask LOCATION "Azure region to create them in" "$default"
    LOCATION="$(tr -d ' ' <<< "$LOCATION" | tr '[:upper:]' '[:lower:]')"
    region_ok "$LOCATION" && return 0
    interactive || fail "LOCATION=$LOCATION is not a region Container Apps runs in"
    say "$LOCATION is not a region Container Apps runs in"; LOCATION=""
  done
}

if [ "$DEPLOY_MODE" = create ]; then
  ask RESOURCE_GROUP "Resource group for the development environment, which holds everything the deploys use" "rg-$NAME_PREFIX-development"
  ask REGISTRY_NAME "Container registry name (5-50 letters and digits, unique across Azure)" "$(tr -d '-' <<< "$NAME_PREFIX")acr"
  ask_region
else
  ask RESOURCE_GROUP "Name or id of the development environment's resource group"
  RESOURCE_GROUP="$(name_of "$RESOURCE_GROUP")"
  ask REGISTRY_NAME "Name or id of the Azure container registry"
  REGISTRY_NAME="$(name_of "$REGISTRY_NAME")"
  group_location="$(az group show --name "$RESOURCE_GROUP" --query location -o tsv 2>/dev/null)" \
    || fail "resource group $RESOURCE_GROUP does not exist in this subscription, or this account cannot read it"
  ask_region "$group_location"
fi
ask_optional PULL_IDENTITY_ID "Resource id of an identity allowed to pull from the registry" ""
ask_optional SRE_AGENT_ID "Resource id of an Azure SRE Agent to connect" ""
origin="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)"
repo_default="$(sed -nE 's#^(https://github\.com/|git@github\.com:)([^/]+/[^/]+)$#\2#p' <<< "${origin%.git}")"
ask GITHUB_REPO "GitHub repository (owner/name) the deploys run from" "$repo_default"

for v in AZURE_SUBSCRIPTION_ID LOCATION RESOURCE_GROUP REGISTRY_NAME NAME_PREFIX GITHUB_REPO; do
  declare -n _v="$v"; safe_value "$_v" || fail "$v=\"$_v\" has characters a resource name or id does not"; unset -n _v
done
[[ "$REGISTRY_NAME" =~ ^[a-zA-Z0-9]{5,50}$ ]] || fail "registry name $REGISTRY_NAME must be 5-50 letters and digits"
[[ "$GITHUB_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || fail "GITHUB_REPO=$GITHUB_REPO is not owner/name"
RG_SCOPE="$SUB_SCOPE/resourceGroups/$RESOURCE_GROUP"

if [ "$DEPLOY_MODE" = create ]; then
  say ""
  say "About to create, in $LOCATION, whatever of these does not exist yet:"
  say "  resource group $RESOURCE_GROUP (development)"
  say "  container registry $REGISTRY_NAME (Basic, admin user off) in $RESOURCE_GROUP"
  [ -z "$PULL_IDENTITY_ID" ] && say "  managed identity id-$NAME_PREFIX-pull, allowed to pull images"
  say "  managed identity id-$NAME_PREFIX-github-$ENV, which $GITHUB_REPO's $ENV environment signs in as"
  say "  what deploy/$PLATFORM/main.bicep defines, in $RESOURCE_GROUP"
  confirm "Go ahead?" y || fail "nothing was created"
fi

# ---- helpers that change Azure -----------------------------------------------------------------

# assign PRINCIPAL ROLE SCOPE required|optional — idempotent. A new identity takes a little while
# to reach every directory replica, so a refusal naming the principal is retried.
assign() {
  local principal="$1" role="$2" scope="$3" need="$4" i errors
  if [ -n "$(az role assignment list --assignee "$principal" --role "$role" --scope "$scope" --query '[0].id' -o tsv 2>/dev/null)" ]; then
    return 0
  fi
  errors="$(mktemp)"
  for i in 1 2 3 4 5 6; do
    if az role assignment create --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
         --role "$role" --scope "$scope" --output none 2> "$errors"; then
      rm -f "$errors"; ok "$role on ${scope##*/} for ${principal:0:8}..."; return 0
    fi
    grep -q "PrincipalNotFound\|does not exist in the directory" "$errors" || break
    sleep 10
  done
  rm -f "$errors"
  OWED+=("az role assignment create --assignee-object-id $principal --assignee-principal-type ServicePrincipal --role \"$role\" --scope $scope")
  [ "$need" = required ] && REQUIRED_MISSING=1
  warn "could not assign $role on ${scope##*/}; someone who can assign roles needs to run the command printed at the end"
}

ensure_group() {
  local rg="$1"
  if az group show --name "$rg" --output none 2>/dev/null; then ok "resource group $rg exists"; return; fi
  [ "$DEPLOY_MODE" = create ] || fail "resource group $rg does not exist"
  az group create --name "$rg" --location "$LOCATION" --output none || fail "could not create resource group $rg"
  ok "created resource group $rg"
}

ensure_identity() {
  local rg="$1" name="$2"
  az identity show --resource-group "$rg" --name "$name" --query id -o tsv 2>/dev/null && return
  az identity create --resource-group "$rg" --name "$name" --location "$LOCATION" --query id -o tsv \
    || fail "could not create managed identity $name in $rg"
}

# ---- resource providers ------------------------------------------------------------------------

for ns in "${PROVIDERS[@]}"; do
  state="$(az provider show --namespace "$ns" --query registrationState -o tsv 2>/dev/null || echo Unknown)"
  if [ "$state" != Registered ]; then
    say "registering $ns (this can take a few minutes)"
    az provider register --namespace "$ns" --wait --output none \
      || fail "could not register $ns; someone with Contributor on the subscription runs: az provider register --namespace $ns"
  fi
done
ok "resource providers are registered"

# ---- resource group and registry ---------------------------------------------------------------

ensure_group "$RESOURCE_GROUP"

if ! REGISTRY_ID="$(az acr show --name "$REGISTRY_NAME" --query id -o tsv 2>/dev/null)"; then
  [ "$DEPLOY_MODE" = create ] || fail "container registry $REGISTRY_NAME does not exist, or this account cannot read it"
  [ "$(az acr check-name --name "$REGISTRY_NAME" --query nameAvailable -o tsv)" = true ] \
    || fail "the registry name $REGISTRY_NAME is taken; choose another (REGISTRY_NAME)"
  REGISTRY_ID="$(az acr create --resource-group "$RESOURCE_GROUP" --name "$REGISTRY_NAME" --sku Basic \
    --admin-enabled false --location "$LOCATION" --query id -o tsv)" || fail "could not create registry $REGISTRY_NAME"
  ok "created container registry $REGISTRY_NAME"
else
  ok "container registry $REGISTRY_NAME exists"
fi
REGISTRY="$(az acr show --name "$REGISTRY_NAME" --query loginServer -o tsv)"

# ---- the identity the application pulls its images as -----------------------------------------

if [ -z "${PULL_IDENTITY_ID:-}" ]; then
  PULL_IDENTITY_ID="$(ensure_identity "$RESOURCE_GROUP" "id-$NAME_PREFIX-pull")"
fi
pull_principal="$(az identity show --ids "$PULL_IDENTITY_ID" --query principalId -o tsv)" \
  || fail "identity $PULL_IDENTITY_ID does not exist, or this account cannot read it"
assign "$pull_principal" AcrPull "$REGISTRY_ID" required
ok "the application pulls its images as $(name_of "$PULL_IDENTITY_ID")"

# ---- the identity GitHub deploys as ------------------------------------------------------------

{ command -v gh > /dev/null 2>&1 && gh auth status > /dev/null 2>&1; } \
  || fail "the GitHub CLI is missing or not signed in; every deploy runs on GitHub, so sign in with gh auth login and run again"
gh_id="$(ensure_identity "$RESOURCE_GROUP" "id-$NAME_PREFIX-github-$ENV")"
gh_name="$(name_of "$gh_id")"
AZURE_CLIENT_ID="$(az identity show --ids "$gh_id" --query clientId -o tsv)"
gh_principal="$(az identity show --ids "$gh_id" --query principalId -o tsv)"
# GitHub's token names the repository by name, or by its owner's and its own ids where the
# repository's OIDC subject is set to carry them; a credential for each lets either sign in.
federate() {
  local name="$1" subject="$2"
  az identity federated-credential show --resource-group "$RESOURCE_GROUP" --identity-name "$gh_name" --name "$name" --output none 2>/dev/null && return 0
  az identity federated-credential create --resource-group "$RESOURCE_GROUP" --identity-name "$gh_name" \
    --name "$name" --issuer https://token.actions.githubusercontent.com \
    --subject "$subject" --audiences api://AzureADTokenExchange --output none \
    || fail "could not let $GITHUB_REPO's $ENV environment sign in as $gh_name"
}
federate "github-$ENV" "repo:$GITHUB_REPO:environment:$ENV"
read -r owner_id repo_id < <(gh api "repos/$GITHUB_REPO" --jq '.owner.id, .id' 2>/dev/null | paste -sd' ' -) || true
if [[ "${owner_id:-}" =~ ^[0-9]+$ && "${repo_id:-}" =~ ^[0-9]+$ ]]; then
  federate "github-$ENV-ids" "repo:${GITHUB_REPO%%/*}@$owner_id/${GITHUB_REPO#*/}@$repo_id:environment:$ENV"
else
  warn "could not read $GITHUB_REPO's ids; it signs in by name only"
fi

# ---- the definition, deployed ------------------------------------------------------------------

# What the definition is handed besides its secrets: the names, the registry, the identity the
# application pulls as, and the image each container app runs now, so provisioning again does not
# put back the placeholder a deploy replaced.
EXISTING_IMAGES="$(az containerapp list --resource-group "$RESOURCE_GROUP" --output json 2>/dev/null | node -e '
  let apps = [];
  try { apps = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]"); } catch {}
  const images = {};
  for (const a of apps) for (const c of a.properties?.template?.containers ?? []) if (c.image) images[`${a.name}/${c.name}`] = c.image;
  process.stdout.write(JSON.stringify(images));
' || echo '{}')"
REGISTRY_SERVER="$REGISTRY"
export NAME_PREFIX LOCATION REGISTRY_SERVER PULL_IDENTITY_ID EXISTING_IMAGES

say ""
say "What deploying deploy/$PLATFORM/main.bicep into $RESOURCE_GROUP would change:"
az deployment group what-if --resource-group "$RESOURCE_GROUP" --name "sdlc-$NAME_PREFIX" --parameters "$PARAMS" >&2 \
  || fail "the what-if of deploy/$PLATFORM/main.bicep did not pass; nothing it defines was deployed"
confirm "Deploy it?" y || fail "the definition was not deployed"
az deployment group create --resource-group "$RESOURCE_GROUP" --name "sdlc-$NAME_PREFIX" --parameters "$PARAMS" --output none \
  || fail "deploying deploy/$PLATFORM/main.bicep into $RESOURCE_GROUP did not pass"
ok "deployed what deploy/$PLATFORM/main.bicep defines into $RESOURCE_GROUP"

# ---- what GitHub's identity may do -------------------------------------------------------------

# Change the container apps the definition stood up, and push images; it creates nothing, so it
# is given no right to.
mapfile -t APPS < <(az containerapp list --resource-group "$RESOURCE_GROUP" --query "[].id" -o tsv)
[ "${#APPS[@]}" -gt 0 ] || fail "the definition stood up no container app in $RESOURCE_GROUP for a deploy to change"
for app in "${APPS[@]}"; do assign "$gh_principal" "Container Apps Contributor" "$app" required; done
assign "$gh_principal" AcrPush "$REGISTRY_ID" required
ok "$GITHUB_REPO's $ENV environment signs in to Azure as $gh_name, which can change ${#APPS[@]} container app(s) and push images, and nothing else"

# ---- the SRE agent -----------------------------------------------------------------------------

# Read access for the agent's identity on the group, and the group among the agent's managed
# resources, which is what sets the agent to watch it. Done here, by the person provisioning, so
# that the identity GitHub deploys as needs no right on the agent: a deploy, a trial among them,
# cannot change what the agent does. Attaching reads the agent, adds the group to
# `knowledgeGraphConfiguration.managedResources` (the union with what is there), and patches it
# back with `knowledgeGraphConfiguration.identity` included, which the API requires; the change is
# asynchronous, so `provisioningState` is polled until it leaves `InProgress`.
attach_to_agent() {
  local rg_id="$SUB_SCOPE/resourceGroups/$1" api="https://management.azure.com${SRE_AGENT_ID}?api-version=2026-01-01" agent body state="" rc=0
  agent="$(az rest --method get --url "$api")" || { warn "could not read the SRE agent to set it to watch $1"; return 0; }
  body="$(node -e '
    const rg = process.argv[1];
    const kg = JSON.parse(require("fs").readFileSync(0, "utf8")).properties?.knowledgeGraphConfiguration ?? {};
    const have = kg.managedResources ?? [];
    if (have.some((r) => r.toLowerCase() === rg.toLowerCase())) process.exit(3);
    process.stdout.write(JSON.stringify({ properties: { knowledgeGraphConfiguration: { identity: kg.identity, managedResources: [...have, rg] } } }));
  ' "$rg_id" <<< "$agent")" || rc=$?
  if [ "$rc" = 3 ]; then ok "the SRE agent already watches $1"; return 0; fi
  [ "$rc" = 0 ] || { warn "could not read the SRE agent's managed resources"; return 0; }
  az rest --method patch --url "$api" --body "$body" --output none || { warn "could not set the SRE agent to watch $1"; return 0; }
  for _ in $(seq 1 30); do
    state="$(az rest --method get --url "$api" --query properties.provisioningState -o tsv 2>/dev/null || true)"
    [ "$state" != InProgress ] && break
    sleep 10
  done
  if [ "$state" = Succeeded ]; then ok "the SRE agent watches $1"; else warn "setting the SRE agent to watch $1 ended $state"; fi
}
if [ -n "${SRE_AGENT_ID:-}" ]; then
  agent_identity="$(az resource show --ids "$SRE_AGENT_ID" --api-version 2026-01-01 \
    --query properties.knowledgeGraphConfiguration.identity -o tsv 2>/dev/null)" \
    || fail "SRE agent $SRE_AGENT_ID cannot be read by this account"
  agent_principal="$(az identity show --ids "$agent_identity" --query principalId -o tsv)" \
    || fail "the SRE agent's identity $agent_identity cannot be read by this account"
  for role in "${READER_ROLES[@]}"; do assign "$agent_principal" "$role" "$RG_SCOPE" optional; done
  attach_to_agent "$RESOURCE_GROUP"
  ok "the SRE agent can read $RESOURCE_GROUP"
fi

# ---- GitHub: the environment and its variables -------------------------------------------------

policy='{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
if gh api --method PUT "repos/$GITHUB_REPO/environments/$ENV" --input - <<< "$policy" > /dev/null; then
  # The environment admits deploys from its own branches and from no other: one it admits that is
  # not among them is taken away, so what provisioning says it admits is what it admits.
  have="$(gh api "repos/$GITHUB_REPO/environments/$ENV/deployment-branch-policies" --jq '.branch_policies[] | "\(.id) \(.name)"' 2>/dev/null || true)"
  while read -r id branch; do
    [ -n "${id:-}" ] || continue
    [[ " $ENV_BRANCHES " == *" $branch "* ]] && continue
    if gh api --method DELETE "repos/$GITHUB_REPO/environments/$ENV/deployment-branch-policies/$id" > /dev/null; then
      ok "$GITHUB_REPO's $ENV environment admits no deploys from $branch"
    else
      GITHUB_OWED+=("stop $branch deploying to the $ENV environment")
    fi
  done <<< "$have"
  for branch in $ENV_BRANCHES; do
    awk '{print $2}' <<< "$have" | grep -qx "$branch" && continue
    gh api --method POST "repos/$GITHUB_REPO/environments/$ENV/deployment-branch-policies" -f name="$branch" -f type=branch > /dev/null \
      || GITHUB_OWED+=("let $branch deploy to the $ENV environment")
  done
  for pair in "AZURE_CLIENT_ID=$AZURE_CLIENT_ID" "AZURE_TENANT_ID=$AZURE_TENANT_ID" "AZURE_SUBSCRIPTION_ID=$AZURE_SUBSCRIPTION_ID" \
              "RESOURCE_GROUP=$RESOURCE_GROUP" "REGISTRY=$REGISTRY"; do
    gh variable set "${pair%%=*}" --env "$ENV" --repo "$GITHUB_REPO" --body "${pair#*=}" > /dev/null \
      || GITHUB_OWED+=("set ${pair%%=*} in the $ENV environment")
  done
  ok "$GITHUB_REPO's $ENV environment admits deploys from ${ENV_BRANCHES// / and } only, and has its deploy variables"
else
  GITHUB_OWED+=("create the $ENV environment, admitting deploys from ${ENV_BRANCHES// / and } only, with the variables AZURE_CLIENT_ID=$AZURE_CLIENT_ID AZURE_TENANT_ID=$AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID=$AZURE_SUBSCRIPTION_ID RESOURCE_GROUP=$RESOURCE_GROUP REGISTRY=$REGISTRY")
fi

# ---- settings ----------------------------------------------------------------------------------

# Complete only when nothing a deploy needs is owed.
SETUP=complete
{ [ "$REQUIRED_MISSING" = 0 ] && [ "${#GITHUB_OWED[@]}" = 0 ]; } || SETUP=incomplete
mkdir -p "$(dirname "$SDLC_SETTINGS_FILE")"
umask 077
{
  for v in DEPLOY_MODE NAME_PREFIX AZURE_SUBSCRIPTION_ID AZURE_TENANT_ID LOCATION RESOURCE_GROUP \
           REGISTRY_NAME REGISTRY PULL_IDENTITY_ID SRE_AGENT_ID GITHUB_REPO AZURE_CLIENT_ID SETUP; do
    declare -n _v="$v"
    safe_value "${_v:-}" || fail "$v has characters a setting may not"
    printf '%s=%s\n' "$v" "${_v:-}"
    unset -n _v
  done
} > "$SDLC_SETTINGS_FILE.tmp"
mv "$SDLC_SETTINGS_FILE.tmp" "$SDLC_SETTINGS_FILE"

if [ "${#OWED[@]}" -gt 0 ]; then
  say ""
  say "Role assignments this account could not make. Someone who can assign roles runs:"
  for c in "${OWED[@]}"; do say "  $c"; done
fi
if [ "${#GITHUB_OWED[@]}" -gt 0 ]; then
  say ""
  say "Someone who administers $GITHUB_REPO does these in its settings:"
  for c in "${GITHUB_OWED[@]}"; do say "  - $c"; done
fi
[ "$SETUP" = complete ] || fail "provisioning is not complete; once what is listed above is done, run it again (nothing that exists is created twice)"
