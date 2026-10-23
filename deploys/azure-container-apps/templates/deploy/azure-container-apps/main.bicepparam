// What provisioning deploys main.bicep with. It sets every variable read here except the
// application's secrets, which the person provisioning provides in the environment or is asked
// for; a secret is read here by name and never written.
using './main.bicep'

param prefix = readEnvironmentVariable('NAME_PREFIX')
param location = readEnvironmentVariable('LOCATION')
param registryServer = readEnvironmentVariable('REGISTRY_SERVER')
param pullIdentityId = readEnvironmentVariable('PULL_IDENTITY_ID')
param existingImagesJson = readEnvironmentVariable('EXISTING_IMAGES', '{}')
