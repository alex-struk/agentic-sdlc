#!/usr/bin/env bash
# Bootstrap for deploying to Azure Container Apps, run by the deploy stage on the operator's
# machine after the preflight and before the agent turn. It asks whether to create the Azure
# resources or use existing ones, what they are called and where, then creates them or checks
# they exist, signs Docker in to the registry, and writes its choices to $SDLC_SETTINGS_FILE.
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
OWED=()
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
  ask RESOURCE_GROUP "Resource group for the test environment" "rg-$NAME_PREFIX-test"
  ask RESOURCE_GROUP_DEVELOPMENT "Resource group for the development environment" "rg-$NAME_PREFIX-development"
  ask RESOURCE_GROUP_PRODUCTION "Resource group for the production environment" "rg-$NAME_PREFIX-production"
  ask REGISTRY_NAME "Container registry name (5-50 letters and digits, unique across Azure)" "$(tr -d '-' <<< "$NAME_PREFIX")acr"
  ask_region
else
  ask RESOURCE_GROUP "Name or id of the test environment's resource group"
  RESOURCE_GROUP="$(name_of "$RESOURCE_GROUP")"
  ask_optional RESOURCE_GROUP_DEVELOPMENT "Name or id of the development environment's resource group"
  ask_optional RESOURCE_GROUP_PRODUCTION "Name or id of the production environment's resource group"
  RESOURCE_GROUP_DEVELOPMENT="$(name_of "${RESOURCE_GROUP_DEVELOPMENT:-}")"
  RESOURCE_GROUP_PRODUCTION="$(name_of "${RESOURCE_GROUP_PRODUCTION:-}")"
  ask REGISTRY_NAME "Name or id of the Azure container registry"
  REGISTRY_NAME="$(name_of "$REGISTRY_NAME")"
  test_location="$(az group show --name "$RESOURCE_GROUP" --query location -o tsv 2>/dev/null)" \
    || fail "resource group $RESOURCE_GROUP does not exist in this subscription, or this account cannot read it"
  ask_region "$test_location"
fi
ask_optional PULL_IDENTITY_ID "Resource id of an identity allowed to pull from the registry" ""
ask_optional SRE_AGENT_ID "Resource id of an Azure SRE Agent to connect" ""
origin="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)"
repo_default="$(sed -nE 's#^(https://github\.com/|git@github\.com:)([^/]+/[^/]+)$#\2#p' <<< "${origin%.git}")"
ask_optional GITHUB_REPO "GitHub repository (owner/name) to set up deploys from" "$repo_default"
if [ -n "$GITHUB_REPO" ]; then
  ask_optional PRODUCTION_REVIEWERS "GitHub users who must approve a production deploy, comma-separated" ""
fi
ask IMAGE_NAME "Image name in the registry" "$(slug "$(basename "$PROJECT_DIR")" 40)"
IMAGE_NAME="$(slug "$IMAGE_NAME" 40)"

for v in AZURE_SUBSCRIPTION_ID LOCATION RESOURCE_GROUP REGISTRY_NAME NAME_PREFIX IMAGE_NAME; do
  declare -n _v="$v"; safe_value "$_v" || fail "$v=\"$_v\" has characters a resource name or id does not"; unset -n _v
done
[[ "$REGISTRY_NAME" =~ ^[a-zA-Z0-9]{5,50}$ ]] || fail "registry name $REGISTRY_NAME must be 5-50 letters and digits"

if [ "$DEPLOY_MODE" = create ]; then
  say ""
  say "About to create, in $LOCATION, whatever of these does not exist yet:"
  say "  resource groups $SHARED_RESOURCE_GROUP, $RESOURCE_GROUP, $RESOURCE_GROUP_DEVELOPMENT, $RESOURCE_GROUP_PRODUCTION"
  say "  container registry $REGISTRY_NAME (Basic, admin user off) in $SHARED_RESOURCE_GROUP"
  [ -z "$PULL_IDENTITY_ID" ] && say "  managed identity id-$NAME_PREFIX-pull, allowed to pull images"
  [ -n "$GITHUB_REPO" ] && say "  managed identity id-$NAME_PREFIX-github, which GitHub signs in as for $GITHUB_REPO"
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
[ -n "${RESOURCE_GROUP_DEVELOPMENT:-}" ] && ensure_group "$RESOURCE_GROUP_DEVELOPMENT"
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
SHARED_RESOURCE_GROUP="${SHARED_RESOURCE_GROUP:-$(cut -d/ -f5 <<< "$REGISTRY_ID")}"

