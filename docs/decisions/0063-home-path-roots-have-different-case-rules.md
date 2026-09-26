# 0063 · Home path roots have different case rules

Status: accepted · 2026-09-25

## Context

The runner removes local home paths from text it records, and the E-2 egress check flags
such paths in files. A lowercase user route is also an ordinary application address.
Applying one case-insensitive home-path expression to every root would mistake that route
for a macOS home directory and rewrite valid project content.

## Decision

Unix and macOS home roots are matched with their respective exact case by both the
redactor and E-2. A mounted Windows home root and a Windows drive home root are matched
without case sensitivity, since the Windows user-directory spelling can vary. Both
readers apply the same distinction so a path one flags is not silently rewritten under
different rules.

## Alternatives

**Match every root without case sensitivity.** This rewrites lowercase application user
routes that are not machine paths.

**Match every root with exact case.** This misses mounted and drive Windows home paths
whose user-directory segment has a different case.

## What would reverse it

A path-aware parser with enough context to distinguish application addresses from local
machine paths could replace these root patterns, if it gives the redactor and E-2 the
same answer.
