/** Cross-instance reruns. Every mutation is behind a concrete human approval. */
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fetchSameOriginOnly } from "../../shared/redirect-guard.js";
import {
  type GalaxyConnection,
  resolveGalaxyConnection,
  verifyGalaxyAccount,
  withGalaxyConnection,
  matchesGalaxyOrigin,
} from "./galaxy-connections.js";
import {
  type RegistryStore,
  canonicalJson,
  specRevision,
  type Attempt,
  type Spec,
} from "./registry.js";
import { type RerouteState } from "./galaxy-reroute-state.js";
import {
  findInvocationBlocks,
  readNotebook,
  upsertInvocationBlock,
  withNotebookLock,
  withNotebookCas,
} from "./notebook-writer.js";
import { findJobBlocks, upsertJobBlock } from "./galaxy-job-block.js";
import { handleSubmissionResult } from "./galaxy-submission-capture.js";
import { readAttemptRecord } from "./galaxy-provenance.js";
import { ulid } from "./ulid.js";
import { transferGalaxyDataset } from "./galaxy-transfer.js";

type Json = Record<string, unknown>;
export interface InputRef {
  id: string;
  src: "hda" | "hdca";
}
export interface ReroutePlan {
  kind: "job" | "invocation";
  sourceId: string;
  source: { id: string; url: string; accountId: string; name: string };
  destination: { id: string; url: string; accountId: string; name: string };
  stepAnchor: string;
  label: string;
  target: Spec["target"];
  request: Json;
  definition: Json;
  template: Json;
  inputs: Array<
    InputRef & {
      name: string;
      bytes: number;
      ext?: string;
      dbkey?: string;
      collectionType?: string;
      elements?: Json[];
    }
  >;
  transferBytes: number;
  predicate: Spec["predicate"];
}
export interface RerouteDeps {
  fetch?: typeof fetch;
  transfer?: typeof transferGalaxyDataset;
  progress?: (message: string) => void;
}

export function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Galaxy returned an unexpected object.");
  return value as Json;
}
export function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(value) || value.length > 200)
    throw new Error("Invalid Galaxy resource identity.");
  return value;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
const segment = (value: string) => encodeURIComponent(value);

export class GalaxySite {
  constructor(
    readonly connection: GalaxyConnection,
    readonly fetchImpl?: typeof fetch,
  ) {}
  async request<T = Json>(
    endpoint: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.response(endpoint, method, body, signal);
    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }
  async response(
    endpoint: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<Response> {
    if (!endpoint.startsWith("/") || endpoint.startsWith("//"))
      throw new Error("Invalid Galaxy API endpoint.");
    const response = await fetchSameOriginOnly(
      `${this.connection.url}/api${endpoint}`,
      {
        method,
        headers: {
          "x-api-key": this.connection.apiKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      },
      {
        serverLabel: "Galaxy",
        urlSettingLabel: "the named profile URL",
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      },
    );
    if (!response.ok)
      throw new Error(
        `${this.connection.name}: Galaxy HTTP ${response.status} for ${method} ${endpoint.split("?")[0]}.`,
      );
    return response;
  }
}

/** Walk only explicitly typed Galaxy references; never replace incidental strings. */
export function mapInputRefs(value: unknown, map: (ref: InputRef) => unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => mapInputRefs(item, map));
  if (!value || typeof value !== "object") return value;
  const obj = value as Json;
  if (["hda", "hdca", "ldda"].includes(String(obj.src))) {
    if (obj.src === "ldda")
      throw new Error("Copy library inputs into a history before rerouting this run.");
    return map({ id: token(obj.id), src: obj.src as InputRef["src"] });
  }
  return Object.fromEntries(
    Object.entries(obj).map(([key, item]) => [key, mapInputRefs(item, map)]),
  );
}

function decodedState(raw: unknown): Json {
  const state = object(raw);
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => {
      if (typeof value !== "string") return [key, value];
      try {
        return [key, JSON.parse(value)];
      } catch {
        return [key, value];
      }
    }),
  );
}
function workflowShape(workflow: Json): unknown {
  const steps = object(workflow.steps);
  return Object.entries(steps).map(([id, value]) => {
    const s = object(value);
    return {
      id,
      type: s.type,
      label: s.label,
      inputs: s.inputs,
      outputs: s.outputs,
      workflow_outputs: s.workflow_outputs,
      when: s.when,
      post_job_actions: s.post_job_actions,
      tool_id: s.tool_id,
      tool_version: s.tool_version,
      tool_state: s.tool_state,
      input_connections: s.input_connections,
      subworkflow: s.subworkflow ? workflowShape(object(s.subworkflow)) : undefined,
    };
  });
}
/** Galaxy parameter paths retain repeat indexes and conditional nesting. */
function specParameters(inputs: unknown): Pick<Spec, "inputs" | "overrides"> {
  const refs: Spec["inputs"] = [],
    overrides: Spec["overrides"] = [];
  const walk = (value: unknown, param: string) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Json;
      if (["hda", "hdca"].includes(String(obj.src))) {
        refs.push({
          slot: param,
          id: token(obj.id),
          src: obj.src as "hda" | "hdca",
          required: true,
        });
        return;
      }
      if (
        Array.isArray(obj.values) &&
        obj.values.every((v) => v && typeof v === "object" && "src" in v)
      ) {
        for (const ref of obj.values) walk(ref, param);
        return;
      }
      for (const [key, item] of Object.entries(obj)) walk(item, param ? `${param}|${key}` : key);
    } else if (Array.isArray(value)) {
      if (value.every((v) => !v || typeof v !== "object"))
        overrides.push({ param, value, rationale: "Preserved from the original request." });
      else value.forEach((item, index) => walk(item, `${param}_${index}`));
    } else overrides.push({ param, value, rationale: "Preserved from the original request." });
  };
  walk(inputs, "");
  return { inputs: refs, overrides };
}