# ---- the identity the application pulls its image as ------------------------------------------

if [ -z "${PULL_IDENTITY_ID:-}" ]; then
  PULL_IDENTITY_ID="$(ensure_identity "$SHARED_RESOURCE_GROUP" "id-$NAME_PREFIX-pull")"
fi
pull_principal="$(az identity show --ids "$PULL_IDENTITY_ID" --query principalId -o tsv)" \
  || fail "identity $PULL_IDENTITY_ID does not exist, or this account cannot read it"
assign "$pull_principal" AcrPull "$REGISTRY_ID" required
ok "the application pulls its image as $(name_of "$PULL_IDENTITY_ID")"

# ---- Docker sign-in to the registry ------------------------------------------------------------

az acr login --name "$REGISTRY_NAME" > /dev/null || fail "docker could not sign in to $REGISTRY_SERVER"
ok "docker is signed in to $REGISTRY_SERVER"

# ---- the SRE agent -----------------------------------------------------------------------------

env_groups=("$RESOURCE_GROUP")
[ -n "${RESOURCE_GROUP_DEVELOPMENT:-}" ] && env_groups+=("$RESOURCE_GROUP_DEVELOPMENT")
[ -n "${RESOURCE_GROUP_PRODUCTION:-}" ] && env_groups+=("$RESOURCE_GROUP_PRODUCTION")
agent_identity=""
if [ -n "${SRE_AGENT_ID:-}" ]; then
  agent_identity="$(az resource show --ids "$SRE_AGENT_ID" --api-version 2026-01-01 \
    --query properties.knowledgeGraphConfiguration.identity -o tsv 2>/dev/null)" \
    || fail "SRE agent $SRE_AGENT_ID cannot be read by this account"
  agent_principal="$(az identity show --ids "$agent_identity" --query principalId -o tsv)" \
    || fail "the SRE agent's identity $agent_identity cannot be read by this account"
  for rg in "${env_groups[@]}"; do
    for role in "${READER_ROLES[@]}"; do assign "$agent_principal" "$role" "$SUB_SCOPE/resourceGroups/$rg" optional; done
  done
  ok "the SRE agent can read ${env_groups[*]}"
fi

# ---- GitHub: the identity it signs in as, its environments and their variables -----------------

