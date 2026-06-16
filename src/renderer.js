/* =========================================================================
   renderer.js — the whole UI brain (runs in the sandboxed web page).
   Talks to the OS / Python only through window.api (see preload.js).
   ========================================================================= */

const state = {
  lang: "en",
  theme: "dark",
  filePath: null,
  cells: [], // { id, type: 'text'|'code', editor?, el, getValue() }
  dataset: { csv: null, name: null, rows: 0, image: null },
  monacoReady: false,
}

let cellSeq = 0

/* ----------------------------------------------------------------------- *
 *  Monaco bootstrap (loaded via AMD loader from local node_modules)
 * ----------------------------------------------------------------------- */
require.config({ paths: { vs: "../node_modules/monaco-editor/min/vs" } })
require(["vs/editor/editor.main"], () => {
  defineMonacoThemes()
  state.monacoReady = true
  // Seed the notebook with a welcome text cell + a code cell.
  addCell("text", "# Welcome to Dreamy Researcher\nUse the **Researcher** panel on the left — no coding required.\nOr write Python below and press **Shift+Enter** to run it.")
  addCell("code", 'print("hello world")\n\n# Variables persist between cells, just like Colab.\nx = 21\nx * 2')
})

function defineMonacoThemes() {
  monaco.editor.defineTheme("dreamy-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#28241d",
      "editor.lineHighlightBackground": "#322d24",
      "editorLineNumber.foreground": "#6b6354",
      "editorCursor.foreground": "#e08a5c",
    },
  })
  monaco.editor.defineTheme("dreamy-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#fbf9f4",
      "editor.lineHighlightBackground": "#f1ece2",
      "editorLineNumber.foreground": "#b3a890",
      "editorCursor.foreground": "#c2683f",
    },
  })
  applyMonacoTheme()
}

function applyMonacoTheme() {
  if (window.monaco && state.monacoReady !== undefined && window.monaco.editor) {
    monaco.editor.setTheme(state.theme === "dark" ? "dreamy-dark" : "dreamy-light")
  }
}

/* ----------------------------------------------------------------------- *
 *  Cells (notebook)
 * ----------------------------------------------------------------------- */
const notebookEl = document.getElementById("notebook")

function addCell(type, initial = "") {
  const id = ++cellSeq
  const el = document.createElement("div")
  el.className = "cell"
  el.dataset.id = String(id)

  const head = document.createElement("div")
  head.className = "cell-head"
  head.innerHTML = `
    <span class="cell-tag">${type === "code" ? "CODE" : "TEXT"}</span>
    <span class="spacer"></span>
    ${type === "code" ? `<button class="cell-mini run" data-cell-run>▶ ${t("runCell")}</button>` : ""}
    <button class="cell-mini" data-cell-del>${t("deleteCell")}</button>
  `
  el.appendChild(head)

  let cell
  if (type === "code") {
    // A horizontal row: [In [n]] gutter + editor.
    const codeRow = document.createElement("div")
    codeRow.className = "code-row"

    const gutter = document.createElement("div")
    gutter.className = "run-gutter"
    const runLabel = document.createElement("span")
    runLabel.className = "run-count"
    runLabel.textContent = "[ ]"
    gutter.appendChild(runLabel)
    codeRow.appendChild(gutter)

    const editorHost = document.createElement("div")
    editorHost.className = "cell-editor"
    editorHost.style.height = "120px"
    codeRow.appendChild(editorHost)
    el.appendChild(codeRow)

    // Output block with a copy button (hidden until the cell runs).
    const outputWrap = document.createElement("div")
    outputWrap.className = "cell-output-wrap"
    outputWrap.hidden = true
    const copyBtn = document.createElement("button")
    copyBtn.className = "copy-btn"
    copyBtn.textContent = t("copy")
    copyBtn.hidden = true
    const output = document.createElement("pre")
    output.className = "cell-output"
    outputWrap.appendChild(copyBtn)
    outputWrap.appendChild(output)
    el.appendChild(outputWrap)

    const editor = monaco.editor.create(editorHost, {
      value: initial,
      language: "python",
      theme: state.theme === "dark" ? "dreamy-dark" : "dreamy-light",
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "var(--font-mono)",
      automaticLayout: true,
      scrollBeyondLastLine: false,
      lineNumbers: "off",
      padding: { top: 10, bottom: 10 },
    })

    cell = { id, type, el, editor, output, outputWrap, copyBtn, runLabel, getValue: () => editor.getValue() }

    // Colab-style: Shift+Enter / Ctrl+Enter runs the cell.
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => runCodeCell(cell))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCodeCell(cell))

    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(output.textContent)
        copyBtn.textContent = t("copied")
        setTimeout(() => (copyBtn.textContent = t("copy")), 1200)
      } catch {
        /* clipboard unavailable */
      }
    })
  } else {
    const text = document.createElement("div")
    text.className = "cell-text"
    text.contentEditable = "true"
    text.dataset.placeholder = t("textPlaceholder")
    text.textContent = initial
    el.appendChild(text)
    cell = { id, type, el, text, getValue: () => text.textContent }
  }

  head.querySelector("[data-cell-del]").addEventListener("click", () => removeCell(id))
  const runBtn = head.querySelector("[data-cell-run]")
  if (runBtn) runBtn.addEventListener("click", () => runCodeCell(cell))

  state.cells.push(cell)
  notebookEl.appendChild(el)
  return cell
}