/** Nested collection IDs name DatasetCollection rows, not history associations. */
function collectionShape(collection: Json): unknown {
  if (!Array.isArray(collection.elements))
    throw new Error("Destination nested collection is incomplete.");
  return {
    type: collection.collection_type,
    elements: collection.elements.map((raw) => {
      const element = object(raw),
        child = object(element.object);
      return {
        name: element.element_identifier,
        type: element.element_type,
        content:
          element.element_type === "dataset_collection" ? collectionShape(child) : token(child.id),
      };
    }),
  };
}

function completeJob(state: unknown): boolean {
  return ["ok", "error", "deleted", "deleted_new", "discarded", "stopped", "skipped"].includes(
    String(state),
  );
}

export class GalaxyRerouter {
  constructor(
    readonly store: RegistryStore,
    readonly notebook: string,
    readonly deps: RerouteDeps = {},
  ) {}
  private site(connection: GalaxyConnection) {
    return new GalaxySite(connection, this.deps.fetch);
  }
  private update(id: string, patch: Partial<RerouteState>) {
    this.store.update((registry) => {
      const route = registry.reroutes?.[id];
      if (!route) throw new Error("Reroute record disappeared.");
      Object.assign(route, patch, { updated_at: new Date().toISOString() });
    });
  }

  async prepare(
    kind: "job" | "invocation",
    sourceId: string,
    sourceIdOrName: string,
    destinationId: string,
    signal?: AbortSignal,
  ): Promise<{ route: RerouteState; plan: ReroutePlan }> {
    token(sourceId);
    const [source, destination] = await Promise.all(
      [sourceIdOrName, destinationId].map((id) =>
        verifyGalaxyAccount(resolveGalaxyConnection(id), signal, true),
      ),
    );
    if (
      source.id === destination.id ||
      (source.url === destination.url && source.accountId === destination.accountId)
    )
      throw new Error("Choose a different Galaxy server/account.");
    const content = await readNotebook(this.notebook);
    const record =
      kind === "job"
        ? findJobBlocks(content).find(
            (b) =>
              b.jobId === sourceId &&
              matchesGalaxyOrigin(b, {
                galaxyServerUrl: source.url,
                connectionId: source.id,
                accountId: source.accountId,
              }),
          )
        : findInvocationBlocks(content).find(
            (b) =>
              b.invocationId === sourceId &&
              matchesGalaxyOrigin(b, {
                galaxyServerUrl: source.url,
                connectionId: source.id,
                accountId: source.accountId,
              }),
          );
    if (!record)
      throw new Error("The source run is not recorded on this connection in the current notebook.");
    const unresolved = Object.values(this.store.snapshot().reroutes ?? {}).find(
      (r) =>
        r.source_id === sourceId &&
        r.source_connection === source.id &&
        [
          "prepared",
          "staging",
          "ready",
          "cancelling",
          "submitting",
          "submission_unknown",
          "submitted",
        ].includes(r.phase),
    );
    if (unresolved)
      throw new Error(
        `This run already has reroute ${unresolved.id} (${unresolved.phase}); reconcile it before another rerun.`,
      );
    const src = this.site(source),
      dst = this.site(destination);
    const detail = await src.request(
      kind === "job" ? `/jobs/${segment(sourceId)}?full=true` : `/invocations/${segment(sourceId)}`,
      "GET",
      undefined,
      signal,
    );
    if (detail.id !== sourceId) throw new Error("Galaxy returned a different source run.");
    let request: Json, definition: Json, template: Json, target: Spec["target"];
    if (kind === "invocation") {
      request = await src.request(
        `/invocations/${segment(sourceId)}/request`,
        "GET",
        undefined,
        signal,
      );
      const workflowId = token(detail.workflow_id);
      definition = await src.request(
        `/workflows/${segment(workflowId)}/download?style=export&instance=true`,
        "GET",
        undefined,
        signal,
      );
      await this.checkWorkflowTools(definition, dst, signal, src, object(request.parameters ?? {}));
      template = definition;
      target = {
        kind: "workflow",
        workflow_id: workflowId,
        version: String(detail.workflow_version ?? "0"),
        definition_digest: digest(workflowShape(definition)),
      };
      if (request.resource_params && Object.keys(object(request.resource_params)).length)
        throw new Error("Review destination resource parameters before rerouting.");
      if (
        [
          request.preferred_object_store_id,
          request.preferred_intermediate_object_store_id,
          request.preferred_outputs_object_store_id,
        ].some(Boolean)
      )
        throw new Error("Destination object store preferences require an explicit review.");
      if (request.replacement_params && Object.keys(object(request.replacement_params)).length)
        throw new Error("Workflow replacement parameters require an explicit destination review.");
    } else {
      const build = await src.request(
        `/jobs/${segment(sourceId)}/build_for_rerun`,
        "GET",
        undefined,
        signal,
      );
      if (Object.keys(object(build.errors ?? {})).length)
        throw new Error("The source job cannot reconstruct its exact input state.");
      if (
        (Array.isArray(build.credentials) && build.credentials.length) ||
        build.job_credentials_context
      )
        throw new Error(
          "Rebind this tool's external credentials on the destination before rerouting.",
        );
      const protectedRecord = record.attemptId
        ? await readAttemptRecord(path.dirname(this.notebook), record.attemptId)
        : null;
      const protectedJob = protectedRecord?.jobs?.[sourceId];
      const version =
        typeof detail.tool_version === "string"
          ? detail.tool_version
          : protectedRecord?.seeds?.[sourceId]?.tool_version ||
            (protectedJob?.tool_version !== "unknown" ? protectedJob?.tool_version : undefined) ||
            String(detail.tool_id ?? "").match(/\/([^/]+)$/)?.[1];
      if (!version || String(build.version) !== version || build.id !== detail.tool_id)
        throw new Error(
          "The source tool/version cannot be reconstructed exactly; Galaxy may have substituted a newer version.",
        );
      const uuid = typeof build.uuid === "string" ? build.uuid : undefined;
      if (uuid) {
        const userTool = await src.request(
          `/unprivileged_tools/${segment(uuid)}`,
          "GET",
          undefined,
          signal,
        );
        definition = object(userTool.representation);
        await dst.request("/unprivileged_tools?limit=1", "GET", undefined, signal);
        template = definition;
        target = { kind: "udt", tool_uuid: uuid, version, definition_digest: digest(definition) };
      } else {
        definition = build;
        template = await dst.request(
          `/tools/${segment(String(build.id))}/build?tool_version=${segment(version)}`,
          "GET",
          undefined,
          signal,
        );
        if (template.id !== build.id || String(template.version) !== version)
          throw new Error("Destination lacks the exact tool version.");
        target = { kind: "tool", tool_id: String(build.id), version };
      }
      request = {
        inputs: decodedState(build.state_inputs),
        tool_id: target.tool_id,
        tool_version: version,
        input_format: "21.01",
      };
      // Missing data references must never turn a data-dependent run into an empty run.
      const found = new Set<string>();
      mapInputRefs(request.inputs, (ref) => {
        found.add(ref.id);
        return ref;
      });
      for (const input of Object.values(object(detail.inputs ?? {}))) {
        const ref = object(input);
        if (typeof ref.id === "string" && !found.has(ref.id))
          throw new Error("The rerun form did not retain all source inputs.");
      }
      checkReferenceChoices(build, template, request.inputs);
    }
    if (kind === "invocation")
      mapInputRefs(request.parameters, () => {
        throw new Error(
          "Workflow parameter overrides contain dataset references; promote these to explicit workflow inputs before rerouting.",
        );
      });
    const refs = new Map<string, InputRef>();
    mapInputRefs(request.inputs, (ref) => {
      refs.set(`${ref.src}:${ref.id}`, ref);
      return ref;
    });
    const inputs: ReroutePlan["inputs"] = [];
    for (const ref of refs.values()) inputs.push(await this.describeInput(src, ref, signal));
    const bytes = inputs.reduce((sum, input) => sum + input.bytes, 0);
    const user = await dst.request("/users/current", "GET", undefined, signal);
    if (typeof user.quota_percent === "number" && user.quota_percent >= 100)
      throw new Error("Destination quota is exhausted.");
    if (
      typeof user.quota_limit === "number" &&
      typeof user.total_disk_usage === "number" &&
      user.quota_limit - user.total_disk_usage < bytes
    )
      throw new Error("Destination quota is smaller than the required inputs.");
    const original = record.attemptId
      ? this.store.snapshot().attempts[record.attemptId]
      : undefined;
    const plan: ReroutePlan = {
      kind,
      sourceId,
      source: { id: source.id, url: source.url, accountId: source.accountId!, name: source.name },
      destination: {
        id: destination.id,
        url: destination.url,
        accountId: destination.accountId!,
        name: destination.name,
      },
      stepAnchor: record.notebookAnchor || "unattributed",
      label: record.label,
      request,
      definition,
      template,
      target,
      inputs,
      transferBytes: bytes,
      predicate: original?.approval?.spec_snapshot.predicate ?? { kind: "manual" },
    };
    const id = ulid(),
      now = new Date().toISOString();
    const route: RerouteState = {
      id,
      source_attempt: record.attemptId ?? ulid(),
      destination_attempt: ulid(),
      source_connection: source.id,
      destination_connection: destination.id,
      source_account: source.accountId!,
      destination_account: destination.accountId!,
      source_kind: kind,
      source_id: sourceId,
      plan_digest: this.store.putTemplate(plan),
      phase: "prepared",
      mapping: {},
      created_at: now,
      updated_at: now,
    };
    this.store.update((registry) => {
      registry.reroutes ??= {};
      registry.reroutes[id] = route;
      registry.attempts[route.source_attempt] ??= {
        attempt_id: route.source_attempt,
        kind: kind === "invocation" ? "workflow" : "tool",
        binding: { step_anchor: plan.stepAnchor, bound_at: now },
        server_url: source.url,
        history_id: String(detail.history_id ?? ""),
        connection_id: source.id,
        account_id: source.accountId,
        handoff_eligible: false,
      };
    });
    return { route, plan };
  }

