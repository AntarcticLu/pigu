export * as Memory from "./memory.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

export const Scope = Schema.Literals(["global", "project"])
export type Scope = typeof Scope.Type

export const Category = Schema.Literals(["preference", "architecture", "convention", "reference", "context"])
export type Category = typeof Category.Type

export const ExternalSource = Schema.Literals([
  "agents-md",
  "claude-md",
  "claude-memory",
  "gemini-md",
  "codex-memory",
])
export type ExternalSource = typeof ExternalSource.Type

export interface Item extends Schema.Schema.Type<typeof Item> {}
export const Item = Schema.Struct({
  id: Schema.String,
  scope: Scope,
  directory: optional(Schema.String),
  fileName: optional(Schema.String),
  filePath: optional(Schema.String),
  title: Schema.String,
  description: optional(Schema.String),
  content: Schema.String,
  category: Category,
  tags: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  pinned: optional(Schema.Boolean),
  source: optional(Schema.String),
  sessionID: optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: "Memory.Item" })

export interface ExternalFile extends Schema.Schema.Type<typeof ExternalFile> {}
export const ExternalFile = Schema.Struct({
  id: Schema.String,
  source: ExternalSource,
  scope: Scope,
  directory: optional(Schema.String),
  title: Schema.String,
  path: Schema.String,
  content: Schema.String,
  writable: Schema.Boolean,
  updatedAt: Schema.Number,
}).annotate({ identifier: "Memory.ExternalFile" })

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  items: Schema.Array(Item),
  projectDirectories: Schema.Array(Schema.String),
  externalFiles: Schema.Array(ExternalFile),
}).annotate({ identifier: "Memory.Snapshot" })

export interface SnapshotInput extends Schema.Schema.Type<typeof SnapshotInput> {}
export const SnapshotInput = Schema.Struct({
  scope: optional(Scope),
  directory: optional(Schema.String),
  includeAllProjects: optional(Schema.Boolean),
}).annotate({ identifier: "Memory.SnapshotInput" })

export interface UpsertInput extends Schema.Schema.Type<typeof UpsertInput> {}
export const UpsertInput = Schema.Struct({
  id: optional(Schema.String),
  scope: Scope,
  directory: optional(Schema.String),
  fileName: optional(Schema.String),
  title: Schema.String,
  description: optional(Schema.String),
  content: Schema.String,
  category: optional(Category),
  tags: optional(Schema.Array(Schema.String)),
  enabled: optional(Schema.Boolean),
  pinned: optional(Schema.Boolean),
  source: optional(Schema.String),
  sessionID: optional(Schema.String),
}).annotate({ identifier: "Memory.UpsertInput" })

export interface ChangedEvent extends Schema.Schema.Type<typeof ChangedEvent> {}
export const ChangedEvent = Schema.Struct({
  items: Schema.Array(Item),
  focusID: optional(Schema.String),
}).annotate({ identifier: "Memory.ChangedEvent" })

export const Definition = Rpc.define({
  id: "opencode.memory",
  methods: {
    snapshot: {
      input: Schema.toStandardSchemaV1(SnapshotInput),
      output: Schema.toStandardSchemaV1(Snapshot),
    },
    upsert: {
      input: Schema.toStandardSchemaV1(UpsertInput),
      output: Schema.toStandardSchemaV1(Item),
    },
    toggle: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          id: Schema.String,
          enabled: optional(Schema.Boolean),
          pinned: optional(Schema.Boolean),
        }),
      ),
      output: Schema.toStandardSchemaV1(Schema.NullOr(Item)),
    },
    remove: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Boolean),
    },
    saveExternalFile: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ path: Schema.String, content: Schema.String })),
      output: Schema.toStandardSchemaV1(ExternalFile),
    },
    importExternal: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          path: Schema.String,
          scope: Scope,
          directory: optional(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(Schema.Array(Item)),
    },
  },
  events: {
    changed: {
      schema: Schema.toStandardSchemaV1(ChangedEvent),
    },
  },
})
