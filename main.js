/**
 * main.js — Electron main process
 * ---------------------------------
 * Responsibilities:
 *  1. Create the application window.
 *  2. Build the native application menu (File / View / Researcher / Help).
 *  3. Handle file management (open / save / export) over IPC.
 *  4. Spawn and talk to the Python "researcher" sidecar over stdio (JSON-RPC style).
 *
 * Security model:
 *  - contextIsolation: true  -> renderer never touches Node directly
 *  - nodeIntegration: false  -> renderer is a normal sandboxed web page
 *  - all privileged work goes through preload.js + ipcMain handlers below
 */

const { app, BrowserWindow, Menu, ipcMain, dialog } = require("electron")
const path = require("node:path")
const fs = require("node:fs/promises")
const { spawn } = require("node:child_process")

const isDev = process.argv.includes("--dev")

/** @type {BrowserWindow | null} */
let mainWindow = null

/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
let pyProc = null

/* ------------------------------------------------------------------ *
 *  Python sidecar
 * ------------------------------------------------------------------ */

// Pending requests keyed by id -> resolve/reject of a Promise.
const pending = new Map()
let rpcId = 0

function pythonScriptPath() {
  // In a packaged app the python folder is copied into resources/.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "python", "server.py")
  }
  return path.join(__dirname, "python", "server.py")
}

function startPython() {
  const pythonBin = process.platform === "win32" ? "python" : "python3"
  try {
    pyProc = spawn(pythonBin, [pythonScriptPath()], {
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (err) {
    console.error("[main] Failed to spawn Python:", err)
    return
  }

  let buffer = ""
  pyProc.stdout.on("data", (chunk) => {
    buffer += chunk.toString()
    // The protocol is newline-delimited JSON messages.
    let idx
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        // Non-JSON stdout (e.g. library logging) — forward as a log.
        if (mainWindow) mainWindow.webContents.send("python:log", line)
        continue
      }
      const entry = pending.get(msg.id)
      if (entry) {
        pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(msg.error))
        else entry.resolve(msg.result)
      }
    }
  })

  pyProc.stderr.on("data", (chunk) => {
    const text = chunk.toString()
    console.error("[python]", text)
    if (mainWindow) mainWindow.webContents.send("python:log", text)
  })

  pyProc.on("exit", (code) => {
    console.warn("[main] Python sidecar exited with code", code)
    pyProc = null
    // Reject any in-flight requests so the UI does not hang forever.
    for (const [, entry] of pending) {
      entry.reject(new Error("Python sidecar stopped. Is Python 3 installed?"))
    }
    pending.clear()
  })
}

/**
 * Call a method on the Python sidecar and await its JSON result.
 * @param {string} method
 * @param {object} params
 */
function callPython(method, params) {
  return new Promise((resolve, reject) => {
    if (!pyProc) {
      reject(new Error("Python sidecar is not running. Install Python 3 + requirements.txt."))
      return
    }
    const id = ++rpcId
    pending.set(id, { resolve, reject })
    pyProc.stdin.write(JSON.stringify({ id, method, params }) + "\n")
    // Safety timeout so a hung module never freezes the UI.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error("The researcher module timed out."))
      }
    }, 120000)
  })
}

/* ------------------------------------------------------------------ *
 *  Window + Menu
 * ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: "#0f1020",
    title: "Dreamy Researcher",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses require(); keep it trusted & minimal
    },
  })

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"))
  if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" })

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

function buildMenu() {
  const send = (channel, payload) => () => mainWindow?.webContents.send(channel, payload)

  const template = [
    {
      label: "File",
      submenu: [
        { label: "New Notebook", accelerator: "CmdOrCtrl+N", click: send("menu:new") },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: send("menu:open") },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: send("menu:save") },
        { label: "Export…", accelerator: "CmdOrCtrl+Shift+E", click: send("menu:export") },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle Theme", accelerator: "CmdOrCtrl+T", click: send("menu:toggle-theme") },
        { type: "separator" },
        { label: "Language: English", click: send("menu:lang", "en") },
        { label: "اللغة: العربية", click: send("menu:lang", "ar") },
        { label: "Langue: Français", click: send("menu:lang", "fr") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggledevtools" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Run",
      submenu: [
        { label: "Run All Cells", accelerator: "CmdOrCtrl+Shift+Enter", click: send("menu:run-all") },
        { label: "Restart Kernel", accelerator: "CmdOrCtrl+Shift+R", click: send("menu:restart") },
      ],
    },
    {
      label: "Researcher",
      submenu: [
        { label: "Preprocess Dataset", click: send("menu:run", "preprocess") },
        { label: "Visualize", click: send("menu:run", "visualize") },
        { label: "Explain (SHAP / LIME / Grad-CAM)", click: send("menu:run", "explain") },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About Dreamy Researcher",
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "About",
              message: "Dreamy Researcher",
              detail:
                "A lightweight multilingual notebook for researchers.\nMonaco editor + Python ML sidecar.\nMIT Licensed.",
            }),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------------------ *
 *  IPC: file management
 * ------------------------------------------------------------------ */

ipcMain.handle("file:open", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Notebook / Data", extensions: ["dnb", "json", "csv", "txt", "py", "js", "md"] },
      { name: "All Files", extensions: ["*"] },
    ],
  })
  if (res.canceled || !res.filePaths[0]) return null
  const filePath = res.filePaths[0]
  const content = await fs.readFile(filePath, "utf-8")
  return { filePath, content }
})

ipcMain.handle("file:save", async (_e, { filePath, content }) => {
  let target = filePath
  if (!target) {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: "notebook.dnb",
      filters: [{ name: "Dreamy Notebook", extensions: ["dnb"] }],
    })
    if (res.canceled || !res.filePath) return null
    target = res.filePath
  }
  await fs.writeFile(target, content, "utf-8")
  return { filePath: target }
})

ipcMain.handle("file:export", async (_e, { content, defaultName }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || "export.html",
    filters: [
      { name: "HTML", extensions: ["html"] },
      { name: "Markdown", extensions: ["md"] },
      { name: "JSON", extensions: ["json"] },
    ],
  })
  if (res.canceled || !res.filePath) return null
  await fs.writeFile(res.filePath, content, "utf-8")
  return { filePath: res.filePath }
})

ipcMain.handle("file:read", async (_e, filePath) => {
  return fs.readFile(filePath, "utf-8")
})

/* ------------------------------------------------------------------ *
 *  IPC: researcher modules -> Python
 * ------------------------------------------------------------------ */

ipcMain.handle("research:run", async (_e, { method, params }) => {
  return callPython(method, params)
})

ipcMain.handle("research:status", async () => ({ running: pyProc !== null }))

/* ------------------------------------------------------------------ *
 *  App lifecycle
 * ------------------------------------------------------------------ */

app.whenReady().then(() => {
  startPython()
  buildMenu()
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  if (pyProc) pyProc.kill()
})
