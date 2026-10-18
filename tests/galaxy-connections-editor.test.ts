// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { GalaxyConnectionsEditor } from "../app/src/renderer/galaxy-connections-editor";
import { UNCHANGED_SECRET } from "../shared/config-secrets.js";

describe("Galaxy connection preferences", () => {
  let editor: GalaxyConnectionsEditor;
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  const select = (value: string) => {
    const el = document.getElementById("prefs-galaxy-profile") as HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new Event("change"));
  };
  beforeEach(() => {
    document.body.innerHTML =
      '<select id="prefs-galaxy-profile"></select><input id="prefs-galaxy-default" type="checkbox"><input id="prefs-galaxy-name"><button id="prefs-galaxy-add"></button><div id="prefs-galaxy-error"></div><input id="url"><input id="key">';
    editor = new GalaxyConnectionsEditor(input("url"), input("key"), () => {});
    editor.hydrate({
      active: "us",
      profiles: {
        us: { url: "https://usegalaxy.org", hasApiKey: true },
        eu: { url: "https://usegalaxy.eu", hasApiKey: true },
      },
    });
  });
  it("preserves every stored profile and keeps typed keys associated with their own profile", () => {
    input("key").value = "replacement-us";
    select("eu");
    expect(input("key").value).toBe("");
    input("prefs-galaxy-default").click();
    expect(editor.value()).toEqual({
      active: "eu",
      profiles: {
        us: { url: "https://usegalaxy.org", apiKey: "replacement-us" },
        eu: { url: "https://usegalaxy.eu", apiKey: UNCHANGED_SECRET },
      },
    });
  });
  it("adds an independent connection without replacing the default or existing keys", () => {
    input("prefs-galaxy-name").value = "australia";
    document.getElementById("prefs-galaxy-add")!.click();
    input("url").value = "https://usegalaxy.org.au";
    input("key").value = "au-key";
    expect(editor.value().active).toBe("us");
    expect(Object.keys(editor.value().profiles)).toEqual(["us", "eu", "australia"]);
    expect(editor.value().profiles.eu.apiKey).toBe(UNCHANGED_SECRET);
  });
});
