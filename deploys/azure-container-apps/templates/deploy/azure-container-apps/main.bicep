// Everything the application runs on, in the one resource group provisioning deploys this into,
// signed in as the person running the deploy stage. It creates no role assignment: provisioning
// gives each identity its rights. A deploy never deploys this; it points the container apps at
// the images its run pushed, and nothing else.
targetScope = 'resourceGroup'

param prefix string
param location string = resourceGroup().location
@description('Login server of the registry the images are pulled from.')
param registryServer string
@description('Resource id of the user-assigned identity allowed to pull from the registry.')
param pullIdentityId string
@description('The image each container runs now, as "<app>/<container>": image, so provisioning again keeps what a deploy put there.')
param existingImagesJson string = '{}'
@description('What a container app runs until its first deploy.')
param initialImage string = 'mcr.microsoft.com/k8se/quickstart:latest'
param tags object = {}

var existingImages = json(existingImagesJson)
var webName = '${prefix}-web'
var webImage = existingImages[?'${webName}/web'] ?? initialImage

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-law'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-appi'
  location: location
  tags: tags
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: workspace.id }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-cae'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [ { name: 'Consumption', workloadProfileType: 'Consumption' } ]
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: webName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: { external: true, targetPort: 3000, transport: 'auto', allowInsecure: false }
      registries: [ { server: registryServer, identity: pullIdentityId } ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: webImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
          ]
        }
      ]
      // The placeholder answers on another port than the application, so until the first deploy
      // nothing keeps a replica of it running.
      scale: { minReplicas: webImage == initialImage ? 0 : 1, maxReplicas: 3 }
    }
  }
}

resource statusTest 'Microsoft.Insights/webtests@2022-06-15' = {
  name: '${prefix}-status'
  location: location
  tags: union(tags, { 'hidden-link:${appInsights.id}': 'Resource' })
  kind: 'standard'
  properties: {
    SyntheticMonitorId: '${prefix}-status'
    Name: 'Service status'
    Enabled: true
    Frequency: 300
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [ { Id: 'us-va-ash-azr' }, { Id: 'us-ca-sjc-azr' } ]
    Request: { RequestUrl: 'https://${app.properties.configuration.ingress.fqdn}/status', HttpVerb: 'GET', ParseDependentRequests: false }
    ValidationRules: { ExpectedHttpStatusCode: 200, SSLCheck: false }
  }
}

resource statusDown 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-status-down'
  location: 'global'
  tags: tags
  properties: {
    description: 'The status check fails from two locations.'
    severity: 1
    enabled: true
    scopes: [ statusTest.id, appInsights.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: statusTest.id
      componentId: appInsights.id
      failedLocationCount: 2
    }
  }
}

resource serverErrors 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-5xx'
  location: 'global'
  tags: tags
  properties: {
    description: 'The application answered with server errors.'
    severity: 2
    enabled: true
    scopes: [ app.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ServerErrors'
          metricNamespace: 'microsoft.app/containerapps'
          metricName: 'Requests'
          operator: 'GreaterThan'
          threshold: 5
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
          dimensions: [ { name: 'statusCodeCategory', operator: 'Include', values: [ '5xx' ] } ]
        }
      ]
    }
  }
}

output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output workspaceId string = workspace.id
output appInsightsId string = appInsights.id