  private async checkWorkflowTools(
    workflow: Json,
    site: GalaxySite,
    signal?: AbortSignal,
    source?: GalaxySite,
    parameters: Json = {},
  ): Promise<void> {
    for (const [index, value] of Object.entries(object(workflow.steps))) {
      const step = object(value);
      if (step.type === "tool") {
        const tool = await site.request(
          `/tools/${segment(String(step.tool_id))}/build?tool_version=${segment(String(step.tool_version))}`,
          "GET",
          undefined,
          signal,
        );
        if (tool.id !== step.tool_id || String(tool.version) !== String(step.tool_version))
          throw new Error(`Destination lacks ${step.tool_id} ${step.tool_version}.`);
        const original = source
          ? await source.request(
              `/tools/${segment(String(step.tool_id))}/build?tool_version=${segment(String(step.tool_version))}`,
              "GET",
              undefined,
              signal,
            )
          : tool;
        checkReferenceChoices(original, tool, {
          state:
            typeof step.tool_state === "string"
              ? decodedState(JSON.parse(step.tool_state))
              : step.tool_state,
          overrides: parameters[index],
        });
      }
      if (step.subworkflow) {
        if (parameters[index] && Object.keys(object(parameters[index])).length)
          throw new Error("Nested workflow overrides require explicit destination review.");
        await this.checkWorkflowTools(object(step.subworkflow), site, signal, source);
      }
    }
  }

