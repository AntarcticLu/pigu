export * as Sandbox from "./sandbox.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

export const Language = Schema.Literals(["html", "jsx", "tsx", "svg"])
export type Language = typeof Language.Type

export interface Item extends Schema.Schema.Type<typeof Item> {}
export const Item = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  title: Schema.String,
  language: Language,
  code: Schema.String,
  files: optional(Schema.Record(Schema.String, Schema.String)),
  entry: optional(Schema.String),
  hash: optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: "Sandbox.Item" })

export interface UpsertInput extends Schema.Schema.Type<typeof UpsertInput> {}
export const UpsertInput = Schema.Struct({
  sessionID: Schema.String,
  id: optional(Schema.String),
  title: Schema.String,
  language: Language,
  code: Schema.String,
  files: optional(Schema.Record(Schema.String, Schema.String)),
  entry: optional(Schema.String),
  hash: optional(Schema.String),
  focus: optional(Schema.Boolean),
}).annotate({ identifier: "Sandbox.UpsertInput" })

export interface ChangedEvent extends Schema.Schema.Type<typeof ChangedEvent> {}
export const ChangedEvent = Schema.Struct({
  sessionID: Schema.String,
  items: Schema.Array(Item),
  focusID: optional(Schema.String),
}).annotate({ identifier: "Sandbox.ChangedEvent" })

export const Definition = Rpc.define({
  id: "opencode.sandbox",
  methods: {
    list: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Array(Item)),
    },
    get: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, id: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.NullOr(Item)),
    },
    upsert: {
      input: Schema.toStandardSchemaV1(UpsertInput),
      output: Schema.toStandardSchemaV1(Item),
    },
    remove: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, id: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Boolean),
    },
  },
  events: {
    changed: {
      schema: Schema.toStandardSchemaV1(ChangedEvent),
    },
  },
})
