/**
 * preload.js — secure bridge between the sandboxed renderer and the main process.
 *
 * Everything the UI is allowed to do is whitelisted here and exposed on
 * `window.api`. The renderer never sees `ipcRenderer`, `fs`, or `child_process`
 * directly, which keeps the attack surface tiny.
 */

const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("api", {
  // ---- File management ----
  openFile: () => ipcRenderer.invoke("file:open"),
  openImage: () => ipcRenderer.invoke("file:open-image"),
  saveFile: (payload) => ipcRenderer.invoke("file:save", payload),
  exportFile: (payload) => ipcRenderer.invoke("file:export", payload),
  readFile: (filePath) => ipcRenderer.invoke("file:read", filePath),

  // ---- Researcher modules (Python sidecar) ----
  runResearch: (method, params) => ipcRenderer.invoke("research:run", { method, params }),
  researchStatus: () => ipcRenderer.invoke("research:status"),

  // ---- Menu events coming FROM the native menu ----
  onMenu: (handler) => {
    const channels = [
      "menu:new",
      "menu:open",
      "menu:save",
      "menu:export",
      "menu:toggle-theme",
      "menu:lang",
      "menu:run",
    ]
    const listeners = channels.map((ch) => {
      const fn = (_e, payload) => handler(ch, payload)
      ipcRenderer.on(ch, fn)
      return [ch, fn]
    })
    // return an unsubscribe function
    return () => listeners.forEach(([ch, fn]) => ipcRenderer.removeListener(ch, fn))
  },

  // ---- Streaming logs from Python ----
  onPythonLog: (handler) => {
    const fn = (_e, line) => handler(line)
    ipcRenderer.on("python:log", fn)
    return () => ipcRenderer.removeListener("python:log", fn)
  },
})
