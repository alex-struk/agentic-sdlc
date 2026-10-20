#!/usr/bin/env bash
# deploy.sh <environment> [image-tag] — the only way the application is deployed. The workflow
# runs it for every deploy, a deploy's trial included, and a person deploying by hand runs the
# same file. Settings come from the environment: on GitHub from the environment's variables, on a
# machine from the settings file the setup wrote. RESOURCE_GROUP is the one group this
# environment lives in, and exists. The SRE agent, when there is one, was set to watch it by the
# setup, so nothing here touches the agent.
set -euo pipefail

ENVIRONMENT="${1:?usage: deploy.sh <environment> [image-tag]}"
IMAGE_TAG="${2:-$(git rev-parse --short=12 HEAD)}"
: "${RESOURCE_GROUP:?set RESOURCE_GROUP}"
: "${LOCATION:?set LOCATION}"
: "${REGISTRY:?set REGISTRY (the image registry path, lowercase)}"

HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="app-${ENVIRONMENT}"
REGISTRY="$(tr '[:upper:]' '[:lower:]' <<< "$REGISTRY")"

REGISTRY_SERVER="${REGISTRY%%/*}"

if [ -n "${AZURE_SUBSCRIPTION_ID:-}" ]; then az account set --subscription "$AZURE_SUBSCRIPTION_ID"; fi
RG="$RESOURCE_GROUP"
az group show --name "$RG" --output none \
  || { echo "resource group $RG does not exist; the platform's setup creates it" >&2; exit 1; }

# deploy_stack <deploy-apps> <image>
deploy_stack() {
  az deployment group create --resource-group "$RG" --template-file "$HERE/main.bicep" \
    --parameters prefix="$PREFIX" location="$LOCATION" image="$2" deployApps="$1" \
      registryServer="$REGISTRY_SERVER" pullIdentityId="${PULL_IDENTITY_ID:-}" \
    --query properties.outputs --output json
}

# Pass one: monitoring and the environment, so the image has somewhere to land and
# any address only known after this pass exists.
deploy_stack false "$REGISTRY:$IMAGE_TAG" > /dev/null

# Build and push the image, tagged with the commit, on every run, and deploy it by the digest
# this run's push produced. Every environment's deploys can push to the registry, so a tag is no
# proof of who pushed it, and an image another run pushed under this tag is never the one deployed.
# An Azure Container Registry is signed in to here; another registry is signed in to beforehand
# by whatever the project's profile notes name.
if [[ "$REGISTRY_SERVER" == *.azurecr.io ]]; then az acr login --name "${REGISTRY_SERVER%%.*}" > /dev/null; fi
docker build --tag "$REGISTRY:$IMAGE_TAG" "$HERE/../../app"
docker push "$REGISTRY:$IMAGE_TAG"
DIGEST="$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$REGISTRY:$IMAGE_TAG" | grep -m1 "^$REGISTRY@sha256:")" \
  || { echo "the push of $REGISTRY:$IMAGE_TAG reported no digest" >&2; exit 1; }

# Pass two: the applications, from the image this run pushed.
outputs="$(deploy_stack true "$DIGEST")"
URL="$(jq -r '.appUrl.value' <<< "$outputs")"

for _ in $(seq 1 24); do
  if curl -fsS --max-time 10 "$URL/status" > /dev/null; then ok=1; break; fi
  sleep 5
done
[ "${ok:-0}" = 1 ] || { echo "the application did not answer at $URL/status" >&2; exit 1; }

echo "DEPLOYED_URL=$URL"
