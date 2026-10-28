/**
 * Orbit's browser shell: mounts Orbit's ChatPanel, starts the agent worker, drives the chat. A
 * flavor mounts it with its own worker, artifact kinds, launch context and session store.
 */
import "../../../app/src/renderer/styles.css";
import "./shell.css";
import { useChatMarkdown } from "./chat-markdown";
import { settlePlanDrafts } from "./plan-drafts";

import { ChatPanel } from "../../../app/src/renderer/chat/chat-panel";
import { applyOrbitTheme } from "../../../app/src/renderer/theme";

import { galaxyCanRun, galaxyRefusalMessage } from "./diagnostics";
import { buildConfig } from "./config";
import { saveCredentials } from "./credentials";
import { ensureCredentials, switchProvider } from "./credentials-modal";
import { offeredProviders } from "./agent/providers";
import { ChatView, type RunOutcome } from "./transcript";

import { createConfirm } from "./confirm-modal";
import { DEFAULT_BRAND, type Brand } from "./agent/brand";
import { AgentClient } from "./agent/client";
import { briefly, connectGalaxy, type Galaxy } from "./agent/galaxy";
import type { GalaxyStatus } from "./agent/prompt";
import { WHAT } from "./agent/markers";
import type { Settled } from "./agent/watch";
import type { SessionDocument } from "./agent/saved";
import {
  kindsWithoutRenderer,
  paneArtifacts,
  registerArtifactRenderers,
  renderArtifact,
  type Artifact,
  type ArtifactRenderers,
} from "./artifacts";
import { registerArtifactKinds, type ArtifactKind } from "./artifacts/kinds";
import { mountLayout } from "./layout";
import { mountArtifactPane } from "./artifact-pane";
import { mountUsageBar } from "./usage-bar";
import { mountBuildStamp } from "./build-stamp";
import { localTime } from "./galaxy-time";
import { createRetryNotice } from "./retry-notice";

export type { ArtifactRenderer, ArtifactRenderers } from "./artifacts";

const MAX_INPUT_HEIGHT = 150;

/** A url the worker can use: resolved against the page. */
const absolute = (url: string) => new URL(url, document.baseURI).href;

/** Where a conversation starts, and what the page says about it once the agent is ready. */
export interface LaunchContext {
  historyId?: string;
  /** A saved session the page was opened on: said as "Opened a saved conversation." */
  saved?: { id: string; document: SessionDocument };
  /** Why a saved session could not be opened, as a whole line, said before the ready line. */
  savedProblem?: string;
  /** Why the page cannot start at all, as a whole line, said in place of a conversation. */
  stop?: string;
  /** Said after the ready line. */
  greeting?: string;
}

/** Where a conversation is saved, when the flavor saves them: absent, the page offers no Save. */
export interface SessionStore {
  save(document: SessionDocument, id?: string): Promise<string>;
  /** Whether the conversation as it stands is saved, for a host that asks before closing. */
  savedState(saved: boolean): void;
  /** Said once a save succeeds. */
  savedNote: string;
  /** The Save button's tooltip, saying where a save goes. */
  label?: string;
  /** Appended when the browser can't keep the conversation, saying how to keep it anyway. */
  keepHint?: string;
  /** Appended when the browser keeps nothing for this history, saying where saves reopen from. */
  reopenHint?: string;
}

export interface OrbitBrowserOptions {
  galaxyRoot: string;
  datasetId?: string;
  /**
   * Galaxy's AI proxy for the flavor's visualization plugin (`<root>api/plugins/<plugin>`), which
   * the "galaxy" provider talks to; it is the first-launch default when given. A flavor Galaxy
   * doesn't host as a plugin has none, and its picker offers every other provider.
   */
  galaxyChatUrl?: string;
  pyodideURL: string;
  /** The flavor's agent worker; see AgentClient. */
  createWorker: () => Worker;
  artifactKinds?: readonly ArtifactKind<any>[];
  renderers?: ArtifactRenderers;
  launch?: (galaxy: Galaxy) => Promise<LaunchContext>;
  sessions?: SessionStore;
  /** The same brand as the flavor's worker, whose stored state the page reads under it. */
  brand?: Brand;
}

/** The mounted page, as its host sees it. */
export interface OrbitBrowserHandle {
  /**
   * End the agent's worker, detach what the shell attached to `container` and outside it, and
   * empty it. Orbit's ChatPanel adds document and window listeners of its own (mouseup, mousedown,
   * selectionchange, keydown, blur) that only the renderer could detach; they stay, but act on
   * the detached panel.
   */
  dispose(): void;
}