function removeCell(id) {
  const idx = state.cells.findIndex((c) => c.id === id)
  if (idx === -1) return
  const cell = state.cells[idx]
  if (cell.editor) cell.editor.dispose()
  cell.el.remove()
  state.cells.splice(idx, 1)
}

/**
 * Run a code cell by sending its Python source to the persistent kernel in the
 * Python sidecar (just like Colab). State persists across cells. We capture
 * stdout + the value of the final expression and render it as copyable output.
 */
async function runCodeCell(cell) {
  const code = cell.getValue()
  cell.outputWrap.hidden = false
  cell.output.textContent = ""
  cell.runLabel.textContent = "[*]"
  cell.output.innerHTML = `<span class="spinner"></span> ${t("running")}`
  cell.copyBtn.hidden = true
  try {
    const res = await window.api.runResearch("execute", { code })
    let text = res.stdout || ""
    if (res.value !== null && res.value !== undefined) {
      text += (text && !text.endsWith("\n") ? "\n" : "") + res.value
    }
    if (!text) text = "(no output)"
    cell.output.textContent = text
    cell.output.classList.toggle("err", !res.ok)
    cell.runLabel.textContent = `[${res.count}]`
    cell.copyBtn.hidden = false
  } catch (err) {
    cell.output.textContent = "⚠ " + err.message
    cell.output.classList.add("err")
    cell.runLabel.textContent = "[!]"
  }
}

/** Run every code cell from top to bottom (Colab "Run all"). */
async function runAllCells() {
  for (const cell of state.cells) {
    if (cell.type === "code") {
      // eslint-disable-next-line no-await-in-loop
      await runCodeCell(cell)
    }
  }
}

/** Restart the Python kernel: wipe all variables defined in code cells. */
async function restartKernel() {
  try {
    await window.api.runResearch("reset_kernel", {})
    state.cells.forEach((c) => {
      if (c.type === "code") {
        c.runLabel.textContent = "[ ]"
        c.outputWrap.hidden = true
        c.output.textContent = ""
      }
    })
  } catch {
    /* sidecar offline — nothing to reset */
  }
}

/* ----------------------------------------------------------------------- *
 *  Researcher modules → Python sidecar
 * ----------------------------------------------------------------------- */
const resultsBody = document.getElementById("results-body")

function setResults(html) {
  resultsBody.innerHTML = html
}
function appendResult(html) {
  resultsBody.insertAdjacentHTML("afterbegin", html)
}

async function runModule(method) {
  if (method !== "explain-gradcam" && method !== "explain" && !state.dataset.csv && method !== "explainImg") {
    if (!state.dataset.csv) {
      setResults(`<p class="muted">${t("noDataset")} ${t("loadData")}</p>`)
      return
    }
  }
  setResults(`<p><span class="spinner"></span> ${t("running")}</p>`)

  try {
    let params = { csv: state.dataset.csv }
    let rpc = method

    if (method === "preprocess") {
      params.clean = document.getElementById("pp-clean").checked
      params.normalize = document.getElementById("pp-norm").checked
      params.augment = document.getElementById("pp-aug").checked
    } else if (method === "visualize") {
      params.kind = document.getElementById("viz-kind").value
    } else if (method === "explain") {
      const tech = document.getElementById("xai-tech").value
      params.technique = tech
      if (tech === "gradcam") {
        params = { technique: "gradcam", image: state.dataset.image }
      }
    }

    const res = await window.api.runResearch(rpc, params)
    renderModuleResult(method, res)
  } catch (err) {
    setResults(`<div class="results-card"><h4>⚠ Error</h4><p>${escapeHtml(err.message)}</p></div>`)
  }
}

