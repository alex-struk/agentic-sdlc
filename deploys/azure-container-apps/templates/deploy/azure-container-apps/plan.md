# Deploy plan

What deploying the application to Azure Container Apps needs, read from the application itself.
The gate rules on this with the definition, the script and the workflow.

## What the application needs

| Resource | Why | Defined in |
|---|---|---|
| Container app `<prefix>-web` | serves the application | `main.bicep` |

## Changes to the application

Each change by its path under `app/`, with what changes and why a deploy needs it. A deploy
changes the application nowhere else.

| Path | Change | Why |
|---|---|---|

## Secrets

Each secret the application needs, by the name the definition reads it under and where it comes
from. Never a value.

| Name | What it is | Where it comes from |
|---|---|---|

## Provisioning

What the person running the stage provides when provisioning runs, beyond signing in.