/** With no dataset to start from, the conversation is Galaxy's current history's. */
export async function currentHistoryLaunch(galaxy: Galaxy): Promise<LaunchContext> {
  try {
    const id = (await galaxy.get("history/current_history_json"))?.id;
    if (typeof id === "string" && id) return { historyId: id };
    return { stop: cannotStart("the current history") };
  } catch (e) {
    const problem = String((e as Error)?.message ?? e);
    return { stop: cannotStart("the current history", problem) };
  }
}

/** The line a launch stops with when Galaxy names no history to work in. */
export const cannotStart = (what: string, problem = "it named no history") =>
  `Could not read ${what} from Galaxy (${problem}). This works in a history, so it ` +
  "cannot start; reload to try again.";

/** Grow the composer with its content, up to a few lines. */
function autosize(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  // scrollHeight excludes the border that border-box counts in height.
  const chrome = input.offsetHeight - input.clientHeight;
  const wanted = input.scrollHeight + chrome;
  input.style.height = Math.min(wanted, MAX_INPUT_HEIGHT) + "px";
  input.style.overflowY = wanted > MAX_INPUT_HEIGHT ? "auto" : "hidden";
}

/**
 * Mount the shell into `container`. It assumes it owns its document: one mount per page or
 * iframe. It puts the theme on the root element and the pane's state and drag cursor on body,
 * sizes the pane from the window's width, injects fixed element ids, configures the shared
 * `marked`, and its worker holds a per-origin tab lock. A host that needs it inside a larger page
 * mounts it in an iframe.
 */