  private async describeInput(
    site: GalaxySite,
    ref: InputRef,
    signal?: AbortSignal,
    seen = new Set<string>(),
    embedded?: Json,
  ): Promise<ReroutePlan["inputs"][number]> {
    const key = `${embedded ? "nested" : ref.src}:${ref.id}`;
    if (seen.has(key)) throw new Error("Cyclic or oversized input collection.");
    seen.add(key);
    if (seen.size > 100_000) throw new Error("Input collection exceeds the reroute limit.");
    if (ref.src === "hdca") {
      const collection =
        embedded ??
        (await site.request<Json>(
          `/dataset_collections/${segment(ref.id)}?instance_type=history`,
          "GET",
          undefined,
          signal,
        ));
      if (collection.populated === false || !Array.isArray(collection.elements))
        throw new Error("Source collection is not fully populated.");
      if (
        typeof collection.element_count === "number" &&
        collection.elements.length !== collection.element_count
      )
        throw new Error("Source collection listing is incomplete.");
      const identifiers = new Set<string>();
      let bytes = 0;
      for (const item of collection.elements) {
        const element = object(item),
          child = object(element.object);
        if (
          !["hda", "dataset_collection"].includes(String(element.element_type)) ||
          typeof element.element_identifier !== "string" ||
          identifiers.has(element.element_identifier)
        )
          throw new Error("Unsupported or ambiguous collection structure.");
        identifiers.add(element.element_identifier);
        const src = element.element_type === "dataset_collection" ? "hdca" : "hda";
        bytes += (
          await this.describeInput(
            site,
            { src, id: token(child.id) },
            signal,
            seen,
            src === "hdca" ? child : undefined,
          )
        ).bytes;
      }
      seen.delete(key);
      return {
        ...ref,
        name: String(collection.name ?? ref.id),
        bytes,
        collectionType: String(collection.collection_type),
        elements: collection.elements as Json[],
      };
    }
    const dataset = await site.request(`/datasets/${segment(ref.id)}`, "GET", undefined, signal);
    if (!["ok", "empty"].includes(String(dataset.state)) || dataset.deleted || dataset.purged)
      throw new Error(`Input ${ref.id} is unavailable or unfinished.`);
    const extra = await site.request<unknown>(
      `/datasets/${segment(ref.id)}/extra_files`,
      "GET",
      undefined,
      signal,
    );
    if (!Array.isArray(extra) || extra.length)
      throw new Error(
        "Composite datasets with extra files require an explicit export/import; a primary-file copy is insufficient.",
      );
    const size = Number(dataset.file_size ?? dataset.size);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("Source did not report a usable input size.");
    seen.delete(key);
    return {
      ...ref,
      name: String(dataset.name ?? ref.id),
      bytes: size,
      ext: String(dataset.extension ?? dataset.ext ?? "data"),
      dbkey: String(dataset.genome_build ?? dataset.dbkey ?? "?"),
    };
  }

  cancelPrepared(id: string): void {
    const route = this.store.snapshot().reroutes?.[id];
    if (route && ["prepared", "staging", "ready", "cancelling"].includes(route.phase))
      this.update(id, {
        phase: "cancelled",
        error: "Cancelled by the user before a dispatch was reserved.",
      });
  }

