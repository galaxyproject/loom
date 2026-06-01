// Runtime flag the auto-mode extension flips once the OS sandbox is actually
// live, read by the gate so it can relax the escape-shaped asks the sandbox
// backstops. Lives in exec-guard (the lower layer) so the gate never imports
// upward into auto-mode. Reflects the *real* state -- false on unsupported
// platforms or a failed init -- so the gate only relaxes when there's a wall.
let autoSandboxActive = false;

export function setAutoSandboxActive(active: boolean): void {
  autoSandboxActive = active;
}

export function isAutoSandboxActive(): boolean {
  return autoSandboxActive;
}
