// Turning the generated client's `{data, error, response}` results into values or a typed
// error that carries the HTTP status, and the one place that maps a kind onto its generated
// create and update calls, so the generic page can write any kind.

import * as sdk from "@texera/catalog-client";
import type { Resource, UpdateMetadata } from "@texera/catalog-client/types";
import type { CreateInput, KindId } from "./types";

export class CatalogError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "CatalogError";
    this.status = status;
    this.code = code;
  }
}

interface Result<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The data of a client call, or a CatalogError with the response status and the API's message. */
export async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const r = await call;
  const status = r.response?.status ?? 0;
  if (r.error !== undefined || (r.response && !r.response.ok)) {
    const e = r.error;
    const message = isRecord(e) && typeof e.message === "string" ? e.message : typeof e === "string" ? e : (r.response?.statusText ?? "");
    const code = isRecord(e) && typeof e.code === "string" ? e.code : undefined;
    throw new CatalogError(status, message || `HTTP ${status}`, code);
  }
  return r.data as T;
}

type Create = (options: { body: never }) => Promise<Result<Resource>>;
type Update = (options: { path: { rid: string }; body: never; headers?: { "If-Match"?: string } }) => Promise<Result<Resource>>;

// The typed kind routes, by kind. An execution is created by running a workflow; settings is a singleton.
const CREATE: Partial<Record<KindId, Create>> = {
  "agent-template": sdk.agentTemplatesCreate as Create,
  "computing-unit": sdk.computingUnitsCreate as Create,
  conversation: sdk.conversationsCreate as Create,
  credential: sdk.credentialsCreate as Create,
  dataset: sdk.datasetsCreate as Create,
  "mcp-server": sdk.mcpServersCreate as Create,
  model: sdk.modelsCreate as Create,
  "model-endpoint": sdk.modelEndpointsCreate as Create,
  operator: sdk.operatorsCreate as Create,
  profile: sdk.profilesCreate as Create,
  project: sdk.projectsCreate as Create,
  skill: sdk.skillsCreate as Create,
  warehouse: sdk.warehousesCreate as Create,
  workflow: sdk.workflowsCreate as Create,
};

const UPDATE: Partial<Record<KindId, Update>> = {
  "agent-template": sdk.agentTemplatesUpdate as Update,
  "computing-unit": sdk.computingUnitsUpdate as Update,
  conversation: sdk.conversationsUpdate as Update,
  credential: sdk.credentialsUpdate as Update,
  dataset: sdk.datasetsUpdate as Update,
  "mcp-server": sdk.mcpServersUpdate as Update,
  model: sdk.modelsUpdate as Update,
  "model-endpoint": sdk.modelEndpointsUpdate as Update,
  operator: sdk.operatorsUpdate as Update,
  profile: sdk.profilesUpdate as Update,
  project: sdk.projectsUpdate as Update,
  skill: sdk.skillsUpdate as Update,
  warehouse: sdk.warehousesUpdate as Update,
  workflow: sdk.workflowsUpdate as Update,
};

export const canCreate = (kind: KindId) => kind in CREATE;
export const canUpdate = (kind: KindId) => kind in UPDATE || kind === "settings";

export interface CreateBody extends CreateInput {
  spec: unknown;
  visibility?: "private" | "public";
  labels?: Record<string, string>;
  message?: string;
}

/** Creates a resource of a kind through its typed route. */
export function createResource(kind: KindId, body: CreateBody): Promise<Resource> {
  const create = CREATE[kind];
  if (!create) throw new CatalogError(400, `${kind} cannot be created directly`);
  return unwrap(create({ body: body as never }));
}

export interface UpdateSpecBody {
  spec: unknown;
  message?: string;
  expectedHead?: number;
}

/** Replaces the spec of a resource through its typed route; a versioned kind gets a new version. */
export function updateSpec(kind: KindId, rid: string, body: UpdateSpecBody, etag?: string): Promise<Resource> {
  if (kind === "settings") {
    return unwrap(sdk.settingsRoutesUpdate({ body: body as never, headers: etag ? { "If-Match": etag } : undefined })) as Promise<Resource>;
  }
  const update = UPDATE[kind];
  if (!update) throw new CatalogError(400, `${kind} cannot be updated`);
  return unwrap(update({ path: { rid }, body: body as never, headers: etag ? { "If-Match": etag } : undefined }));
}

export function updateMetadata(rid: string, body: UpdateMetadata, etag?: string): Promise<Resource> {
  return unwrap(sdk.resourcesUpdateMetadata({ path: { rid }, body, headers: etag ? { "If-Match": etag } : undefined }));
}

export function deleteResource(rid: string): Promise<void> {
  return unwrap(sdk.resourcesDelete({ path: { rid } })).then(() => undefined);
}