function renderModuleResult(method, res) {
  if (method === "preprocess") {
    // Replace working dataset with the cleaned one so the next module benefits.
    if (res.csv) {
      state.dataset.csv = res.csv
      state.dataset.rows = res.summary.rows_after
      updateDatasetInfo()
    }
    const stepList = res.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")
    const cols = res.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")
    const rows = res.preview
      .map((r) => `<tr>${res.columns.map((c) => `<td>${escapeHtml(String(r[c]))}</td>`).join("")}</tr>`)
      .join("")
    setResults(`
      <div class="results-card">
        <h4>${t("preprocessing")}</h4>
        <p class="muted">${res.summary.rows_before}×${res.summary.cols_before} →
           <strong>${res.summary.rows_after}×${res.summary.cols_after}</strong></p>
        <ul>${stepList}</ul>
      </div>
      <div class="results-card">
        <h4>Preview</h4>
        <div style="overflow:auto"><table><thead><tr>${cols}</tr></thead><tbody>${rows}</tbody></table></div>
      </div>`)
  } else if (method === "visualize") {
    const cards = res.images
      .map((im) => `<div class="results-card"><h4>${escapeHtml(im.title)}</h4><img alt="${escapeHtml(im.title)}" src="${im.data}" /></div>`)
      .join("")
    setResults(cards)
  } else if (method === "explain") {
    let html = `<div class="results-card"><h4>${t("explainability")}</h4><p>${escapeHtml(res.text || "")}</p></div>`
    if (res.image) html += `<div class="results-card"><img alt="explanation" src="${res.image}" /></div>`
    if (res.ranking) {
      const max = Math.max(...res.ranking.map((r) => r.impact)) || 1
      html += `<div class="results-card"><h4>Feature impact</h4>${res.ranking
        .map((r) => `<div style="margin:6px 0"><span>${escapeHtml(r.feature)}</span>
          <div class="bar" style="width:${(r.impact / max) * 100}%"></div></div>`)
        .join("")}</div>`
    }
    if (res.contributions) {
      html += `<div class="results-card"><h4>LIME rules</h4>${res.contributions
        .map((c) => `<div style="margin:6px 0">${escapeHtml(c.rule)} <strong>(${c.weight.toFixed(3)})</strong></div>`)
        .join("")}</div>`
    }
    setResults(html)
  }
}

/* ----------------------------------------------------------------------- *
 *  File management
 * ----------------------------------------------------------------------- */
function serializeNotebook() {
  return JSON.stringify(
    {
      version: 1,
      lang: state.lang,
      cells: state.cells.map((c) => ({ type: c.type, value: c.getValue() })),
    },
    null,
    2,
  )
}

function loadNotebook(json) {
  try {
    const data = JSON.parse(json)
    state.cells.slice().forEach((c) => removeCell(c.id))
    ;(data.cells || []).forEach((c) => addCell(c.type, c.value))
  } catch {
    // If it isn't a notebook, treat content as a single code cell.
    addCell("code", json)
  }
}

async function doNew() {
  state.cells.slice().forEach((c) => removeCell(c.id))
  state.filePath = null
  setStatusFile()
  addCell("text", "# New notebook")
}

async function doOpen() {
  const res = await window.api.openFile()
  if (!res) return
  state.filePath = res.filePath
  loadNotebook(res.content)
  setStatusFile()
}

async function doSave() {
  const res = await window.api.saveFile({ filePath: state.filePath, content: serializeNotebook() })
  if (res) {
    state.filePath = res.filePath
    setStatusFile()
  }
}

async function doExport() {
  // Export a self-contained HTML version of the notebook.
  const body = state.cells
    .map((c) =>
      c.type === "text"
        ? `<section>${escapeHtml(c.getValue())}</section>`
        : `<pre><code>${escapeHtml(c.getValue())}</code></pre>`,
    )
    .join("\n")
  const html = `<!doctype html><meta charset="utf-8"><title>Notebook export</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:760px;margin:40px auto;line-height:1.65;color:#2c2722;background:#f3efe7}
pre{background:#fbf9f4;border:1px solid #e0d8c8;padding:12px;border-radius:10px;overflow:auto}</style>${body}`
  await window.api.exportFile({ content: html, defaultName: "notebook.html" })
}