export async function mountOrbitBrowser(
  container: HTMLElement,
  options: OrbitBrowserOptions,
): Promise<OrbitBrowserHandle> {
  registerArtifactKinds(options.artifactKinds ?? []);
  registerArtifactRenderers(options.renderers ?? {});
  // Caught at mount rather than when the first artifact of the kind arrives mid-conversation.
  const undrawable = kindsWithoutRenderer();
  if (undrawable.length) {
    throw new Error(`No renderer is registered for artifact kinds: ${undrawable.join(", ")}.`);
  }
  const sessions = options.sessions;
  const brand = options.brand ?? DEFAULT_BRAND;
  const name = brand.name;
  const target = {
    root: options.galaxyRoot,
    datasetId: options.datasetId,
    galaxyChatUrl: options.galaxyChatUrl,
  };
  applyOrbitTheme("light", document.documentElement);

  const el = mountLayout(container, { save: !!sessions });
  if (el.save && sessions?.label) el.save.title = sessions.label;
  const mounted = new AbortController();
  let started: AgentClient | undefined;
  const handle: OrbitBrowserHandle = {
    dispose() {
      mounted.abort();
      retryNotice.stop();
      started?.close();
      container.replaceChildren();
    },
  };
  const artifactPane = mountArtifactPane(container, mounted.signal, brand);
  useChatMarkdown();
  const chat = new ChatPanel(el.messages);
  /** An info line as text: the vendored panel parses it as HTML, and dataset names, ids and
   * approval prompts reach it. */
  const info = (text: string) => {
    const line = chat.addInfoMessage("");
    line.textContent = text;
    return line;
  };
  const retryNotice = createRetryNotice({ addInfoMessage: info });

  // Ask for a provider/key before the worker starts.
  const offered = offeredProviders(!!options.galaxyChatUrl);
  let creds = await ensureCredentials(container, brand, offered);
  const config = buildConfig(target, creds);
  const rootPath = new URL(config.galaxy_root, document.baseURI).pathname;
  chat.setGalaxyServerUrl(absolute(config.galaxy_root));
  const credentials = (process.env.credentials as RequestCredentials) || "include";
  // The page's own Galaxy requests take the transport the agent's do.
  const galaxy = connectGalaxy({ root: config.galaxy_root, credentials });
  const launch = await (options.launch ?? currentHistoryLaunch)(galaxy);
  if (launch.stop) {
    chat.addErrorMessage(launch.stop);
    el.input.disabled = true;
    el.send.disabled = true;
    return handle;
  }
  let savedId = launch.saved?.id;

  const usage = mountUsageBar(container);
  mountBuildStamp(container, {
    commit: (process.env.build_commit as string) || "",
    built: (process.env.build_built as string) || "",
    galaxy: config.galaxy_root,
    // ensureCredentials answered, so buildConfig had a provider to name.
    provider: config.ai_provider || creds.provider,
    model: config.ai_model || "",
  });

  el.input.addEventListener("input", () => autosize(el.input));

  let busy = false;
  let ready = false;
  /** Said once the new conversation is on screen, which clears the old one. */
  let afterReset: string | undefined;
  let galaxyStatus: GalaxyStatus | undefined;

  /** Stop replaces Send for the duration of a run, as in Orbit. */
  function setBusy(running: boolean) {
    busy = running;
    el.send.classList.toggle("hidden", running);
    el.abort.classList.toggle("hidden", !running);
    if (!running) retryNotice.stop();
    refreshControls();
  }

  /** Exactly one explanation for a quiet ending, most specific first. */
  function ended(outcome: RunOutcome) {
    if (outcome.error) {
      console.error(`[${brand.id}] run failed`, outcome.error);
      chat.addErrorMessage(briefly(outcome.error));
    } else if (outcome.aborted) {
      info("Stopped.");
    } else if (outcome.exhausted) {
      // Orbit has no step cap; this one's must not look like completion.
      info('I ran out of steps for one turn while still working. Say "continue" to pick it up.');
    } else if (!outcome.spoke && !outcome.done) {
      info("The model ended the turn without a reply. Ask again, or rephrase.");
    }
    if (el.save) el.save.textContent = "Save";
    sessions?.savedState(false);
    refreshControls();
  }

  /**
   * On open, the newest artifacts: a conversation that can still place a chart but shows an empty
   * pane is telling the user it lost something it did not. Live, only what a result just made.
   */
  async function showArtifacts(artifacts: Artifact[], restored: boolean) {
    if (!artifacts.length) return;
    el.artifactContent.innerHTML = "";
    try {
      for (const artifact of restored ? paneArtifacts(artifacts) : artifacts) {
        await renderArtifact(el.artifactContent, artifact, rootPath, galaxy);
      }
    } catch (e) {
      // Fire-and-forget from the view, so a throw here would reach only the console.
      console.error(`[${brand.id}] could not draw an artifact`, e);
      chat.addErrorMessage(
        `Could not show the artifact: ${briefly(String((e as Error)?.message ?? e))}`,
      );
      return;
    }
    // After filling, so the pane opens on something rather than on an empty frame.
    if (!restored) artifactPane.reveal();
  }

  const view = new ChatView(
    chat,
    {
      info,
      busy: setBusy,
      artifacts: (artifacts, restored) => void showArtifacts(artifacts, restored),
      ended,
      usage: (totals) => usage.set(totals),
      retry: (errorMessage, at, attempt) => retryNotice.start(errorMessage, at, attempt),
      failed: (message) => chat.addErrorMessage(message),
      wrote: () => settlePlanDrafts(el.messages),
      retried: () => retryNotice.stop(),
    },
    brand,
  );

  /**
   * Saving mid-run would store a half-finished run, and an empty conversation has none. A model
   * switch configures the open conversation, so it waits for the worker to have one, as does a
   * message.
   */
  function refreshControls() {
    if (el.save) el.save.disabled = busy || !ready || view.turns === 0;
    el.model.disabled = !ready;
    el.input.disabled = !ready;
    el.send.disabled = !ready;
    el.reset.classList.toggle("hidden", view.turns === 0);
  }

  // Naming the active model makes a misconfigured run obvious.
  const showModel = () =>
    (el.model.textContent = creds.model ? `${creds.provider} · ${creds.model}` : creds.provider);
  showModel();
  refreshControls();

  /** What the worker runs on: urls resolved against the page, and the key. */
  function workerConfig() {
    return {
      ...config,
      ai_base_url: config.ai_base_url && absolute(config.ai_base_url),
      galaxy_root: absolute(config.galaxy_root),
      ai_api_key: creds.apiKey,
      credentials,
    };
  }

  function settledOne({ watched: w, state, outcome, record }: Settled) {
    const what = WHAT[w.kind];
    if (record) {
      chat.addErrorMessage(`The record was not updated for ${what} ${w.id}: ${record}.`);
    }
    if (outcome === "failed") {
      chat.addErrorMessage(`${what} ${w.id} finished as ${state}.`);
    } else if (outcome === "paused") {
      chat.addErrorMessage(`${what} ${w.id} is paused: it waits on an input that failed.`);
    } else if (outcome === "unreadable") {
      chat.addErrorMessage(`${what} ${w.id} is no longer shown by Galaxy (${state}).`);
    } else if (outcome === "cancelled" || outcome === "skipped") {
      // Someone chose this; an alarm about it would be the loudest thing in the room.
      info(`${what} ${w.id} was ${outcome}.`);
    } else {
      info(`${what} ${w.id} finished (${state}).`);
    }
  }

  const opening = {
    pyodideURL: options.pyodideURL,
    config: workerConfig(),
    placement: { historyId: launch.historyId, datasetId: config.dataset_id },
    ...(launch.saved ? { saved: launch.saved } : {}),
  };

  const confirm = createConfirm({
    container,
    respond: (id, approved) => agent.confirm(Number(id), approved),
    note: (text) => info(text),
  });

  /** Said once ready, when the user chose to continue a record whose conversation is gone. */
  let continuing: string | undefined;

  const agent = new AgentClient(
    (message) => {
      if (message.type === "events") {
        view.apply(message.events);
        if (afterReset && message.events.some((e) => e.type === "snapshot")) {
          info(afterReset);
          afterReset = undefined;
        }
        refreshControls();
      } else if (message.type === "settled") {
        settledOne(message.settled);
      } else if (message.type === "held") {
        if (message.held) {
          info(
            message.held === "paused"
              ? "Galaxy results are waiting -- automatic follow-up is paused. Say continue when you're ready."
              : "Galaxy results are waiting -- automatic follow-up paused after several automatic turns. Say continue to resume.",
          );
        }
      } else if (message.type === "confirm") {
        confirm.show(String(message.id), message);
      } else if (message.type === "withdrawn") {
        confirm.dismiss(String(message.id));
      } else if (message.type === "ready") {
        ready = true;
        galaxyStatus = message.galaxy;
        refreshControls();
        if (message.unkept) {
          chat.addErrorMessage(
            `This browser can't keep conversations (${message.unkept}), so this one ends when the ` +
              "page closes." +
              (sessions?.keepHint ? ` ${sessions.keepHint}` : ""),
          );
        }
        if (message.galaxyProblem) {
          chat.addErrorMessage(
            `Galaxy did not answer when this session opened (${message.galaxyProblem}), so no Galaxy tool ` +
              "can run in this session. Reload once Galaxy is back.",
          );
        }
        if (message.recordsProblem) {
          chat.addErrorMessage(
            `Could not look for notebooks on this history (${message.recordsProblem}), so this ` +
              "starts a new one.",
          );
        }
        if (launch.savedProblem) {
          chat.addErrorMessage(launch.savedProblem);
        }
        if (launch.saved) {
          info("Opened a saved conversation.");
        }
        if (continuing) {
          info(continuing);
        }
        info(
          launch.saved
            ? "Ready."
            : view.turns
              ? "Restored this history's conversation from this browser. Ready."
              : "Ready. Ask me to run something.",
        );
        if (launch.greeting) {
          info(launch.greeting);
        }
      } else if (message.type === "recoverable") {
        // The browser kept nothing of a session here; the user says which, if any, this is.
        const line = info(
          "This browser has no conversation for this history. Start a new one, with a new notebook " +
            "or adding to one of this history's notebooks. Adding to a notebook starts a fresh chat " +
            "without its earlier transcript." +
            (sessions?.reopenHint ? ` ${sessions.reopenHint}` : ""),
        );
        const choices = document.createElement("div");
        choices.className = "launch-choices";
        line.append(choices);
        const choose = (pageId?: string) => {
          choices.querySelectorAll("button").forEach((b) => (b.disabled = true));
          agent.recover(pageId);
        };
        for (const record of message.records) {
          const button = document.createElement("button");
          button.className = "plan-btn";
          button.textContent = `New conversation, add to ${record.title} (updated ${localTime(record.updated)})`;
          button.addEventListener("click", () => {
            continuing =
              `New conversation, without the earlier transcript. Notes go to the notebook ` +
              `${record.title}.`;
            choose(record.pageId);
          });
          choices.append(button);
        }
        const fresh = document.createElement("button");
        fresh.className = "plan-btn";
        fresh.textContent = "New conversation, new notebook";
        fresh.addEventListener("click", () => choose());
        choices.append(fresh);
      } else if (message.type === "waiting") {
        const line = info("This session is open in another tab. ");
        const take = document.createElement("button");
        take.className = "plan-btn";
        take.textContent = "Use it here";
        take.addEventListener("click", () => {
          take.disabled = true;
          agent.open({ ...opening, steal: true });
        });
        line.append(take);
      } else if (message.type === "lost") {
        ready = false;
        refreshControls();
        chat.addErrorMessage("This session was opened in another tab, which has it now.");
      } else if (message.type === "failed") {
        console.error(`[${brand.id}] worker failed`, message.message);
        chat.hideThinking();
        setBusy(false);
        chat.addErrorMessage(briefly(message.message));
      }
    },
    options.createWorker,
    name,
  );
  started = agent;
  agent.open(opening);

  el.model.addEventListener("click", async () => {
    const picked = await switchProvider(container, brand, offered);
    if (picked) {
      const previous = { creds, model: { ...config } };
      creds = picked;
      const { ai_base_url, ai_provider, ai_model } = buildConfig(target, picked);
      Object.assign(config, { ai_base_url, ai_provider, ai_model });
      showModel();
      const { ai_base_url: url, ai_api_key } = workerConfig();
      await agent
        .switchModel({ ai_base_url: url, ai_provider, ai_model, ai_api_key })
        .catch((e) => {
          // The worker kept the model it had, so the page, and the next reload, keep it too.
          creds = previous.creds;
          saveCredentials(previous.creds, brand);
          Object.assign(config, previous.model);
          showModel();
          chat.addErrorMessage(`Could not switch the model: ${briefly(String(e))}`);
        });
    }
  });

  // Saving is deliberate, as for any other Galaxy visualization: a revision then marks a
  // save the user asked for rather than a conversation turn.
  const save = el.save;
  save?.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = "Saving...";
    try {
      const document = await agent.export("");
      savedId = await sessions!.save(document, savedId);
      await agent.saved(savedId, document);
      save.textContent = "Saved";
      sessions!.savedState(true);
      info(sessions!.savedNote);
    } catch (e) {
      // The conversation itself is untouched; only the save failed.
      console.error(`[${brand.id}] could not save the session`, e);
      save.textContent = "Save";
      chat.addErrorMessage(`Could not save this conversation: ${briefly(String(e))}`);
    } finally {
      refreshControls();
    }
  });

  function submit() {
    const text = el.input.value.trim();
    if (!text || busy) {
      return;
    }
    if (!ready) {
      info("Still starting; send again once it says it is ready.");
      return;
    }
    el.input.value = "";
    el.input.style.height = "auto";
    // Busy from the click: the run starts once the worker has stored the message.
    setBusy(true);
    chat.showThinking();
    agent.submit(text);
  }

  function stop() {
    if (busy) {
      agent.stop();
    }
  }

  el.send.addEventListener("click", submit);
  el.abort.addEventListener("click", stop);
  // loom: "reset session -- fresh start, no --continue".
  el.reset.addEventListener("click", () => {
    if (busy || !ready) {
      return;
    }
    // A new conversation; the old one stays, saved or not, and its record on Galaxy too.
    savedId = undefined;
    sessions?.savedState(true);
    el.artifactContent.innerHTML = "";
    afterReset =
      "Started a new conversation. The previous one can't be reopened here unless you saved it; " +
      "its notebook is unchanged.";
    agent.reset();
  });
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  // Esc stops the run; bound on the container because the shell may live in an iframe.
  container.addEventListener(
    "keydown",
    (e) => {
      if ((e as KeyboardEvent).key === "Escape" && busy) {
        stop();
      }
    },
    { signal: mounted.signal },
  );

  // Approve / Edit / Reject on a plan draft card; wording follows loom's handler.
  el.messages.addEventListener("plan-draft-action", (e) => {
    const { action, body } = (e as CustomEvent<{ action: string; body: string }>).detail;
    if (action === "approve") {
      // loom's init gate refuses /execute when Galaxy cannot run the plan.
      if (!galaxyCanRun(galaxyStatus)) {
        chat.addErrorMessage(galaxyRefusalMessage());
        return;
      }
      el.input.value =
        "I approve the plan above. Show the full parameter table for review before executing.";
      submit();
    } else if (action === "reject") {
      el.input.value = "Reject the plan above — let's rethink it.";
      submit();
    } else if (action === "edit") {
      // Edit hands the draft back for the user to change; it does not submit.
      el.input.value =
        "Here is the plan with my edits — please revise your draft accordingly:\n\n```plan\n" +
        body +
        "\n```";
      el.input.focus();
      // Setting .value does not raise `input`, so the box would stay one line tall.
      el.input.dispatchEvent(new Event("input"));
    }
  });

  return handle;
}
