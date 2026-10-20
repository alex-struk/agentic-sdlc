#!/usr/bin/env bash
# The setup for deploying to Azure Container Apps, run by `sdlc run deploy --platform
# azure-container-apps --setup` on the operator's machine after the preflight. It asks whether to
# create the Azure resources or use existing ones, what they are called and where, then creates
# them or checks they exist. Each environment's deploys get an identity of their own, which only
# that environment's GitHub environment can sign in as and which can change only that
# environment's resource group; the repository gets those environments. An SRE agent, when one
# is named, is given read access to the environments' groups and set to watch them. The choices
# go to $SDLC_SETTINGS_FILE, with SETUP=complete once nothing a deploy needs is owed.
#
# Every question can be answered ahead of time by setting the variable it names, so a run with no
# terminal asks nothing. The settings are names, ids and a region; no credential is read, written
# or printed. Sign-in from GitHub is OpenID Connect against a managed identity, so there is no
# secret to store anywhere.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

: "${SDLC_SETTINGS_FILE:?the deploy stage sets SDLC_SETTINGS_FILE}"
PROJECT_DIR="${SDLC_PROJECT_DIR:-$PWD}"
PROVIDERS=(Microsoft.App Microsoft.OperationalInsights Microsoft.Insights Microsoft.ContainerRegistry Microsoft.ManagedIdentity)
READER_ROLES=("Reader" "Monitoring Reader" "Log Analytics Reader")
# The branches each GitHub environment admits deploys from: development deploys on a push to
# main and on a push to the branch a deploy's trial is pushed to; production only from main.
declare -A ENV_BRANCHES=([development]="main development" [production]="main")
OWED=()
GITHUB_OWED=()
REQUIRED_MISSING=0

# ---- saved settings ----------------------------------------------------------------------------

if [ -f "$SDLC_SETTINGS_FILE" ]; then
  if grep -qvE '^([A-Z_][A-Z0-9_]*=[A-Za-z0-9/._:,@-]*)?$' "$SDLC_SETTINGS_FILE"; then
    warn "the saved settings hold a line that is not NAME=value; they are ignored"
  elif confirm "Use the settings saved by the last bootstrap ($(grep -E '^(RESOURCE_GROUP|REGISTRY|LOCATION)=' "$SDLC_SETTINGS_FILE" | paste -sd' ' -))?" y; then
    set -a; . "$SDLC_SETTINGS_FILE"; set +a
  fi
fi

# ---- subscription ------------------------------------------------------------------------------

ask AZURE_SUBSCRIPTION_ID "Azure subscription id to deploy into" "$(az account show --query id -o tsv)"
az account set --subscription "$AZURE_SUBSCRIPTION_ID" || fail "cannot select subscription $AZURE_SUBSCRIPTION_ID"
AZURE_TENANT_ID="$(az account show --query tenantId -o tsv)"
SUB_SCOPE="/subscriptions/$AZURE_SUBSCRIPTION_ID"

# ---- create or reuse ---------------------------------------------------------------------------

choose DEPLOY_MODE "Create new Azure resources, or use existing ones?" create create existing
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
  ask SHARED_RESOURCE_GROUP "Resource group for what the environments share (registry, identities)" "rg-$NAME_PREFIX-shared"
  ask RESOURCE_GROUP "Resource group for the development environment, which a deploy's trial also uses" "rg-$NAME_PREFIX-development"
  ask_optional RESOURCE_GROUP_PRODUCTION "Resource group for the production environment ('-' for none)" "rg-$NAME_PREFIX-production"
  ask REGISTRY_NAME "Container registry name (5-50 letters and digits, unique across Azure)" "$(tr -d '-' <<< "$NAME_PREFIX")acr"
  ask_region
else
  ask RESOURCE_GROUP "Name or id of the development environment's resource group, which a deploy's trial also uses"
  RESOURCE_GROUP="$(name_of "$RESOURCE_GROUP")"
  ask_optional RESOURCE_GROUP_PRODUCTION "Name or id of the production environment's resource group"
  RESOURCE_GROUP_PRODUCTION="$(name_of "${RESOURCE_GROUP_PRODUCTION:-}")"
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
if [ -n "${RESOURCE_GROUP_PRODUCTION:-}" ]; then
  ask_optional PRODUCTION_REVIEWERS "GitHub users who must approve a production deploy, comma-separated" ""
fi
ask IMAGE_NAME "Image name in the registry" "$(slug "$(basename "$PROJECT_DIR")" 40)"
IMAGE_NAME="$(slug "$IMAGE_NAME" 40)"

