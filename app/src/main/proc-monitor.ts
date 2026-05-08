/**
 * Process monitor — polls descendants of the agent process and emits
 * live stats (CPU, memory, runtime) to the renderer. Linux/macOS only.
 * Stops polling when the descendant list is empty to save CPU.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserWindow } from "electron";

const execFileP = promisify(execFile);

export interface ProcInfo {
  pid: number;
  ppid: number;
  pcpu: number;
  pmem: number;
  rss: number; // KB on Linux, blocks(512B) on macOS — normalized to KB here
  etime: string; // "HH:MM:SS" or "DD-HH:MM:SS"
  command: string;
}

const POLL_INTERVAL_MS = 2500;
const MAX_COMMAND_LEN = 80;

export class ProcMonitor {
  private window: BrowserWindow;
  private getAgentPid: () => number | null;
  private timer: NodeJS.Timeout | null = null;
  private lastCount = 0;

  constructor(window: BrowserWindow, getAgentPid: () => number | null) {
    this.window = window;
    this.getAgentPid = getAgentPid;
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.window.isDestroyed()) {
      this.stop();
      return;
    }

    const agentPid = this.getAgentPid();
    if (!agentPid) {
      this.emit([]);
      return;
    }

    try {
      const procs = await this.collectDescendants(agentPid);
      this.emit(procs);
    } catch {
      // ps may briefly fail during process lifecycle transitions — ignore
    }
  }

  private emit(procs: ProcInfo[]): void {
    // Suppress emissions when the list has been empty for several ticks
    // (save renderer work) but always emit the first "empty" so the UI clears.
    if (procs.length === 0 && this.lastCount === 0) return;
    this.lastCount = procs.length;
    this.window.webContents.send("proc:update", procs);
  }

  /**
   * Walk the process tree rooted at agentPid, return all descendants with stats.
   * Excludes the agent itself.
   */
  private async collectDescendants(agentPid: number): Promise<ProcInfo[]> {
    return collectDescendantsOf(agentPid);
  }
}

/**
 * Standalone descendant walker — also used by AgentManager.abort() to
 * SIGTERM the brain's tool subprocesses on Stop.
 */
export async function collectDescendantsOf(agentPid: number): Promise<ProcInfo[]> {
  // Get all processes with their PID and PPID so we can walk the tree.
  // Note: macOS ps doesn't support `nlwp` (thread count) — don't request it.
  const { stdout: psOut } = await execFileP("ps", [
    "-ax",
    "-o",
    "pid=,ppid=,pcpu=,pmem=,rss=,etime=,comm=",
  ]);

  const all = new Map<number, ProcInfo>();
  for (const line of psOut.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Fields: pid ppid pcpu pmem rss etime command
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    let command = m[7].trim();
    if (command.length > MAX_COMMAND_LEN) {
      command = command.slice(0, MAX_COMMAND_LEN - 1) + "…";
    }
    all.set(pid, {
      pid,
      ppid,
      pcpu: parseFloat(m[3]) || 0,
      pmem: parseFloat(m[4]) || 0,
      rss: parseInt(m[5], 10) || 0,
      etime: m[6],
      command,
    });
  }

  // Walk descendants breadth-first from agentPid
  const descendants: ProcInfo[] = [];
  const queue = [agentPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const parent = queue.shift()!;
    if (seen.has(parent)) continue;
    seen.add(parent);
    for (const [pid, info] of all) {
      if (info.ppid === parent && pid !== agentPid) {
        descendants.push(info);
        queue.push(pid);
      }
    }
  }
  return descendants;
}
