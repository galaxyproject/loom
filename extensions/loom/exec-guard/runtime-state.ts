// Set by the bash sandbox layer when the OS sandbox is actually live for bash
// (false on unsupported platforms or a failed init). Lives in exec-guard, the
// lower layer, so the gate can query it without importing upward into the sandbox
// module. Layer 1 (write confinement) does NOT relax anything off this flag; it is
// kept here as the seam a future sound auto-allow (contained, recoverable
// unknown-bash) will read.
let sandboxActive = false;

export function setSandboxActive(active: boolean): void {
  sandboxActive = active;
}

export function isSandboxActive(): boolean {
  return sandboxActive;
}
