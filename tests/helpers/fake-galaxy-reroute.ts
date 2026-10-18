import http from "node:http";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const JOB = "1111111111111111",
  DATA = "2222222222222222",
  HISTORY = "3333333333333333",
  TARGET_HISTORY = "4444444444444444",
  WORKFLOW = "6666666666666666",
  TARGET_WORKFLOW = "7777777777777777",
  COLLECTION = "8888888888888888";
export const content = Buffer.from("first\r\nsecond\r\n");

export async function fakeGalaxy(name: "us" | "eu") {
  const state = {
    jobState: "queued",
    invocationState: "ready",
    submissions: [] as Record<string, unknown>[],
    requests: [] as Array<{ method: string; url: string; key: string }>,
    uploads: new Map<string, Buffer>(),
    datasets: new Map<string, Buffer>(),
    collections: new Map<string, Record<string, unknown>>(),
    corrupt: false,
    timeout: false,
    version: "1.0.0",
    collection: false,
    completeDuringTransfer: false,
    denyCancel: false,
    udt: false,
    reference: false,
    nested: false,
    account: `account-${name}`,
  };
  const definition = {
    class: "GalaxyUserTool",
    id: "cat1",
    version: "1.0.0",
    name: "cat",
    container: "busybox:1.37",
    shell_command: "cat",
    inputs: [],
    outputs: [],
  };
  const uuid = "d51e6248-1220-42a8-8d42-d245ae192732";
  const workflow = {
    a_galaxy_workflow: "true",
    name: "test",
    steps: {
      "0": { type: "data_input", input_connections: {} },
      "1": {
        type: "tool",
        tool_id: "cat1",
        tool_version: "1.0.0",
        tool_state: "{}",
        input_connections: { input: { id: 0, output_name: "output" } },
      },
    },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const key = String(req.headers["x-api-key"] ?? "");
    state.requests.push({ method: req.method!, url: req.url!, key });
    if (key !== `${name}-key` && key !== `${name}-new-key`) {
      res.writeHead(401);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    let body: Record<string, unknown> = {};
    if (bytes.length && req.headers["content-type"]?.includes("json"))
      body = JSON.parse(bytes.toString());
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith("/api/upload/resumable_upload")) {
      if (req.method === "POST") {
        const id = randomUUID();
        state.uploads.set(id, Buffer.alloc(0));
        res.writeHead(201, {
          Location: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/upload/resumable_upload/${id}`,
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": "0",
        });
        res.end();
        return;
      }
      const id = url.pathname.split("/").pop()!;
      if (req.method === "PATCH") {
        state.uploads.set(id, Buffer.concat([state.uploads.get(id)!, bytes]));
        res.writeHead(204, {
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(state.uploads.get(id)!.length),
        });
        res.end();
        return;
      }
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(state.uploads.get(id)!.length),
        });
        res.end();
        return;
      }
    }
    if (url.pathname === "/api/users/current")
      return json({
        id: state.account,
        username: name,
        quota_percent: 1,
        quota_limit: 1e12,
        total_disk_usage: 0,
      });
    if (url.pathname === `/api/jobs/${JOB}/build_for_rerun`)
      return json({
        id: "cat1",
        version: "1.0.0",
        ...(state.udt ? { uuid } : {}),
        inputs: state.reference
          ? [{ name: "index", type: "select", is_dynamic: true, options: [["hg38", "hg38", true]] }]
          : [],
        state_inputs:
          name === "eu" && state.submissions.length
            ? Object.fromEntries(
                Object.entries(state.submissions[0].inputs as Record<string, unknown>).map(
                  ([k, v]) => [k, JSON.stringify(v)],
                ),
              )
            : {
                input: JSON.stringify({
                  src: state.collection ? "hdca" : "hda",
                  id: state.collection ? COLLECTION : DATA,
                }),
                repeat: JSON.stringify(2),
                ...(state.reference ? { index: JSON.stringify("hg38") } : {}),
              },
      });
    if (url.pathname === `/api/jobs/${JOB}`) {
      if (req.method === "DELETE") {
        if (state.denyCancel) return json({ error: "refused" }, 409);
        state.jobState = "deleted";
        return json(true);
      }
      return json({
        id: JOB,
        state: state.jobState,
        tool_id: "cat1",
        tool_version: "1.0.0",
        history_id: name === "eu" ? TARGET_HISTORY : HISTORY,
        inputs: {
          input: {
            id: state.collection ? COLLECTION : DATA,
            src: state.collection ? "hdca" : "hda",
          },
        },
        outputs: {},
      });
    }
    if (url.pathname.startsWith("/api/unprivileged_tools"))
      return json(
        req.method === "POST"
          ? { uuid, representation: body.representation }
          : url.pathname === "/api/unprivileged_tools"
            ? []
            : { uuid, representation: definition, representation_status: "ok" },
      );
    if (url.pathname === "/api/jobs")
      return json([
        {
          id: JOB,
          state: state.jobState,
          tool_id: "cat1",
          tool_version: "1.0.0",
          history_id: name === "us" ? HISTORY : TARGET_HISTORY,
        },
      ]);
    if (url.pathname === "/api/tools/cat1/build")
      return json({ id: "cat1", version: state.version, inputs: [] });
    if (url.pathname === `/api/invocations/${JOB}/request`)
      return json(
        name === "eu" && state.submissions.length
          ? state.submissions[0]
          : {
              inputs: { "0": { src: "hda", id: DATA } },
              inputs_by: "name|step_index",
              parameters: {},
              history_id: HISTORY,
              instance: true,
            },
      );
    if (url.pathname === `/api/invocations/${JOB}`) {
      if (req.method === "DELETE") state.invocationState = "cancelled";
      return json({
        id: JOB,
        state: state.invocationState,
        workflow_id: name === "us" ? WORKFLOW : TARGET_WORKFLOW,
        history_id: name === "us" ? HISTORY : TARGET_HISTORY,
        steps: [],
      });
    }
    if (url.pathname.endsWith("/download") && url.pathname.startsWith("/api/workflows/"))
      return json(workflow);
    if (url.pathname === "/api/workflows" && req.method === "POST")
      return json({ id: TARGET_WORKFLOW, version: 0 });
    if (url.pathname === `/api/workflows/${TARGET_WORKFLOW}/invocations` && req.method === "POST") {
      state.submissions.push(body);
      state.invocationState = "new";
      if (state.timeout) {
        req.socket.destroy();
        return;
      }
      return json({
        id: JOB,
        workflow_id: TARGET_WORKFLOW,
        history_id: TARGET_HISTORY,
        state: "new",
        model_class: "WorkflowInvocation",
      });
    }
    if (url.pathname === "/api/tools" && req.method === "POST") {
      state.submissions.push(body);
      state.jobState = "new";
      if (state.timeout) {
        req.socket.destroy();
        return;
      }
      return json({
        jobs: [{ id: JOB, state: "new", tool_id: "cat1", tool_version: "1.0.0" }],
        outputs: [],
      });
    }
    if (url.pathname === "/api/histories" && req.method === "POST")
      return json({ id: TARGET_HISTORY, name: body.name });
    if (url.pathname === "/api/tools/fetch" && req.method === "POST") {
      const session = (body["files_0|file_data"] as { session_id: string }).session_id;
      const id = (9000000000000000 + state.datasets.size).toString();
      state.datasets.set(id, state.uploads.get(session)!);
      const element = (body.targets as Array<{ elements: Array<Record<string, unknown>> }>)[0]
        .elements[0];
      assert.equal(element.to_posix_lines, false);
      assert.equal(body.auto_decompress, false);
      return json({ outputs: [{ id, state: "ok" }], jobs: [] });
    }
    if (url.pathname === `/api/dataset_collections/${COLLECTION}` && state.nested)
      return json({
        id: COLLECTION,
        name: "nested",
        collection_type: "list:paired",
        populated: true,
        elements: [
          {
            element_identifier: "sample",
            element_type: "dataset_collection",
            object: {
              id: "nested-collection",
              collection_type: "paired",
              elements: [
                { element_identifier: "forward", element_type: "hda", object: { id: DATA } },
                {
                  element_identifier: "reverse",
                  element_type: "hda",
                  object: { id: "5555555555555555" },
                },
              ],
            },
          },
        ],
      });
    if (url.pathname === `/api/dataset_collections/${COLLECTION}`)
      return json({
        id: COLLECTION,
        name: "pair",
        collection_type: "paired",
        populated: true,
        elements: [
          { element_identifier: "forward", element_type: "hda", object: { id: DATA } },
          {
            element_identifier: "reverse",
            element_type: "hda",
            object: { id: "5555555555555555" },
          },
        ],
      });
    if (
      url.pathname === `/api/histories/${TARGET_HISTORY}/contents/dataset_collections` &&
      req.method === "POST"
    ) {
      const id = String(8999999999999900 + state.collections.size);
      state.collections.set(id, {
        id,
        collection_type: body.collection_type,
        elements: (body.element_identifiers as Array<Record<string, unknown>>).map((e) => ({
          element_identifier: e.name,
          element_type: e.src === "hdca" ? "dataset_collection" : "hda",
          object:
            e.src === "hdca"
              ? { ...state.collections.get(String(e.id)), id: "collection-" + e.id }
              : { id: e.id },
        })),
      });
      return json({ id });
    }
    if (url.pathname.startsWith("/api/dataset_collections/"))
      return json(state.collections.get(url.pathname.split("/").pop()!));
    if (url.pathname.endsWith("/extra_files")) return json([]);
    if (url.pathname.startsWith("/api/datasets/")) {
      const id = url.pathname.split("/")[3],
        data = name === "us" ? content : state.datasets.get(id)!;
      if (!data) return json({ error: "not found" }, 404);
      if (url.pathname.endsWith("/display")) {
        if (state.completeDuringTransfer) state.jobState = "ok";
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(state.corrupt ? Buffer.from("changed") : data);
        return;
      }
      return json({
        id,
        state: "ok",
        name: "input.txt",
        file_size: data.length,
        extension: "txt",
        genome_build: "?",
      });
    }
    return json({ error: `Unhandled ${req.method} ${req.url}` }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
