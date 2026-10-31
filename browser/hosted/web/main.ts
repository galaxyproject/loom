/**
 * Hosted Orbit's page: sign in if needed, list the user's conversations, and mount the browser shell
 * on the one in the URL, talking to the host over a WebSocket instead of to a worker in the page.
 */
import { mountOrbitBrowser } from "@galaxyproject/orbit-browser";

import { ORBIT_LOGO } from "./logo";
import { socketWorker } from "./socket-worker";

interface Me {
  sub: string;
  galaxyUrl: string;
  username?: string;
  email?: string;
  model?: string;
}
interface Listed {
  id: string;
  title: string | null;
  lastActiveAt: string;
}

const signIn = () => {
  location.href = `/auth/login?return=${encodeURIComponent(location.pathname)}`;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (response.status === 401) {
    signIn();
    throw new Error("Signing in");
  }
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

const open = (id: string) => location.assign(`/c/${id}`);

async function newConversation(): Promise<void> {
  open((await api<{ id: string }>("/api/conversations", { method: "POST" })).id);
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** "5m ago", "yesterday", or the date, for the conversation list. */
function when(iso: string): string {
  const then = new Date(iso);
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 48 * 60) return "yesterday";
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function masthead(me: Me): HTMLElement {
  const bar = make("header");
  bar.id = "masthead";
  const brand = make("a", "brand");
  brand.href = "/";
  brand.title = "Orbit";
  brand.innerHTML = ORBIT_LOGO;
  bar.append(brand, make("span", "spacer"));

  const galaxy = new URL(me.galaxyUrl);
  const server = make("a", "chip server");
  server.href = galaxy.href;
  server.target = "_blank";
  server.rel = "noopener";
  server.title = "Open this Galaxy";
  server.append(make("span", "dot"), make("span", "", galaxy.host));
  bar.append(server);

  const who = me.username ?? me.email;
  if (who) {
    const user = make("span", "chip user", who);
    if (me.email) user.title = me.email;
    bar.append(user);
  }

  const out = make("form");
  out.method = "post";
  out.action = "/auth/logout";
  out.append(make("button", "chip action", "Sign out"));
  bar.append(out);
  return bar;
}

const EXAMPLES = [
  "What are my most recent histories?",
  "Find a Galaxy tool to compare two BED files",
  "Recommend an IWC workflow for RNA-seq differential expression",
];

/** A new conversation's opening: what Orbit is for, and a few things to try. */
function welcomePanel(me: Me): HTMLElement | undefined {
  const pane = document.getElementById("chat-pane");
  const input = document.getElementById("input") as HTMLTextAreaElement | null;
  const send = document.getElementById("send-btn");
  if (!pane || !input || !send) return undefined;
  const panel = make("div");
  panel.id = "welcome";
  const mark = make("div", "welcome-logo");
  mark.innerHTML = ORBIT_LOGO;
  panel.append(
    mark,
    make("p", "welcome-line", `Ask about your histories, run tools and workflows, and keep notes on ${new URL(me.galaxyUrl).host}.`),
  );
  const examples = make("div", "welcome-examples");
  for (const text of EXAMPLES) {
    const button = make("button", "welcome-example", text);
    button.addEventListener("click", () => {
      input.value = text;
      input.dispatchEvent(new Event("input"));
      send.click();
    });
    examples.append(button);
  }
  panel.append(examples);
  pane.append(panel);
  return panel;
}

function sidebar(list: Listed[], current: string): HTMLElement {
  const nav = make("nav");
  nav.id = "conversations";
  const fresh = make("button", "new-conversation", "+ New conversation");
  fresh.addEventListener("click", () => void newConversation());
  nav.append(fresh, make("div", "section-label", "Conversations"));
  const items = make("div", "items");
  for (const conversation of list) {
    const link = make("a", "item");
    link.href = `/c/${conversation.id}`;
    const title = conversation.title ?? "New conversation";
    link.title = title;
    link.append(make("span", "item-title", title), make("span", "item-when", when(conversation.lastActiveAt)));
    if (conversation.id === current) link.setAttribute("aria-current", "page");
    items.append(link);
  }
  nav.append(items);
  return nav;
}

async function start(): Promise<void> {
  const me = await api<Me>("/api/me");
  const list = await api<Listed[]>("/api/conversations");
  const current = location.pathname.match(/^\/c\/([0-9a-f-]{36})$/)?.[1];
  if (!current) {
    // Pick up where the user left off, or start their first conversation.
    if (list[0]) open(list[0].id);
    else await newConversation();
    return;
  }
  document.getElementById("frame")!.prepend(sidebar(list, current));
  document.body.prepend(masthead(me));
  const app = document.getElementById("app")!;
  await mountOrbitBrowser(app, {
    theme: "dark",
    galaxyRoot: me.galaxyUrl,
    pyodideURL: "",
    // The conversation lives on the host; the shell's own Galaxy history lookup has nothing to find.
    launch: async () => ({ historyId: current }),
    createWorker: () =>
      socketWorker({
        url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
        conversationId: current,
        moved: open,
        signedOut: signIn,
        submitted: (text) => {
          welcome?.remove();
          // The host titles a conversation from its first message only; follow it.
          const entry = list.find((c) => c.id === current);
          if (!entry || entry.title) return;
          entry.title = text.trim().split("\n")[0]!;
          const title = document.querySelector('#conversations .item[aria-current="page"] .item-title');
          if (title) title.textContent = entry.title;
        },
      }),
  });
  const welcome = list.find((c) => c.id === current)?.title ? undefined : welcomePanel(me);
  // The host picks the model, so the shell's switcher has nothing to offer: name the model instead.
  const picker = document.getElementById("model-btn");
  if (picker && me.model) {
    const label = make("span", "footer-control", me.model);
    label.id = "model-label";
    label.title = "The model Orbit runs on here";
    picker.replaceWith(label);
  }
}

void start();
