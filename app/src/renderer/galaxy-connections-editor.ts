/** Preferences state for several named Galaxy accounts; keys stay masked. */
import { UNCHANGED_SECRET } from "../../../shared/config-secrets.js";

interface Profile {
  url: string;
  hasApiKey?: boolean;
  typedKey?: string;
}
export class GalaxyConnectionsEditor {
  private profiles: Record<string, Profile> = {};
  private active: string | null = null;
  private selected = "";
  private select = document.getElementById("prefs-galaxy-profile") as HTMLSelectElement;
  private useDefault = document.getElementById("prefs-galaxy-default") as HTMLInputElement;
  private name = document.getElementById("prefs-galaxy-name") as HTMLInputElement;
  constructor(
    private url: HTMLInputElement,
    private key: HTMLInputElement,
    private changed: (hadKey: boolean) => void,
  ) {
    this.select.addEventListener("change", () => {
      this.flush();
      this.selected = this.select.value;
      this.load();
    });
    this.useDefault.addEventListener("change", () => {
      if (this.useDefault.checked) this.active = this.selected;
      this.useDefault.checked = this.active === this.selected;
      this.flush();
      this.load();
    });
    document.getElementById("prefs-galaxy-add")!.addEventListener("click", () => {
      const name = this.name.value.trim();
      if (
        !/^[A-Za-z0-9._-]{1,64}$/.test(name) ||
        ["__proto__", "constructor", "prototype"].includes(name) ||
        Object.hasOwn(this.profiles, name)
      ) {
        document.getElementById("prefs-galaxy-error")!.textContent =
          "Choose a unique connection name using letters, digits, dots, dashes or underscores.";
        return;
      }
      this.flush();
      this.profiles[name] = { url: "", hasApiKey: false, typedKey: "" };
      this.selected = name;
      this.active ??= name;
      this.name.value = "";
      this.load();
      this.url.focus();
    });
  }
  hydrate(value?: {
    active: string | null;
    profiles: Record<string, { url: string; hasApiKey?: boolean }>;
  }): void {
    this.profiles = Object.fromEntries(
      Object.entries(value?.profiles ?? {}).map(([name, p]) => [name, { ...p, typedKey: "" }]),
    );
    this.active = value?.active ?? null;
    this.selected = this.active || Object.keys(this.profiles)[0] || "default";
    this.profiles[this.selected] ??= { url: "", hasApiKey: false, typedKey: "" };
    this.load();
  }
  private flush(): void {
    if (this.selected && this.profiles[this.selected]) {
      this.profiles[this.selected].url = this.url.value.trim();
      this.profiles[this.selected].typedKey = this.key.value;
    }
  }
  private load(): void {
    this.select.replaceChildren(
      ...Object.keys(this.profiles).map((name) => {
        const o = document.createElement("option");
        o.value = name;
        o.textContent = name + (name === this.active ? " (default for new work)" : "");
        return o;
      }),
    );
    this.select.value = this.selected;
    const p = this.profiles[this.selected];
    this.url.value = p.url;
    this.key.value = p.typedKey || "";
    this.key.placeholder = p.hasApiKey ? "•••••••• (unchanged)" : "Galaxy API key";
    this.useDefault.checked = this.selected === this.active;
    this.changed(Boolean(p.hasApiKey));
  }
  value(): { active: string | null; profiles: Record<string, { url: string; apiKey: string }> } {
    this.flush();
    const profiles = Object.fromEntries(
      Object.entries(this.profiles)
        .filter(([, p]) => p.url || p.hasApiKey || p.typedKey)
        .map(([name, p]) => [
          name,
          { url: p.url, apiKey: p.typedKey?.trim() || (p.hasApiKey ? UNCHANGED_SECRET : "") },
        ]),
    );
    return {
      active:
        this.active && profiles[this.active] ? this.active : (Object.keys(profiles)[0] ?? null),
      profiles,
    };
  }
  selectedName(): string {
    return this.selected;
  }
}