async function loadDataset() {
  const res = await window.api.openFile()
  if (!res) return
  state.dataset.name = res.filePath.split(/[/\\]/).pop()
  if (state.dataset.name.toLowerCase().endsWith(".csv")) {
    state.dataset.csv = res.content
    state.dataset.rows = res.content.trim().split("\n").length - 1
  } else {
    // image (read as base64) for Grad-CAM — main returns text, so we wrap data URI
    state.dataset.image = res.content
  }
  updateDatasetInfo()
}

function updateDatasetInfo() {
  const el = document.getElementById("dataset-info")
  if (state.dataset.csv) {
    el.textContent = `${t("loaded")}: ${state.dataset.name} — ${state.dataset.rows} ${t("rows")}`
  } else {
    el.textContent = t("noDataset")
  }
}

/* ----------------------------------------------------------------------- *
 *  i18n + theme
 * ----------------------------------------------------------------------- */
function t(key) {
  return (window.I18N[state.lang] && window.I18N[state.lang][key]) || key
}

function applyLanguage(lang) {
  state.lang = lang
  const dict = window.I18N[lang]
  document.documentElement.lang = lang
  document.documentElement.dir = dict._dir
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n)
  })
  // refresh dynamic bits
  document.querySelectorAll(".cell-text").forEach((el) => (el.dataset.placeholder = t("textPlaceholder")))
  document.querySelectorAll("[data-cell-run]").forEach((el) => (el.textContent = t("runCell")))
  document.querySelectorAll("[data-cell-del]").forEach((el) => (el.textContent = t("deleteCell")))
  document.getElementById("lang-select").value = lang
  updateDatasetInfo()
  setStatusFile()
}

function applyTheme(theme) {
  state.theme = theme
  document.documentElement.dataset.theme = theme
  applyMonacoTheme()
}

function toggleTheme() {
  applyTheme(state.theme === "dark" ? "light" : "dark")
}

/* ----------------------------------------------------------------------- *
 *  Status bar
 * ----------------------------------------------------------------------- */
function setStatusFile() {
  const el = document.getElementById("status-file")
  el.textContent = state.filePath ? state.filePath.split(/[/\\]/).pop() : t("untitled")
}

async function refreshPyStatus() {
  const pill = document.getElementById("status-py")
  try {
    const { running } = await window.api.researchStatus()
    pill.textContent = running ? t("pyOnline") : t("pyOffline")
    pill.classList.toggle("offline", !running)
  } catch {
    pill.textContent = t("pyOffline")
    pill.classList.add("offline")
  }
}

/* ----------------------------------------------------------------------- *
 *  Wiring: toolbar, sidebar, menus
 * ----------------------------------------------------------------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

document.addEventListener("click", (e) => {
  const actionEl = e.target.closest("[data-action]")
  if (actionEl) {
    const a = actionEl.dataset.action
    if (a === "new") doNew()
    else if (a === "open") doOpen()
    else if (a === "save") doSave()
    else if (a === "export") doExport()
    else if (a === "add-text") addCell("text", "")
    else if (a === "add-code") addCell("code", "")
    else if (a === "run-all") runAllCells()
    else if (a === "restart") restartKernel()
    else if (a === "load-data") loadDataset()
    return
  }
  const runEl = e.target.closest("[data-run]")
  if (runEl) runModule(runEl.dataset.run)
})

document.getElementById("lang-select").addEventListener("change", (e) => applyLanguage(e.target.value))
document.getElementById("theme-toggle").addEventListener("click", toggleTheme)

// Native menu events forwarded from main.js
window.api.onMenu((channel, payload) => {
  switch (channel) {
    case "menu:new": doNew(); break
    case "menu:open": doOpen(); break
    case "menu:save": doSave(); break
    case "menu:export": doExport(); break
    case "menu:toggle-theme": toggleTheme(); break
    case "menu:lang": applyLanguage(payload); break
    case "menu:run": runModule(payload); break
    case "menu:run-all": runAllCells(); break
    case "menu:restart": restartKernel(); break
  }
})

window.api.onPythonLog((line) => console.log("[python]", line))

/* ----------------------------------------------------------------------- *
 *  Boot
 * ----------------------------------------------------------------------- */
applyTheme("light")
applyLanguage("en")
refreshPyStatus()
setInterval(refreshPyStatus, 5000)
