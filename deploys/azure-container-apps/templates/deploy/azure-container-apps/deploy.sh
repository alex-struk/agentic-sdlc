#!/usr/bin/env bash
# deploy.sh <environment> [image-tag] — the only way the application is deployed. The workflow
# and a person at a terminal run this same file. Settings come from the environment.
set -euo pipefail

ENVIRONMENT="${1:?usage: deploy.sh <environment> [image-tag]}"
IMAGE_TAG="${2:-$(git rev-parse --short=12 HEAD)}"
: "${RESOURCE_GROUP:?set RESOURCE_GROUP}"
: "${LOCATION:?set LOCATION}"
: "${REGISTRY:?set REGISTRY (the image registry path, lowercase)}"

HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="app-${ENVIRONMENT}"
REGISTRY="$(tr '[:upper:]' '[:lower:]' <<< "$REGISTRY")"

az group create --name "${RESOURCE_GROUP}-${ENVIRONMENT}" --location "$LOCATION" --output none
RG="${RESOURCE_GROUP}-${ENVIRONMENT}"

deploy_stack() {
  az deployment group create --resource-group "$RG" --template-file "$HERE/main.bicep" \
    --parameters prefix="$PREFIX" location="$LOCATION" image="$REGISTRY:$IMAGE_TAG" deployApps="$1" \
    --query properties.outputs --output json
}

# Pass one: monitoring and the environment, so the image has somewhere to land and
# any address only known after this pass exists.
deploy_stack false > /dev/null

# Build and push the image, tagged with the commit, unless that tag is already in the registry.
# An Azure Container Registry is signed in to with `az acr login --name <registry>`; another
# registry is signed in to by whatever the project's profile notes name.
if ! docker manifest inspect "$REGISTRY:$IMAGE_TAG" > /dev/null 2>&1; then
  docker build --tag "$REGISTRY:$IMAGE_TAG" "$HERE/../../app"
  docker push "$REGISTRY:$IMAGE_TAG"
fi

# Pass two: the applications.
outputs="$(deploy_stack true)"
URL="$(jq -r '.appUrl.value' <<< "$outputs")"

for _ in $(seq 1 24); do
  if curl -fsS --max-time 10 "$URL/status" > /dev/null; then ok=1; break; fi
  sleep 5
done
[ "${ok:-0}" = 1 ] || { echo "the application did not answer at $URL/status" >&2; exit 1; }

# Attach the resource group to the SRE agent when one is named.
if [ -n "${SRE_AGENT_ID:-}" ]; then
  RG_ID="$(az group show --name "$RG" --query id -o tsv)"
  API="https://management.azure.com${SRE_AGENT_ID}?api-version=2026-01-01"
  agent="$(az rest --method get --url "$API")"
  if ! jq -e --arg rg "$RG_ID" '.properties.knowledgeGraphConfiguration.managedResources // [] | index($rg)' <<< "$agent" > /dev/null; then
    body="$(jq -c --arg rg "$RG_ID" '.properties.knowledgeGraphConfiguration as $kg
      | {properties: {knowledgeGraphConfiguration: {identity: $kg.identity,
         managedResources: ((($kg.managedResources // []) + [$rg]) | unique)}}}' <<< "$agent")"
    az rest --method patch --url "$API" --body "$body" --output none
    for _ in $(seq 1 30); do
      state="$(az rest --method get --url "$API" --query properties.provisioningState -o tsv)"
      [ "$state" != InProgress ] && break
      sleep 10
    done
    [ "$state" = Succeeded ] || { echo "attaching the SRE agent ended $state" >&2; exit 1; }
  fi
fi

echo "DEPLOYED_URL=$URL"