  /** Only the human-origin slash command calls this after showing the frozen plan. */
  async execute(
    id: string,
    options: { allowOverlap?: boolean; signal?: AbortSignal } = {},
  ): Promise<RerouteState> {
    let route = this.store.snapshot().reroutes?.[id];
    if (!route || route.phase !== "prepared")
      throw new Error(
        "This reroute cannot be submitted again. Inspect its recorded phase and reconcile first.",
      );
    const plan = this.store.getTemplate(route.plan_digest) as ReroutePlan | undefined;
    if (!plan || digest(plan) !== route.plan_digest)
      throw new Error("The approved preflight was changed or is missing.");
    this.store.update((registry) => {
      if (registry.reroutes![id].phase !== "prepared")
        throw new Error("This reroute is already being executed.");
      Object.assign(registry.reroutes![id], {
        phase: "staging",
        approved_at: new Date().toISOString(),
        allow_overlap: options.allowOverlap === true,
      });
    });
    const [source, destination] = await Promise.all(
      [route.source_connection, route.destination_connection].map((key) =>
        verifyGalaxyAccount(resolveGalaxyConnection(key), options.signal, true),
      ),
    ).catch((error) => {
      this.update(id, { phase: "failed", error: (error as Error).message });
      throw error;
    });
    if (
      source.accountId !== route.source_account ||
      destination.accountId !== route.destination_account
    ) {
      this.update(id, { phase: "failed", error: "Galaxy account changed after preflight." });
      throw new Error("Galaxy account changed after preflight.");
    }
    const src = this.site(source),
      dst = this.site(destination),
      signal = options.signal;
    this.update(id, { phase: "staging" });
    try {
      await this.recordEvent(
        id,
        `Approved ${plan.kind} ${plan.sourceId} on ${source.name} (${source.url}, account ${source.accountId}) → ${destination.name} (${destination.url}, account ${destination.accountId}). Frozen preflight: ${route.plan_digest}. Required input bytes: ${plan.transferBytes}. Original-attempt policy: ${options.allowOverlap ? "explicitly allow overlap" : "cancel and confirm before replacement"}.`,
      );
      this.deps.progress?.(`Preparing inputs on ${destination.name}.`);
      const history = await dst.request(
        "/histories",
        "POST",
        { name: `Orbit reroute ${id}: ${plan.label}` },
        signal,
      );
      const historyId = token(history.id);
      this.update(id, { history_id: historyId });
      const mapping: RerouteState["mapping"] = {};
      const stagedCollections = new Map<string, string>();
      const stage = async (ref: InputRef, embedded?: Json): Promise<InputRef> => {
        const key = `${embedded ? "nested" : ref.src}:${ref.id}`;
        if (mapping[key]) return { id: mapping[key].id, src: mapping[key].src };
        const input = await this.describeInput(src, ref, signal, new Set(), embedded);
        const approved = plan.inputs.find((i) => i.src === ref.src && i.id === ref.id);
        if (
          approved &&
          (approved.bytes !== input.bytes ||
            approved.ext !== input.ext ||
            approved.dbkey !== input.dbkey ||
            approved.collectionType !== input.collectionType ||
            digest(approved.elements ?? []) !== digest(input.elements ?? []))
        )
          throw new Error("Source input metadata or collection changed after approval.");
        if (ref.src === "hdca") {
          const elements: Json[] = [];
          for (const raw of input.elements!) {
            const element = object(raw),
              child = object(element.object);
            const result = await stage(
              {
                id: token(child.id),
                src: element.element_type === "dataset_collection" ? "hdca" : "hda",
              },
              element.element_type === "dataset_collection" ? child : undefined,
            );
            elements.push({ ...result, name: String(element.element_identifier) });
          }
          const result = await dst.request(
            `/histories/${segment(historyId)}/contents/dataset_collections`,
            "POST",
            {
              collection_type: input.collectionType,
              name: input.name,
              element_identifiers: elements,
            },
            signal,
          );
          const actual = await dst.request(
            `/dataset_collections/${segment(token(result.id))}?instance_type=history`,
            "GET",
            undefined,
            signal,
          );
          const actualElements = actual.elements as Json[];
          if (
            actual.collection_type !== input.collectionType ||
            !Array.isArray(actualElements) ||
            actualElements.length !== elements.length ||
            actualElements.some(
              (e, i) =>
                e.element_identifier !== elements[i].name ||
                (elements[i].src === "hdca"
                  ? e.element_type !== "dataset_collection" ||
                    digest(collectionShape(object(e.object))) !==
                      stagedCollections.get(String(elements[i].id))
                  : e.element_type !== "hda" || object(e.object).id !== elements[i].id),
            )
          )
            throw new Error("Destination collection structure or pairing changed.");
          stagedCollections.set(token(result.id), digest(collectionShape(actual)));
          mapping[key] = { id: token(result.id), src: "hdca" };
        } else {
          mapping[key] = {
            ...(await (this.deps.transfer ?? transferGalaxyDataset)(
              src,
              dst,
              input,
              historyId,
              signal,
              this.deps.progress,
            )),
            src: "hda",
          };
        }
        this.update(id, { mapping: { ...mapping } });
        return { id: mapping[key].id, src: mapping[key].src };
      };
      for (const input of plan.inputs) await stage(input);
      let workflowId: string | undefined,
        toolUuid: string | undefined,
        workflowVersion: string | undefined;
      if (plan.kind === "invocation") {
        const imported = await dst.request(
          "/workflows",
          "POST",
          { workflow: plan.definition },
          signal,
        );
        workflowId = token(imported.id);
        workflowVersion = String(imported.version ?? "0");
        const actual = await dst.request(
          `/workflows/${segment(workflowId)}/download?style=export`,
          "GET",
          undefined,
          signal,
        );
        if (digest(workflowShape(actual)) !== digest(workflowShape(plan.definition)))
          throw new Error("Workflow changed during import; reroute stopped before submission.");
      } else if (plan.target.kind === "udt") {
        const imported = await dst.request(
          "/unprivileged_tools",
          "POST",
          { representation: plan.definition },
          signal,
        );
        toolUuid = token(imported.uuid);
        if (digest(imported.representation) !== digest(plan.definition))
          throw new Error("User-defined tool changed during import.");
      } else {
        const current = await dst.request(
          `/tools/${segment(plan.target.tool_id!)}/build?tool_version=${segment(plan.target.version)}`,
          "GET",
          undefined,
          signal,
        );
        if (current.id !== plan.target.tool_id || String(current.version) !== plan.target.version)
          throw new Error("Destination tool changed after approval.");
        checkReferenceChoices(plan.definition, current, plan.request.inputs);
      }
      const inputs = mapInputRefs(plan.request.inputs, (ref) => {
        const match = mapping[`${ref.src}:${ref.id}`];
        if (!match) throw new Error("An input has no verified destination mapping.");
        return { src: match.src, id: match.id };
      });
      this.update(id, { phase: "ready" });
      const latest = await src.request(
        plan.kind === "job"
          ? `/jobs/${segment(plan.sourceId)}?full=true`
          : `/invocations/${segment(plan.sourceId)}?step_details=true`,
        "GET",
        undefined,
        signal,
      );
      if (plan.kind === "invocation")
        latest.jobs = await this.invocationJobs(src, plan.sourceId, signal);
      if (
        latest.state === "ok" ||
        latest.state === "completed" ||
        (plan.kind === "invocation" &&
          latest.state === "scheduled" &&
          !hasActiveInvocationJobs(latest))
      )
        throw new Error(
          "The original run completed while inputs were prepared. Verify its outputs before rerunning.",
        );
      if (!options.allowOverlap) {
        this.update(id, { phase: "cancelling" });
        if (plan.kind === "job") {
          if (!completeJob(latest.state))
            await src.request(`/jobs/${segment(plan.sourceId)}`, "DELETE", {}, signal);
          let stopped = await src.request(
            `/jobs/${segment(plan.sourceId)}?full=true`,
            "GET",
            undefined,
            signal,
          );
          for (let n = 0; n < 10 && !completeJob(stopped.state); n++) {
            await delay(750, undefined, { signal });
            stopped = await src.request(
              `/jobs/${segment(plan.sourceId)}?full=true`,
              "GET",
              undefined,
              signal,
            );
          }
          if (stopped.state === "ok")
            throw new Error(
              "The original completed during cancellation; verify its outputs before rerunning.",
            );
          if (!completeJob(stopped.state))
            throw new Error(
              "Original cancellation is not confirmed. Destination was not submitted; review before allowing overlap.",
            );
        } else {
          if (!["cancelled", "failed"].includes(String(latest.state)))
            await src.request(
              `/invocations/${segment(plan.sourceId)}`,
              "DELETE",
              undefined,
              signal,
            );
          for (const job of await this.invocationJobs(src, plan.sourceId, signal))
            if (!completeJob(job.state))
              await src.request(`/jobs/${segment(token(job.id))}`, "DELETE", {}, signal);
          let stopped = await src.request(
            `/invocations/${segment(plan.sourceId)}?step_details=true`,
            "GET",
            undefined,
            signal,
          );
          stopped.jobs = await this.invocationJobs(src, plan.sourceId, signal);
          for (let n = 0; n < 10 && hasActiveInvocationJobs(stopped); n++) {
            await delay(750, undefined, { signal });
            stopped = await src.request(
              `/invocations/${segment(plan.sourceId)}?step_details=true`,
              "GET",
              undefined,
              signal,
            );
            stopped.jobs = await this.invocationJobs(src, plan.sourceId, signal);
          }
          if (
            !["cancelled", "failed"].includes(String(stopped.state)) ||
            hasActiveInvocationJobs(stopped)
          )
            throw new Error(
              "Original workflow/jobs are still active or cancellation is unconfirmed. Destination was not submitted.",
            );
        }
      }
      const request: Json =
        plan.kind === "invocation"
          ? {
              ...plan.request,
              inputs,
              history_id: historyId,
              inputs_by: plan.request.inputs_by ?? "name|step_index",
              allow_tool_state_corrections: false,
              use_cached_job: false,
            }
          : {
              ...plan.request,
              inputs,
              history_id: historyId,
              ...(toolUuid ? { tool_uuid: toolUuid } : {}),
            };
      delete request.workflow_id;
      delete request.instance;
      delete request.history;
      const now = new Date().toISOString();
      const target: Spec["target"] = {
        ...plan.target,
        ...(workflowId ? { workflow_id: workflowId, version: workflowVersion! } : {}),
        ...(toolUuid ? { tool_uuid: toolUuid } : {}),
      };
      const spec: Spec = {
        target,
        server_url: destination.url,
        history_id: historyId,
        ...specParameters(inputs),
        template_ref: {
          digest: this.store.putTemplate(
            plan.kind === "invocation" ? plan.definition : plan.template,
          ),
          fetched_at: now,
          version: target.version,
        },
        predicate: plan.predicate,
        assertions: [],
      };
      const attempt: Attempt = {
        attempt_id: route.destination_attempt,
        kind:
          plan.target.kind === "workflow"
            ? "workflow"
            : plan.target.kind === "udt"
              ? "udt"
              : "tool",
        binding: { step_anchor: plan.stepAnchor, bound_at: now },
        server_url: destination.url,
        connection_id: destination.id,
        account_id: destination.accountId,
        history_id: historyId,
        rerun_of: [route.source_attempt],
        handoff_eligible: false,
        approval: {
          proposal_id: id,
          spec_revision: specRevision(spec),
          spec_snapshot: spec,
          status: "live",
          by: "user",
          at: now,
        },
        reservation: { dispatch_id: id, reserved_at: now, state: "submission_unknown" },
      };
      this.store.update((registry) => {
        registry.attempts[attempt.attempt_id] = attempt;
        registry.attempts[route!.source_attempt].superseded_by = attempt.attempt_id;
        registry.reroutes![id].phase = "submitting";
        registry.reroutes![id].dispatch_digest = this.store.putTemplate({
          request,
          ...(workflowId ? { workflowId } : {}),
          ...(toolUuid ? { toolUuid } : {}),
        });
      });
      await this.retireOriginal(plan, route.destination_attempt, id);
      let response: Json;
      try {
        response = await dst.request(
          workflowId ? `/workflows/${segment(workflowId)}/invocations` : "/tools",
          "POST",
          request,
          signal,
        );
      } catch (error) {
        this.update(id, { phase: "submission_unknown", error: (error as Error).message });
        throw error;
      }
      const jobs = Array.isArray(response.jobs)
        ? response.jobs.map((value) => token(object(value).id))
        : [];
      const invocationId =
        workflowId && typeof response.id === "string" ? token(response.id) : undefined;
      if (!invocationId && !jobs.length) {
        this.update(id, {
          phase: "submission_unknown",
          error:
            "Galaxy did not return a complete receipt; reconcile this history before retrying.",
        });
        throw new Error(
          "Submission result is unknown. Inspect destination history; do not retry blindly.",
        );
      }
      this.store.update((registry) => {
        const a = registry.attempts[attempt.attempt_id];
        a.reservation!.state = "submitted";
        a.submission = {
          ...(invocationId ? { invocation_id: invocationId } : { job_id: jobs[0] }),
          submitted_at: now,
          submitted_by: "harness",
          server_verified: true,
          check: {
            outcome:
              invocationId ||
              (Array.isArray(response.jobs) &&
                response.jobs.every((job) => String(object(job).tool_version) === target.version))
                ? "conformant_by_construction"
                : "unverified",
            mode: "warn",
          },
          request_digest: digest(request),
          dispatch_recheck: { definition_digest_ok: true, template_digest_ok: true, at: now },
        };
        registry.reroutes![id].phase = "submitted";
        registry.reroutes![id].receipt = invocationId
          ? { invocation_id: invocationId }
          : { job_ids: jobs };
      });
      await this.captureReceipt(
        plan,
        this.store.snapshot().reroutes![id],
        destination,
        request,
        response,
        !!workflowId,
        !!toolUuid,
      );
      this.deps.progress?.(
        `Submitted replacement on ${destination.name}. Outputs still require verification.`,
      );
      return this.store.snapshot().reroutes![id];
    } catch (error) {
      route = this.store.snapshot().reroutes![id];
      if (!["submitted", "submission_unknown", "submitting"].includes(route.phase))
        this.update(id, {
          phase: signal?.aborted ? "cancelled" : "failed",
          error: (error as Error).message,
        });
      await this.recordEvent(
        id,
        `Stopped in ${this.store.snapshot().reroutes![id].phase}: ${(error as Error).message}. Destination history: ${route.history_id ?? "not created"}. Inspect recorded state before retrying.`,
      ).catch(() => undefined);
      throw error;
    }
  }

