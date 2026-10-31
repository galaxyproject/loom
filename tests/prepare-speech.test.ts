import { describe, expect, it } from "vitest";
import { tarCommand } from "../app/scripts/prepare-speech.mjs";

describe("prepare-speech tarCommand", () => {
  it("uses whatever tar is on PATH off Windows", () => {
    expect(tarCommand("linux", {})).toBe("tar");
    expect(tarCommand("darwin", { SystemRoot: "C:\\Windows" })).toBe("tar");
  });

  it("names Windows' own bsdtar so a drive-letter path is not read as a host", () => {
    expect(tarCommand("win32", { SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\tar.exe");
    expect(tarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });
});
