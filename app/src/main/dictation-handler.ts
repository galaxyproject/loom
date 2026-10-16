import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { createIdempotentIpc } from "./ipc-registry.js";
import { DictationService } from "./dictation-service.js";

export function registerDictationIpc(window: BrowserWindow): void {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, "speech")
    : path.join(app.getAppPath(), ".speech-stage", "speech");
  const service = new DictationService({
    binary: path.join(root, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"),
    model: path.join(root, "ggml-base.en-q5_1.bin"),
  });
  const checkSender = (event: IpcMainInvokeEvent) => {
    if (
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Dictation is available only in the main Orbit window.");
  };
  const ipc = createIdempotentIpc(ipcMain);
  ipc.handle("dictation:status", (event) => {
    checkSender(event);
    return service.status();
  });
  ipc.handle("dictation:transcribe", (event, id: unknown, wav: unknown) => {
    checkSender(event);
    return service.transcribe(id, wav);
  });
  ipc.handle("dictation:cancel", (event, id: unknown) => {
    checkSender(event);
    service.cancel(id);
  });
  window.webContents.once("destroyed", () => service.dispose());
  const stop = () => service.dispose();
  app.on("before-quit", stop);
  window.once("closed", () => app.removeListener("before-quit", stop));
}