  private async recordEvent(id: string, message: string): Promise<void> {
    await withNotebookLock(this.notebook, () =>
      withNotebookCas(this.notebook, (content) => ({
        content:
          content + `\n\n### Galaxy reroute ${id} — update\n\n${message.replace(/[\r\n]/g, " ")}\n`,
        result: undefined,
      })),
    );
  }

  private async invocationJobs(
    site: GalaxySite,
    id: string,
    signal?: AbortSignal,
    seen = new Set<string>(),
  ): Promise<Json[]> {
    if (seen.has(id) || seen.size > 1000)
      throw new Error("Cannot establish complete nested workflow job state.");
    seen.add(id);
    const jobs: Json[] = [];
    for (let offset = 0; offset < 100_000; offset += 1000) {
      const page = await site.request<Json[]>(
        `/jobs?invocation_id=${segment(id)}&limit=1000&offset=${offset}`,
        "GET",
        undefined,
        signal,
      );
      if (!Array.isArray(page)) throw new Error("Cannot enumerate workflow jobs for cancellation.");
      jobs.push(...page);
      if (page.length < 1000) break;
      if (offset === 99_000) throw new Error("Workflow job listing exceeds the reroute limit.");
    }
    const invocation = await site.request(
      `/invocations/${segment(id)}?step_details=true`,
      "GET",
      undefined,
      signal,
    );
    const steps = Array.isArray(invocation.steps)
      ? invocation.steps
      : Object.values(object(invocation.steps ?? {}));
    for (const raw of steps) {
      const step = object(raw);
      if (typeof step.subworkflow_invocation_id === "string")
        jobs.push(
          ...(await this.invocationJobs(site, token(step.subworkflow_invocation_id), signal, seen)),
        );
    }
    return jobs;
  }

