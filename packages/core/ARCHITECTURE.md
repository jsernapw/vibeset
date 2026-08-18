# @vibeset/core — architecture

`core` is the engine. The CLI, the Fastify/tRPC server, and the React UI are three thin
faces on top of it. This is a hard rule, not a suggestion:

> **`core` has zero framework dependencies.** No Fastify, no React, no tRPC, no Express.
> Only pure TypeScript, `zod` for shared validation schemas, `node:*` builtins, and the
> Salesforce SDKs (`@salesforce/core`, `@salesforce/source-deploy-retrieve`,
> `@jsforce/jsforce-node`, `@salesforce/apex-node`). If a change to this package requires
> adding a web-framework or UI-framework dependency, it belongs in `server` or `web` instead.

Enforced by convention (no lint rule yet) — check `package.json` before adding a dependency
here. If you need request/response shapes, put a `zod` schema in `core` and import it from
`server`'s route handlers; don't inline validation in the transport layer.

## The central abstraction: `MetadataSource`

```ts
interface MetadataSource {
  readonly id: string;
  readonly kind: 'org' | 'sfdx-project' | 'git-ref';
  inventory(filter: TypeFilter): Promise<ComponentInventory>; // cheap: name + lastModified
  materialize(keys: ComponentKey[]): Promise<SourceTree>; // expensive: actual files
}
```

Defined in `src/types/metadata-source.ts`. Three implementations — `OrgSource`,
`SfdxProjectSource`, `GitRefSource` (`src/sources/`) — are **stubs in Phase 0**. Their
methods throw `Error('... not implemented yet (Phase 1)')`. The shape is final; the bodies
are not. Whoever implements them in Phase 1 should not need to touch the interface.

Every source materializes to Salesforce **source format** (the same on-disk layout
`sf project retrieve` produces), typically via SDR's `MetadataConverter`. The differ,
package builder, and analyzers consume `SourceTree` only — they never know which kind of
source produced it.

## Type contract map

| File                       | Exports                                                                            | Used by                                      |
| -------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| `types/metadata-source.ts` | `MetadataSource`, `ComponentKey`, `ComponentInventory`, `SourceTree`, `TypeFilter` | sources, comparison engine                   |
| `types/snapshot.ts`        | `ComponentSnapshot`, `ComponentSnapshotRef`                                        | retrieval cache, `component_snapshots` table |
| `types/diff.ts`            | `DiffResult`, `DiffStatus`, `DiffEntry`, `ComparisonResult`                        | comparison engine, diff UI                   |
| `types/deployment.ts`      | `DeploymentPackage`, `DeploymentResult`, `DeploymentComponentResult`               | package builder, deploy executor             |
| `types/analyzer.ts`        | `Analyzer`, `Finding`, `AnalysisContext`, `Mutation`                               | Phase 3 analyzer plugins                     |
| `types/job.ts`             | `Job`, `JobProgress`, `JobStatus`                                                  | job runner (`server`), WS progress stream    |

All are re-exported from `src/types/index.ts` and from the package root (`src/index.ts`).
Import from `@vibeset/core` (or `@vibeset/core/types` for types only, dependency-free of the
stub source classes) elsewhere in the monorepo.

## Content addressing

`ComponentSnapshot.sha256` (sha256 of the _canonicalized_ content — normalized XML or raw
text) is the primary key, not `(sourceId, key)`. The same unchanged `Account.object` from
ten comparisons across three orgs is stored once. `ComponentSnapshotRef` is the join record
that says "this source, at this point in time, produced this blob for this component" — many
refs can point at the same `sha256`. This is what makes rollback-package generation and
incremental backups (Phase 4) nearly free: a rollback package is just "re-point these keys at
their prior `sha256`", not a re-fetch.

## Stability note for downstream agents

These types are the contract three parallel workstreams (comparison engine, deployment
executor, analyzer plugins) build against next. Treat renames/shape changes as breaking:
prefer additive changes (new optional fields, new exported types) over rewriting existing
shapes. If a shape genuinely needs to change, grep the other packages first — `server` and
`cli` already import from here.