for v in AZURE_SUBSCRIPTION_ID LOCATION RESOURCE_GROUP REGISTRY_NAME NAME_PREFIX IMAGE_NAME GITHUB_REPO; do
  declare -n _v="$v"; safe_value "$_v" || fail "$v=\"$_v\" has characters a resource name or id does not"; unset -n _v
done
[[ "$REGISTRY_NAME" =~ ^[a-zA-Z0-9]{5,50}$ ]] || fail "registry name $REGISTRY_NAME must be 5-50 letters and digits"
[[ "$GITHUB_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || fail "GITHUB_REPO=$GITHUB_REPO is not owner/name"
envs=(development)
[ -n "${RESOURCE_GROUP_PRODUCTION:-}" ] && envs+=(production)

# ---- groups that stay apart --------------------------------------------------------------------

# Contributor on an environment's group reaches everything in it. So no environment's group may be
# another environment's, or hold the registry, the identities or the SRE agent; were it to, a
# development deploy could reach production through them. Asked here, before anything is created,
# and again once the registry's group is known.
group_of() { cut -d/ -f5 <<< "$1"; }
check_apart() {
  local shared="${SHARED_RESOURCE_GROUP:-}" prod="${RESOURCE_GROUP_PRODUCTION:-}" g what id
  [ -n "$shared" ] && [ "${RESOURCE_GROUP,,}" = "${shared,,}" ] \
    && fail "$RESOURCE_GROUP is both the development environment's group and the shared group, which holds the registry and the identities; an environment's deploys can change everything in their group, so give them groups apart"
  [ -n "$prod" ] && [ "${RESOURCE_GROUP,,}" = "${prod,,}" ] \
    && fail "$RESOURCE_GROUP is both the development environment's group and the production environment's; give them groups apart"
  [ -n "$prod" ] && [ -n "$shared" ] && [ "${prod,,}" = "${shared,,}" ] \
    && fail "$prod is both the production environment's group and the shared group; give them groups apart"
  for g in "$RESOURCE_GROUP" ${prod:+"$prod"}; do
    for what in "SRE agent=${SRE_AGENT_ID:-}" "registry=${REGISTRY_ID:-}" "pull identity=${PULL_IDENTITY_ID:-}"; do
      id="${what#*=}"
      [ -n "$id" ] || continue
      [ "$(group_of "$id" | tr '[:upper:]' '[:lower:]')" = "${g,,}" ] \
        && fail "the ${what%%=*} is in $g, an environment's own group; an environment's deploys can change everything in their group, so it belongs in another"
    done
  done
  return 0
}
check_apart

if [ "$DEPLOY_MODE" = create ]; then
  say ""
  say "About to create, in $LOCATION, whatever of these does not exist yet:"
  say "  resource groups $SHARED_RESOURCE_GROUP, $RESOURCE_GROUP (development)${RESOURCE_GROUP_PRODUCTION:+, $RESOURCE_GROUP_PRODUCTION (production)}"
  say "  container registry $REGISTRY_NAME (Basic, admin user off) in $SHARED_RESOURCE_GROUP"
  [ -z "$PULL_IDENTITY_ID" ] && say "  managed identity id-$NAME_PREFIX-pull, allowed to pull images"
  for env in "${envs[@]}"; do say "  managed identity id-$NAME_PREFIX-github-$env, which $GITHUB_REPO's $env environment signs in as"; done
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

# ---- resource groups and registry --------------------------------------------------------------

if [ "$DEPLOY_MODE" = create ]; then ensure_group "$SHARED_RESOURCE_GROUP"; fi
ensure_group "$RESOURCE_GROUP"
[ -n "${RESOURCE_GROUP_PRODUCTION:-}" ] && ensure_group "$RESOURCE_GROUP_PRODUCTION"

if ! REGISTRY_ID="$(az acr show --name "$REGISTRY_NAME" --query id -o tsv 2>/dev/null)"; then
  [ "$DEPLOY_MODE" = create ] || fail "container registry $REGISTRY_NAME does not exist, or this account cannot read it"
  [ "$(az acr check-name --name "$REGISTRY_NAME" --query nameAvailable -o tsv)" = true ] \
    || fail "the registry name $REGISTRY_NAME is taken; choose another (REGISTRY_NAME)"
  REGISTRY_ID="$(az acr create --resource-group "$SHARED_RESOURCE_GROUP" --name "$REGISTRY_NAME" --sku Basic \
    --admin-enabled false --location "$LOCATION" --query id -o tsv)" || fail "could not create registry $REGISTRY_NAME"
  ok "created container registry $REGISTRY_NAME"
else
  ok "container registry $REGISTRY_NAME exists"
fi
REGISTRY_SERVER="$(az acr show --name "$REGISTRY_NAME" --query loginServer -o tsv)"
REGISTRY="$REGISTRY_SERVER/$IMAGE_NAME"
SHARED_RESOURCE_GROUP="${SHARED_RESOURCE_GROUP:-$(group_of "$REGISTRY_ID")}"
check_apart

# ---- the identity the application pulls its image as ------------------------------------------

if [ -z "${PULL_IDENTITY_ID:-}" ]; then
  PULL_IDENTITY_ID="$(ensure_identity "$SHARED_RESOURCE_GROUP" "id-$NAME_PREFIX-pull")"
fi
pull_principal="$(az identity show --ids "$PULL_IDENTITY_ID" --query principalId -o tsv)" \
  || fail "identity $PULL_IDENTITY_ID does not exist, or this account cannot read it"
assign "$pull_principal" AcrPull "$REGISTRY_ID" required
ok "the application pulls its image as $(name_of "$PULL_IDENTITY_ID")"

# ---- the SRE agent -----------------------------------------------------------------------------

# Read access for the agent's identity on each environment's group, and each group among the
# agent's managed resources, which is what sets the agent to watch it. Done here, once, by the
# person setting up, so that no identity GitHub deploys as needs any right on the agent: a deploy,
# a trial among them, cannot change what the agent does. Attaching reads the agent, adds the
# group to `knowledgeGraphConfiguration.managedResources` (the union with what is there), and
# patches it back with `knowledgeGraphConfiguration.identity` included, which the API requires;
# the change is asynchronous, so `provisioningState` is polled until it leaves `InProgress`.
env_groups=("$RESOURCE_GROUP")
[ -n "${RESOURCE_GROUP_PRODUCTION:-}" ] && env_groups+=("$RESOURCE_GROUP_PRODUCTION")
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
  for rg in "${env_groups[@]}"; do
    for role in "${READER_ROLES[@]}"; do assign "$agent_principal" "$role" "$SUB_SCOPE/resourceGroups/$rg" optional; done
    attach_to_agent "$rg"
  done
  ok "the SRE agent can read ${env_groups[*]}"
fi

# ---- GitHub: an identity for each environment, the environment, and its variables --------------

{ command -v gh > /dev/null 2>&1 && gh auth status > /dev/null 2>&1; } \
  || fail "the GitHub CLI is missing or not signed in; every deploy runs on GitHub, so sign in with gh auth login and run the setup again"
declare -A env_rg=([development]="$RESOURCE_GROUP" [production]="${RESOURCE_GROUP_PRODUCTION:-}")
declare -A client_of=()
for env in "${envs[@]}"; do
  gh_id="$(ensure_identity "$SHARED_RESOURCE_GROUP" "id-$NAME_PREFIX-github-$env")"
  gh_name="$(name_of "$gh_id")"
  client_of[$env]="$(az identity show --ids "$gh_id" --query clientId -o tsv)"
  gh_principal="$(az identity show --ids "$gh_id" --query principalId -o tsv)"
  if ! az identity federated-credential show --resource-group "$SHARED_RESOURCE_GROUP" --identity-name "$gh_name" \
         --name "github-$env" --output none 2>/dev/null; then
    az identity federated-credential create --resource-group "$SHARED_RESOURCE_GROUP" --identity-name "$gh_name" \
      --name "github-$env" --issuer https://token.actions.githubusercontent.com \
      --subject "repo:$GITHUB_REPO:environment:$env" --audiences api://AzureADTokenExchange --output none \
      || fail "could not let $GITHUB_REPO's $env environment sign in as $gh_name"
  fi
  assign "$gh_principal" Contributor "$SUB_SCOPE/resourceGroups/${env_rg[$env]}" required
  assign "$gh_principal" AcrPush "$REGISTRY_ID" required
  assign "$gh_principal" "Managed Identity Operator" "$PULL_IDENTITY_ID" required
  ok "$GITHUB_REPO's $env environment signs in to Azure as $gh_name, which can change only ${env_rg[$env]}"

  # The environment, admitting deploys only from its own branches, with production's reviewers.
  policy='"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}'
  reviewers=""
  if [ "$env" = production ] && [ -n "${PRODUCTION_REVIEWERS:-}" ]; then
    IFS=, read -r -a logins <<< "$PRODUCTION_REVIEWERS"
    for login in "${logins[@]}"; do
      id="$(gh api "users/$login" --jq .id 2>/dev/null)" || { warn "no GitHub user $login"; continue; }
      reviewers="$reviewers${reviewers:+,}{\"type\":\"User\",\"id\":$id}"
    done
  fi
  body="{$policy${reviewers:+,\"reviewers\":[$reviewers]}}"
  if ! gh api --method PUT "repos/$GITHUB_REPO/environments/$env" --input - <<< "$body" > /dev/null; then
    GITHUB_OWED+=("create the $env environment, admitting deploys from ${ENV_BRANCHES[$env]// / and } only, with the variables AZURE_CLIENT_ID=${client_of[$env]} AZURE_TENANT_ID=$AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID=$AZURE_SUBSCRIPTION_ID RESOURCE_GROUP=${env_rg[$env]} LOCATION=$LOCATION REGISTRY=$REGISTRY PULL_IDENTITY_ID=$PULL_IDENTITY_ID")
    continue
  fi
  # The environment admits deploys from its own branches and from no other: one it admits that is
  # not among them is taken away, so what this setup says it admits is what it admits.
  have="$(gh api "repos/$GITHUB_REPO/environments/$env/deployment-branch-policies" --jq '.branch_policies[] | "\(.id) \(.name)"' 2>/dev/null || true)"
  while read -r policy branch; do
    [ -n "${policy:-}" ] || continue
    [[ " ${ENV_BRANCHES[$env]} " == *" $branch "* ]] && continue
    if gh api --method DELETE "repos/$GITHUB_REPO/environments/$env/deployment-branch-policies/$policy" > /dev/null; then
      ok "$GITHUB_REPO's $env environment admits no deploys from $branch"
    else
      GITHUB_OWED+=("stop $branch deploying to the $env environment")
    fi
  done <<< "$have"
  for branch in ${ENV_BRANCHES[$env]}; do
    awk '{print $2}' <<< "$have" | grep -qx "$branch" && continue
    gh api --method POST "repos/$GITHUB_REPO/environments/$env/deployment-branch-policies" -f name="$branch" -f type=branch > /dev/null \
      || GITHUB_OWED+=("let $branch deploy to the $env environment")
  done
  for pair in "AZURE_CLIENT_ID=${client_of[$env]}" "AZURE_TENANT_ID=$AZURE_TENANT_ID" "AZURE_SUBSCRIPTION_ID=$AZURE_SUBSCRIPTION_ID" \
              "RESOURCE_GROUP=${env_rg[$env]}" "LOCATION=$LOCATION" "REGISTRY=$REGISTRY" "PULL_IDENTITY_ID=$PULL_IDENTITY_ID"; do
    gh variable set "${pair%%=*}" --env "$env" --repo "$GITHUB_REPO" --body "${pair#*=}" > /dev/null \
      || GITHUB_OWED+=("set ${pair%%=*} in the $env environment")
  done
  ok "$GITHUB_REPO's $env environment admits deploys from ${ENV_BRANCHES[$env]// / and } only, and has its deploy variables"
done
AZURE_CLIENT_ID_DEVELOPMENT="${client_of[development]:-}"
AZURE_CLIENT_ID_PRODUCTION="${client_of[production]:-}"

# ---- settings ----------------------------------------------------------------------------------

# Complete only when nothing a deploy needs is owed: a deploy run refuses to start until it is.
SETUP=complete
{ [ "$REQUIRED_MISSING" = 0 ] && [ "${#GITHUB_OWED[@]}" = 0 ]; } || SETUP=incomplete
mkdir -p "$(dirname "$SDLC_SETTINGS_FILE")"
umask 077
{
  for v in DEPLOY_MODE NAME_PREFIX AZURE_SUBSCRIPTION_ID AZURE_TENANT_ID LOCATION RESOURCE_GROUP \
           RESOURCE_GROUP_PRODUCTION SHARED_RESOURCE_GROUP REGISTRY_NAME IMAGE_NAME REGISTRY PULL_IDENTITY_ID \
           SRE_AGENT_ID GITHUB_REPO PRODUCTION_REVIEWERS AZURE_CLIENT_ID_DEVELOPMENT AZURE_CLIENT_ID_PRODUCTION SETUP; do
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
[ "$SETUP" = complete ] || fail "the setup is not complete; once what is listed above is done, run it again (nothing that exists is created twice)"