  /** Reattach an accepted receipt after a crash; this never sends a submission. */
  async reconcile(
    id: string,
    remoteIds: string[] = [],
    signal?: AbortSignal,
  ): Promise<RerouteState> {
    const route = this.store.snapshot().reroutes?.[id];
    if (
      !route ||
      !["submitting", "submission_unknown", "submitted"].includes(route.phase) ||
      !route.dispatch_digest ||
      !route.history_id
    )
      throw new Error("This reroute has no dispatch to reconcile.");
    const plan = this.store.getTemplate(route.plan_digest) as ReroutePlan | undefined;
    const dispatch = this.store.getTemplate(route.dispatch_digest) as
      { request: Json; workflowId?: string; toolUuid?: string } | undefined;
    if (!plan || !dispatch) throw new Error("The frozen dispatch is unavailable.");
    const connection = await verifyGalaxyAccount(
      resolveGalaxyConnection(route.destination_connection),
      signal,
      true,
    );
    if (connection.accountId !== route.destination_account)
      throw new Error("Destination account changed.");
    const site = this.site(connection);
    const ids = route.receipt
      ? route.receipt.invocation_id
        ? [route.receipt.invocation_id]
        : (route.receipt.job_ids ?? [])
      : remoteIds.map(token);
    if (!ids.length || new Set(ids).size !== ids.length)
      throw new Error(
        "Supply the destination run ID(s) from the recorded history. Reconciliation never retries a submission.",
      );
    let response: Json;
    if (dispatch.workflowId) {
      if (ids.length !== 1) throw new Error("Expected one workflow invocation.");
      response = await site.request(`/invocations/${segment(ids[0])}`, "GET", undefined, signal);
      const actual = await site.request(
        `/invocations/${segment(ids[0])}/request`,
        "GET",
        undefined,
        signal,
      );
      if (
        response.id !== ids[0] ||
        response.workflow_id !== dispatch.workflowId ||
        response.history_id !== route.history_id ||
        digest(actual.inputs) !== digest(dispatch.request.inputs) ||
        digest(actual.parameters ?? {}) !== digest(dispatch.request.parameters ?? {})
      )
        throw new Error("Destination invocation does not match the frozen dispatch.");
      response = { ...response, model_class: "WorkflowInvocation" };
    } else {
      const jobs: Json[] = [];
      for (const remoteId of ids) {
        const job = await site.request(
          `/jobs/${segment(remoteId)}?full=true`,
          "GET",
          undefined,
          signal,
        );
        const build = await site.request(
          `/jobs/${segment(remoteId)}/build_for_rerun`,
          "GET",
          undefined,
          signal,
        );
        if (
          job.id !== remoteId ||
          job.history_id !== route.history_id ||
          String(build.version) !== plan.target.version ||
          (dispatch.toolUuid
            ? build.uuid !== dispatch.toolUuid
            : job.tool_id !== plan.target.tool_id) ||
          digest(decodedState(build.state_inputs)) !== digest(dispatch.request.inputs)
        )
          throw new Error(
            "Destination job does not match the frozen dispatch. Mapped jobs require complete server-side reconciliation; do not guess their receipt.",
          );
        jobs.push({ ...job, tool_version: build.version });
      }
      response = { jobs, outputs: [] };
    }
    const receipt = dispatch.workflowId ? { invocation_id: ids[0] } : { job_ids: ids };
    const now = new Date().toISOString();
    this.store.update((registry) => {
      const a = registry.attempts[route.destination_attempt];
      if (
        !a?.reservation ||
        !a.approval ||
        a.account_id !== connection.accountId ||
        a.server_url !== connection.url
      )
        throw new Error("The destination reservation is unavailable or has another origin.");
      a.reservation.state = "submitted";
      a.submission = {
        ...(dispatch.workflowId ? { invocation_id: ids[0] } : { job_id: ids[0] }),
        submitted_at: now,
        submitted_by: "harness",
        server_verified: true,
        check: { outcome: "unverified", mode: "warn" },
        request_digest: digest(dispatch.request),
        dispatch_recheck: { definition_digest_ok: true, template_digest_ok: true, at: now },
      };
      Object.assign(registry.reroutes![id], {
        phase: "submitted",
        receipt,
        error: undefined,
        updated_at: now,
      });
    });
    await this.captureReceipt(
      plan,
      route,
      connection,
      dispatch.request,
      response,
      !!dispatch.workflowId,
      !!dispatch.toolUuid,
    );
    return this.store.snapshot().reroutes![id];
  }

