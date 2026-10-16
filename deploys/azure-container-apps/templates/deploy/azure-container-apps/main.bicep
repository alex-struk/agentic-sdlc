targetScope = 'resourceGroup'

param prefix string
param location string
param image string
param deployApps bool
@description('Login server of the registry the image is pulled from.')
param registryServer string
@description('Resource id of a user-assigned identity allowed to pull from the registry. Empty when the registry is public.')
param pullIdentityId string = ''
param tags object = {}

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

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApps) {
  name: '${prefix}-web'
  location: location
  tags: tags
  identity: empty(pullIdentityId) ? { type: 'None' } : {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: { external: true, targetPort: 3000, transport: 'auto', allowInsecure: false }
      registries: empty(pullIdentityId) ? [] : [ { server: registryServer, identity: pullIdentityId } ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
}

resource statusTest 'Microsoft.Insights/webtests@2022-06-15' = if (deployApps) {
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

resource statusDown 'Microsoft.Insights/metricAlerts@2018-03-01' = if (deployApps) {
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

resource serverErrors 'Microsoft.Insights/metricAlerts@2018-03-01' = if (deployApps) {
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

output appUrl string = deployApps ? 'https://${app.properties.configuration.ingress.fqdn}' : ''
output workspaceId string = workspace.id
output appInsightsId string = appInsights.id