AZURE_CLIENT_ID="${AZURE_CLIENT_ID:-}"
if [ -n "${GITHUB_REPO:-}" ]; then
  if ! command -v gh > /dev/null 2>&1 || ! gh auth status > /dev/null 2>&1; then
    warn "the GitHub CLI is missing or not signed in, so $GITHUB_REPO was not set up; sign in with gh auth login and run deploy again"
  else
    gh_id="$(ensure_identity "$SHARED_RESOURCE_GROUP" "id-$NAME_PREFIX-github")"
    gh_name="$(name_of "$gh_id")"
    AZURE_CLIENT_ID="$(az identity show --ids "$gh_id" --query clientId -o tsv)"
    gh_principal="$(az identity show --ids "$gh_id" --query principalId -o tsv)"
    declare -A env_rg=()
    envs=()
    if [ -n "${RESOURCE_GROUP_DEVELOPMENT:-}" ]; then env_rg[development]="$RESOURCE_GROUP_DEVELOPMENT"; envs+=(development); fi
    if [ -n "${RESOURCE_GROUP_PRODUCTION:-}" ]; then env_rg[production]="$RESOURCE_GROUP_PRODUCTION"; envs+=(production); fi
    for env in "${envs[@]}"; do
      if ! az identity federated-credential show --resource-group "$SHARED_RESOURCE_GROUP" --identity-name "$gh_name" \
             --name "github-$env" --output none 2>/dev/null; then
        az identity federated-credential create --resource-group "$SHARED_RESOURCE_GROUP" --identity-name "$gh_name" \
          --name "github-$env" --issuer https://token.actions.githubusercontent.com \
          --subject "repo:$GITHUB_REPO:environment:$env" --audiences api://AzureADTokenExchange --output none \
          || fail "could not let $GITHUB_REPO's $env environment sign in as $gh_name"
      fi
      assign "$gh_principal" Contributor "$SUB_SCOPE/resourceGroups/${env_rg[$env]}" optional
    done
    assign "$gh_principal" AcrPush "$REGISTRY_ID" optional
    assign "$gh_principal" "Managed Identity Operator" "$PULL_IDENTITY_ID" optional
    if [ -n "$agent_identity" ]; then
      assign "$gh_principal" Contributor "$SRE_AGENT_ID" optional
      assign "$gh_principal" "Managed Identity Operator" "$agent_identity" optional
    fi
    ok "$GITHUB_REPO signs in to Azure as $gh_name, by OpenID Connect"

    for env in "${envs[@]}"; do
      body='{}'
      if [ "$env" = production ] && [ -n "${PRODUCTION_REVIEWERS:-}" ]; then
        ids=""
        IFS=, read -r -a logins <<< "$PRODUCTION_REVIEWERS"
        for login in "${logins[@]}"; do
          id="$(gh api "users/$login" --jq .id 2>/dev/null)" || { warn "no GitHub user $login"; continue; }
          ids="$ids${ids:+,}{\"type\":\"User\",\"id\":$id}"
        done
        [ -n "$ids" ] && body="{\"reviewers\":[$ids]}"
      fi
      gh api --method PUT "repos/$GITHUB_REPO/environments/$env" --input - <<< "$body" > /dev/null \
        || { warn "could not create the $env environment in $GITHUB_REPO (it needs admin on the repository)"; continue; }
      set_var() {
        [ -n "$2" ] || return 0
        gh variable set "$1" --env "$env" --repo "$GITHUB_REPO" --body "$2" > /dev/null \
          || warn "could not set $1 in $GITHUB_REPO environment $env"
      }
      set_var AZURE_CLIENT_ID "$AZURE_CLIENT_ID"
      set_var AZURE_TENANT_ID "$AZURE_TENANT_ID"
      set_var AZURE_SUBSCRIPTION_ID "$AZURE_SUBSCRIPTION_ID"
      set_var RESOURCE_GROUP "${env_rg[$env]}"
      set_var LOCATION "$LOCATION"
      set_var REGISTRY "$REGISTRY"
      set_var PULL_IDENTITY_ID "$PULL_IDENTITY_ID"
      set_var SRE_AGENT_ID "${SRE_AGENT_ID:-}"
      ok "$GITHUB_REPO environment $env has its deploy variables"
    done
    git -C "$PROJECT_DIR" ls-remote --exit-code --heads origin development > /dev/null 2>&1 \
      || warn "$GITHUB_REPO has no development branch yet; pushing one is what starts the automatic deploys"
  fi
fi

# ---- settings ----------------------------------------------------------------------------------

mkdir -p "$(dirname "$SDLC_SETTINGS_FILE")"
umask 077
{
  for v in DEPLOY_MODE NAME_PREFIX AZURE_SUBSCRIPTION_ID AZURE_TENANT_ID LOCATION RESOURCE_GROUP \
           RESOURCE_GROUP_DEVELOPMENT RESOURCE_GROUP_PRODUCTION SHARED_RESOURCE_GROUP REGISTRY_NAME \
           IMAGE_NAME REGISTRY PULL_IDENTITY_ID SRE_AGENT_ID GITHUB_REPO PRODUCTION_REVIEWERS AZURE_CLIENT_ID; do
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
[ "$REQUIRED_MISSING" = 0 ] || fail "the application cannot pull its image until the AcrPull assignment above is made; run deploy again after"