  private async captureReceipt(
    plan: ReroutePlan,
    route: RerouteState,
    destination: GalaxyConnection,
    request: Json,
    response: Json,
    workflow: boolean,
    udt: boolean,
  ): Promise<void> {
    await withGalaxyConnection(destination, () =>
      handleSubmissionResult(
        route.id,
        workflow
          ? "mcp__galaxy__invoke_workflow"
          : udt
            ? "mcp__galaxy__run_user_tool"
            : "mcp__galaxy__run_tool",
        {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                data: workflow ? { ...response, model_class: "WorkflowInvocation" } : response,
              }),
            },
          ],
        },
        false,
        { attemptId: route.destination_attempt, args: request, stepAnchor: plan.stepAnchor },
      ),
    );
    const content = await readNotebook(this.notebook);
    const recorded = workflow
      ? findInvocationBlocks(content).some((b) => b.attemptId === route.destination_attempt)
      : findJobBlocks(content).some((b) => b.attemptId === route.destination_attempt);
    if (!recorded)
      throw new Error(
        `Submission accepted but notebook receipt is missing. Use /reroute reconcile ${route.id} to repair it without resubmission.`,
      );
    await this.appendReceipt(
      plan,
      route.id,
      route.history_id!,
      route.receipt?.invocation_id ?? route.receipt?.job_ids?.join(", ") ?? "recorded",
    );
  }

  private async retireOriginal(plan: ReroutePlan, replacement: string, rerouteId: string) {
    await withNotebookLock(this.notebook, () =>
      withNotebookCas(this.notebook, (content) => {
        const origin = {
          galaxyServerUrl: plan.source.url,
          connectionId: plan.source.id,
          accountId: plan.source.accountId,
        };
        const record =
          plan.kind === "job"
            ? findJobBlocks(content).find(
                (b) => b.jobId === plan.sourceId && matchesGalaxyOrigin(b, origin),
              )
            : findInvocationBlocks(content).find(
                (b) => b.invocationId === plan.sourceId && matchesGalaxyOrigin(b, origin),
              );
        if (!record) throw new Error("Original notebook record disappeared before submission.");
        const next =
          plan.kind === "job"
            ? upsertJobBlock(content, record as ReturnType<typeof findJobBlocks>[number], {
                supersededBy: replacement,
                rerouteId,
              })
            : upsertInvocationBlock(
                content,
                record as ReturnType<typeof findInvocationBlocks>[number],
                { supersededBy: replacement, rerouteId },
              );
        return { content: next, result: undefined };
      }),
    );
  }
  private async appendReceipt(plan: ReroutePlan, id: string, history: string, run: string) {
    await withNotebookLock(this.notebook, () =>
      withNotebookCas(this.notebook, (content) => {
        const route = this.store.snapshot().reroutes?.[id];
        const evidence = Object.entries(route?.mapping ?? {})
          .map(
            ([source, dest]) =>
              `- ${source} → ${dest.src}:${dest.id}${dest.sha256 ? `; SHA-256 ${dest.sha256}` : "; collection structure verified"}`,
          )
          .join("\n");
        const note = `\n\n### Galaxy reroute ${id}\n\nRequested replacement of ${plan.kind} ${plan.sourceId} on ${plan.source.name} (${plan.source.url}) with a new attempt on ${plan.destination.name} (${plan.destination.url}). Inputs verified against source content and collection structure. Destination history: ${history}; run: ${run}. The original attempt is retained. Replacement outputs require verification before downstream use.\n\n${evidence}\n`;
        return {
          content: content.includes(`### Galaxy reroute ${id}\n`) ? content : content + note,
          result: undefined,
        };
      }),
    );
  }
}

function hasActiveInvocationJobs(invocation: Json): boolean {
  const steps = Array.isArray(invocation.steps)
    ? invocation.steps
    : Object.values(object(invocation.steps ?? {}));
  const jobs = Array.isArray(invocation.jobs)
    ? invocation.jobs
    : steps.flatMap((step) => (object(step).jobs as unknown[]) ?? []);
  return jobs.some((job) => !completeJob(object(job).state));
}

/** Reference indexes are not portable merely because a dbkey has the same label. */
function checkReferenceChoices(source: Json, destination: Json, state: unknown): void {
  const selectedByName = new Map<string, unknown[]>();
  const walk = (value: unknown, visit: (entry: Json) => void) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const entry = value as Json;
    visit(entry);
    for (const item of Object.values(entry)) walk(item, visit);
  };
  walk(state, (entry) => {
    for (const [name, value] of Object.entries(entry))
      selectedByName.set(name.split("|").pop()!, [
        ...(selectedByName.get(name.split("|").pop()!) ?? []),
        value,
      ]);
  });
  const options = new Map<string, Set<string>>();
  walk(destination.inputs, (entry) => {
    if (entry.name && Array.isArray(entry.options))
      options.set(
        String(entry.name),
        new Set(
          entry.options.map((option) =>
            String(Array.isArray(option) ? option[1] : object(option).value),
          ),
        ),
      );
  });
  walk(source.inputs, (entry) => {
    if (!entry.name || !["select", "drill_down", "genomebuild"].includes(String(entry.type)))
      return;
    const values = (selectedByName.get(String(entry.name)) ?? [])
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter(
        (value) =>
          value !== undefined &&
          value !== null &&
          value !== "" &&
          value !== "?" &&
          !(typeof value === "object" && value && "__class__" in value),
      );
    if (!values.length) return;
    // Labels and dbkeys cannot establish identical index contents. Require a
    // history dataset reference rather than silently trusting a cached index.
    if (entry.is_dynamic === true || entry.type === "genomebuild")
      throw new Error(
        `Cannot verify built-in reference/dynamic choice "${entry.name}" across servers. Use explicit reference datasets before rerouting.`,
      );
    const available = options.get(String(entry.name));
    if (available && !values.every((value) => available.has(String(value))))
      throw new Error(`Destination choice "${entry.name}" differs from the source.`);
  });
}
