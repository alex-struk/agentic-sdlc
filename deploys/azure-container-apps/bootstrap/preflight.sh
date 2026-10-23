#!/usr/bin/env bash
# Preflight for Azure Container Apps provisioning: run on the machine of the person running the
# deploy stage before anything is asked or created. It stops on what would stop provisioning (no
# Azure CLI or no sign-in to it, no Bicep to deploy the definition with, no GitHub CLI or no
# sign-in to that) and warns on what may (roles it cannot see). Nothing is written. No image is
# built from this machine, so it needs no Docker: images are built, and every deploy is run, on
# GitHub.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

say "Azure Container Apps preflight"

command -v az > /dev/null 2>&1 || fail "the Azure CLI (az) is not installed"
if ! az account show --output none > /dev/null 2>&1; then
  if interactive && confirm "The Azure CLI is not signed in. Sign in now (device code)?" y; then
    az login --use-device-code --output none || fail "Azure sign-in did not complete"
  else
    fail "the Azure CLI is not signed in; run az login and run the stage again"
  fi
fi
if [ -n "${AZURE_SUBSCRIPTION_ID:-}" ]; then
  az account set --subscription "$AZURE_SUBSCRIPTION_ID" || fail "cannot select subscription $AZURE_SUBSCRIPTION_ID"
fi
sub_name="$(az account show --query name -o tsv)"
user_type="$(az account show --query user.type -o tsv)"
ok "signed in to Azure ($user_type), subscription \"$sub_name\""

for tool in git node; do
  command -v "$tool" > /dev/null 2>&1 || fail "$tool is not installed; provisioning needs it"
done
{ command -v gh > /dev/null 2>&1 && gh auth status > /dev/null 2>&1; } \
  || fail "the GitHub CLI (gh) is missing or not signed in; every deploy runs on GitHub, and provisioning creates the repository's deploy environment there, so sign in with gh auth login as someone who administers the repository"
ok "git, node and the GitHub CLI are ready"
if ! az bicep version > /dev/null 2>&1; then
  say "installing Bicep, which provisioning deploys the definition with"
  az bicep install > /dev/null 2>&1 || fail "Bicep is not installed and could not be; run az bicep install"
fi
ok "Bicep is ready"

# Which roles the signed-in identity holds, directly or through a group. A role activated just in
# time, or held through a group the directory will not list, is not seen here, so this warns and
# the bootstrap finds out for certain when it tries.
oid=""
if [ "$user_type" = user ]; then
  oid="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)"
else
  oid="$(az ad sp show --id "$(az account show --query user.name -o tsv)" --query id -o tsv 2>/dev/null || true)"
fi
if [ -z "$oid" ]; then
  warn "could not read the signed-in identity from the directory, so its roles were not checked"
else
  sub_id="$(az account show --query id -o tsv)"
  roles="$(az role assignment list --assignee "$oid" --all --include-inherited --include-groups \
    --query "[].[roleDefinitionName, scope]" -o tsv 2>/dev/null || true)"
  on_sub="$(awk -F'\t' -v s="/subscriptions/$sub_id" '$2 == s || $2 == "/" {print $1}' <<< "$roles" | sort -u | paste -sd, -)"
  anywhere="$(cut -f1 <<< "$roles" | sort -u | paste -sd, -)"
  if [[ ",$on_sub," =~ ,(Owner|Contributor), ]]; then
    ok "can create resources in the subscription (${on_sub})"
  elif [ -n "$anywhere" ]; then
    warn "no Owner or Contributor on the subscription; creating resource groups will fail, using existing ones may work (roles held: ${anywhere})"
  else
    warn "no role assignments were found for the signed-in identity"
  fi
  if [[ ",$anywhere," =~ ,(Owner|User\ Access\ Administrator|Role\ Based\ Access\ Control\ Administrator), ]]; then
    ok "can assign roles somewhere in the subscription"
  else
    warn "cannot assign roles; the bootstrap will print the role assignments for someone who can"
  fi
fi

missing=""
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.Insights Microsoft.ContainerRegistry Microsoft.ManagedIdentity; do
  state="$(az provider show --namespace "$ns" --query registrationState -o tsv 2>/dev/null || echo Unknown)"
  [ "$state" = Registered ] || missing="$missing $ns"
done
if [ -n "$missing" ]; then warn "not yet registered in the subscription (the bootstrap registers them):$missing"; else ok "resource providers are registered"; fi
