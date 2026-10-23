#!/usr/bin/env bash
# deploy.sh <environment> [image-tag] — the only way the application is deployed. The workflow
# runs it for every deploy, a deploy's trial included, and a person deploying by hand runs the
# same file. RESOURCE_GROUP is the group provisioning deployed the definition into, and REGISTRY
# the registry's login server; on GitHub both are the environment's variables.
#
# It creates nothing. It builds each image and pushes it, then points the container apps that
# run it at the digest this run's push produced, by changing their template and nothing else.
# That is all the identity GitHub deploys as may do: change those container apps and push images.
# A new resource, or a change to anything but the images, is a change to the definition, which
# provisioning deploys.
set -euo pipefail

ENVIRONMENT="${1:?usage: deploy.sh <environment> [image-tag]}"
IMAGE_TAG="${2:-$(git rev-parse --short=12 HEAD)}"
: "${RESOURCE_GROUP:?set RESOURCE_GROUP}"
: "${REGISTRY:?set REGISTRY (the registry login server)}"
API=2024-03-01

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
REGISTRY="$(tr '[:upper:]' '[:lower:]' <<< "$REGISTRY")"
# What is built, by the name of the container that runs it: the build context of each image.
declare -A BUILD=([web]="app")

echo "deploying to $ENVIRONMENT from $RESOURCE_GROUP" >&2
if [ -n "${AZURE_SUBSCRIPTION_ID:-}" ]; then az account set --subscription "$AZURE_SUBSCRIPTION_ID"; fi
az acr login --name "${REGISTRY%%.*}" > /dev/null

# Build and push each image, tagged with the commit, on every run, and deploy it by the digest
# this run's push produced: a tag is no proof of who pushed it, so an image another run pushed
# under this tag is never the one deployed.
declare -A DIGEST=()
for container in "${!BUILD[@]}"; do
  ref="$REGISTRY/$container:$IMAGE_TAG"
  docker build --tag "$ref" "$ROOT/${BUILD[$container]}"
  docker push "$ref"
  DIGEST[$container]="$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" | grep -m1 "^$REGISTRY/$container@sha256:")" \
    || { echo "the push of $ref reported no digest" >&2; exit 1; }
done
digests="$(for c in "${!DIGEST[@]}"; do jq -n --arg c "$c" --arg d "${DIGEST[$c]}" '{($c): $d}'; done | jq -s 'add')"

# Each container app provisioning stood up, its containers pointed at this run's images.
placed="[]"
URL=""
for id in $(az containerapp list --resource-group "$RESOURCE_GROUP" --query "[].id" -o tsv); do
  app="$(az rest --method get --url "https://management.azure.com$id?api-version=$API")"
  names="$(jq -c --argjson d "$digests" '[.properties.template.containers[].name | select($d[.] != null)]' <<< "$app")"
  [ "$names" = "[]" ] && continue
  body="$(jq -c --argjson d "$digests" '{properties: {template: (.properties.template | .containers |= map(if $d[.name] then .image = $d[.name] else . end))}}' <<< "$app")"
  az rest --method patch --url "https://management.azure.com$id?api-version=$API" --body "$body" --output none
  for _ in $(seq 1 60); do
    state="$(az rest --method get --url "https://management.azure.com$id?api-version=$API" --query properties.provisioningState -o tsv)"
    [ "$state" = InProgress ] || break
    sleep 5
  done
  [ "$state" = Succeeded ] || { echo "${id##*/} ended $state" >&2; exit 1; }
  placed="$(jq -c --argjson n "$names" '. + $n' <<< "$placed")"
  fqdn="$(jq -r 'select(.properties.configuration.ingress.external == true) | .properties.configuration.ingress.fqdn // empty' <<< "$app")"
  if [ -n "$fqdn" ] && jq -e 'index("web")' <<< "$names" > /dev/null; then URL="https://$fqdn"; fi
  echo "${id##*/} runs $(jq -r 'join(", ")' <<< "$names") from this run's images" >&2
done
for c in "${!DIGEST[@]}"; do
  jq -e --arg c "$c" 'index($c)' <<< "$placed" > /dev/null \
    || { echo "no container app in $RESOURCE_GROUP runs a container named $c; the definition stands them up" >&2; exit 1; }
done
[ -n "$URL" ] || { echo "no container app with external ingress runs the web container" >&2; exit 1; }

curl --fail --silent --show-error --max-time 10 --retry 24 --retry-delay 5 --retry-all-errors "$URL/status" > /dev/null \
  || { echo "the application did not answer at $URL/status" >&2; exit 1; }

echo "DEPLOYED_URL=$URL"
