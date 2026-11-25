/* =========================================================================
   renderer.js — the whole UI brain (runs in the sandboxed web page).
   Talks to the OS / Python only through window.api (see preload.js).
   ========================================================================= */

const state = {
  lang: "en",
  theme: "dark",
  filePath: null,
  fileType: null,
  cells: [], // { id, type: 'text'|'code', editor?, el, getValue() }
  dataset: { csv: null, name: null, path: null, sig: null, rows: 0, image: null, imageName: null },
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
  addCell("text", "# Welcome to Dreamy Researcher\nUse the **Researcher** panel on the left — no coding required.")
  addCell("code", "# Python scratch cell\nprint('Hello, researcher!')")
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
    ${type === "code" ? `<button class="cell-mini" data-cell-run>${t("runCell")}</button>` : ""}
    <button class="cell-mini" data-cell-del>${t("deleteCell")}</button>
  `
  el.appendChild(head)

  let cell
  if (type === "code") {
    const editorHost = document.createElement("div")
    editorHost.className = "cell-editor"
    el.appendChild(editorHost)

    const output = document.createElement("pre")
    output.className = "cell-output"
    el.appendChild(output)

    const media = document.createElement("div")
    media.className = "cell-media"
    el.appendChild(media)

    const editor = monaco.editor.create(editorHost, {
      value: initial,
      language: "python",
      theme: state.theme === "dark" ? "dreamy-dark" : "dreamy-light",
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "var(--font-mono)",
      automaticLayout: true,
      scrollBeyondLastLine: false,
      scrollbar: { vertical: "auto", horizontal: "auto" },
      padding: { top: 10, bottom: 10 },
    })

    // Keep short cells fully visible instead of forcing users to scroll
    // inside the editor to see the beginning of their code.
    const resizeEditor = () => {
      const contentHeight = editor.getContentHeight()
      // Grow with the code, but cap very long cells so one cell cannot make the
      // whole notebook enormous — they scroll inside the editor instead.
      const height = Math.min(560, Math.max(80, contentHeight))
      editorHost.style.height = `${height}px`
      editor.layout({ width: editorHost.clientWidth, height })
    }
    editor.onDidContentSizeChange(resizeEditor)
    requestAnimationFrame(resizeEditor)

    cell = { id, type, el, editor, output, media, getValue: () => editor.getValue() }
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

/** Show plots returned by the Python sidecar under a code cell. */
function renderCellImages(cell, images) {
  if (!cell.media) return
  cell.media.innerHTML = ""
  for (const src of images || []) {
    const img = document.createElement("img")
    img.src = src
    img.alt = t("image")
    img.loading = "lazy"
    cell.media.appendChild(img)
  }
}

/** Fast, deterministic fingerprint so Python can detect dataset changes. */
function datasetSignature(csv) {
  let hash = 2166136261
  for (let i = 0; i < csv.length; i++) {
    hash ^= csv.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${(hash >>> 0).toString(16)}-${csv.length}`
}

/** Descriptor sent with every cell run; Python installs it as `df`. */
function datasetContext() {
  const ds = state.dataset
  if (!ds.csv) return null
  const ctx = { name: ds.name, sig: ds.sig }
  // Prefer the real path (Python reads the file once). After preprocessing the
  // cleaned CSV only exists in memory, so send its text instead.
  if (ds.path) ctx.path = ds.path
  else ctx.csv = ds.csv
  return ctx
}

/** Run a Python code cell in the persistent researcher sidecar. */
async function runCodeCell(cell) {
  const code = cell.getValue()
  cell.output.textContent = ""
  renderCellImages(cell, [])
  cell.output.innerHTML = `<span class="spinner"></span> ${t("running")}`
  try {
    const result = await window.api.runResearch("execute_code", { code, dataset: datasetContext() })
    const images = result.images || []
    // Don't show "(no output)" when the cell produced a plot instead.
    cell.output.textContent = result.output === "(no output)" && images.length ? "" : result.output || "(no output)"
    renderCellImages(cell, images)
    cell.output.scrollIntoView({ behavior: "smooth", block: "nearest" })
  } catch (err) {
    cell.output.textContent = "⚠ " + friendlyError(err)
    cell.output.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }
}

/** Execute every code cell in document order, preserving Python state between cells. */
async function runAllCodeCells() {
  const codeCells = state.cells.filter((cell) => cell.type === "code")
  for (const cell of codeCells) await runCodeCell(cell)
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
  const isExplain = method === "explain"
  const technique = isExplain ? document.getElementById("xai-tech").value : null

  // Each module has different input requirements.
  if (method === "preprocess" || method === "visualize") {
    if (!state.dataset.csv) {
      setResults(`<p class="muted">${t("noDataset")} ${t("loadData")}</p>`)
      return
    }
  } else if (isExplain) {
    if (technique === "gradcam") {
      if (!state.dataset.image) {
        setResults(
          `<div class="results-card"><h4>${t("explainability")}</h4><p>${t("gradcamNeedsImage")}</p></div>`,
        )
        return
      }
    } else if (!state.dataset.csv) {
      setResults(`<p class="muted">${t("noDataset")} ${t("loadData")}</p>`)
      return
    }
  }

  setResults(`<p><span class="spinner"></span> ${t("running")}</p>`)

  try {
    let params = { csv: state.dataset.csv }

    if (method === "preprocess") {
      params.clean = document.getElementById("pp-clean").checked
      params.normalize = document.getElementById("pp-norm").checked
      params.augment = document.getElementById("pp-aug").checked
    } else if (method === "visualize") {
      params.kind = document.getElementById("viz-kind").value
    } else if (isExplain) {
      // Grad-CAM needs an image, SHAP/LIME need the tabular dataset.
      params =
        technique === "gradcam"
          ? { technique: "gradcam", image: state.dataset.image }
          : { csv: state.dataset.csv, technique }
    }

    const res = await window.api.runResearch(method, params)
    renderModuleResult(method, res)
  } catch (err) {
    setResults(
      `<div class="results-card"><h4>⚠ ${t("error")}</h4><p>${escapeHtml(friendlyError(err))}</p></div>`,
    )
  }
}

/** Strip Electron's IPC wrapper so users see the actual Python error. */
function friendlyError(err) {
  const message = String(err && err.message ? err.message : err)
  return message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "")
}

function renderModuleResult(method, res) {
  if (method === "preprocess") {
    // Replace working dataset with the cleaned one so the next module benefits.
    if (res.csv) {
      setDataset(res.csv, state.dataset.name, null)
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
        <button class="btn" data-action="save-dataset">${t("saveData")}</button>
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
  if (state.fileType === "py") {
    return state.cells.filter((c) => c.type === "code").map((c) => c.getValue()).join("\n\n")
  }
  if (state.fileType === "ipynb") {
    return JSON.stringify({
      cells: state.cells.map((c) => ({
        cell_type: c.type === "text" ? "markdown" : "code",
        metadata: {},
        source: c.getValue().split("\n").map((line, index, lines) => line + (index < lines.length - 1 ? "\n" : "")),
        ...(c.type === "code" ? { outputs: [], execution_count: null } : {}),
      })),
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python" } },
      nbformat: 4,
      nbformat_minor: 5,
    }, null, 2)
  }
  return JSON.stringify(
    { version: 1, lang: state.lang, cells: state.cells.map((c) => ({ type: c.type, value: c.getValue() })) },
    null,
    2,
  )
}

function loadNotebook(content, filePath = "") {
  const extension = filePath.split(".").pop().toLowerCase()
  state.fileType = extension
  state.cells.slice().forEach((c) => removeCell(c.id))

  // A Python source file is shown as one editable, runnable code cell.
  if (extension === "py") {
    addCell("code", content)
    return
  }

  try {
    const data = JSON.parse(content)
    // Jupyter notebooks store source as arrays of lines and distinguish
    // markdown from executable code. Convert them to Dreamy cells.
    if (extension === "ipynb" || Array.isArray(data.cells) && data.nbformat) {
      ;(data.cells || []).forEach((c) => {
        const source = Array.isArray(c.source) ? c.source.join("") : String(c.source || "")
        addCell(c.cell_type === "markdown" ? "text" : "code", source)
      })
      if (!data.cells || data.cells.length === 0) addCell("code", "")
      return
    }
    // Dreamy's own .dnb format.
    if (Array.isArray(data.cells)) {
      data.cells.forEach((c) => addCell(c.type === "text" ? "text" : "code", c.value || ""))
      return
    }
    addCell("code", content)
  } catch {
    // Plain text and other source files are treated as one runnable cell.
    addCell("code", content)
  }
}

async function doNew() {
  state.cells.slice().forEach((c) => removeCell(c.id))
  state.filePath = null
  state.fileType = "dnb"
  setStatusFile()
  addCell("text", "# New notebook")
}

/** Route a file chosen from the toolbar: CSVs become the dataset, others a notebook. */
function handleOpenedFile(res) {
  if (!res) return
  const name = res.filePath.split(/[/\\]/).pop()
  if (name.toLowerCase().endsWith(".csv")) {
    setDataset(res.content, name, res.filePath)
    showDatasetLoaded()
    return
  }
  state.filePath = res.filePath
  loadNotebook(res.content, res.filePath)
  setStatusFile()
}

async function doOpen() {
  handleOpenedFile(await window.api.openFile())
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

async function exportProcessedDataset() {
  if (!state.dataset.csv) return

  const originalName = state.dataset.name || "dataset.csv"
  const baseName = originalName.replace(/\.csv$/i, "")
  await window.api.exportFile({
    content: state.dataset.csv,
    defaultName: `${baseName}-processed.csv`,
  })
}

/** Store the selected CSV and expose it to notebook code as `df`. */
function setDataset(csv, name, path = null) {
  state.dataset.csv = csv
  state.dataset.name = name
  state.dataset.path = window.api.isWeb ? null : path
  // The version prefix makes an explicit reload reset `df` even when the file
  // content is unchanged; the hash detects actual data changes.
  state.dataset.sig = `${Date.now().toString(36)}-${datasetSignature(csv)}`
  state.dataset.rows = csv.trim() ? csv.trim().split("\n").length - 1 : 0
  updateDatasetInfo()
}

function showDatasetLoaded() {
  setResults(
    `<div class="results-card">
      <h4>${t("dataset")}</h4>
      <p>${t("loaded")}: ${escapeHtml(state.dataset.name)} — ${state.dataset.rows} ${t("rows")}</p>
      ${state.dataset.path ? `<p class="muted" style="word-break:break-all">${escapeHtml(state.dataset.path)}</p>` : ""}
      <p class="muted">${t("datasetHint")}</p>
    </div>`,
  )
}

async function loadDataset() {
  try {
    const res = await window.api.openFile()
    if (!res) return
    const name = res.filePath.split(/[/\\]/).pop()

    // This loader is only for tabular data. Images belong to Grad-CAM.
    if (!name.toLowerCase().endsWith(".csv")) {
      setResults(
        `<div class="results-card"><h4>${t("dataset")}</h4><p>${t("notCsv")}</p></div>`,
      )
      return
    }

    setDataset(res.content, name, res.filePath)
    showDatasetLoaded()
  } catch (err) {
    setResults(
      `<div class="results-card"><h4>⚠ ${t("error")}</h4><p>${escapeHtml(friendlyError(err))}</p></div>`,
    )
  }
}

/** Load a PNG/JPG for Grad-CAM. The image is sent as a data URI, not text. */
async function loadExplainImage() {
  try {
    const res = await window.api.openImage()
    if (!res) return
    state.dataset.image = res.dataUri
    state.dataset.imageName = res.name
    document.getElementById("xai-tech").value = "gradcam"
    updateDatasetInfo()
    setResults(
      `<div class="results-card"><h4>${t("image")}</h4><img alt="${escapeHtml(res.name)}" src="${res.dataUri}" /><p>${t("loaded")}: ${escapeHtml(res.name)}</p><p class="muted">${t("imageReady")}</p></div>`,
    )
  } catch (err) {
    setResults(
      `<div class="results-card"><h4>⚠ ${t("error")}</h4><p>${escapeHtml(friendlyError(err))}</p></div>`,
    )
  }
}

function updateDatasetInfo() {
  const el = document.getElementById("dataset-info")
  const hint = document.getElementById("dataset-hint")
  const saveButton = document.getElementById("save-dataset")
  if (state.dataset.csv) {
    el.textContent = `${t("loaded")}: ${state.dataset.name} — ${state.dataset.rows} ${t("rows")}`
    if (saveButton) saveButton.disabled = false
    if (hint) hint.hidden = false
  } else {
    el.textContent = t("noDataset")
    if (saveButton) saveButton.disabled = true
    if (hint) hint.hidden = true
  }

  const imageEl = document.getElementById("image-info")
  if (imageEl) {
    imageEl.textContent = state.dataset.image
      ? `${t("loaded")}: ${state.dataset.imageName}`
      : t("noImage")
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
    else if (a === "export-dataset" || a === "save-dataset") exportProcessedDataset()
    else if (a === "add-text") addCell("text", "")
    else if (a === "add-code") addCell("code", "")
    else if (a === "run-all") runAllCodeCells()
    else if (a === "load-data") loadDataset()
    else if (a === "load-image") loadExplainImage()
    return
  }
  const runEl = e.target.closest("[data-run]")
  if (runEl) runModule(runEl.dataset.run)
})

document.getElementById("lang-select").addEventListener("change", (e) => applyLanguage(e.target.value))
document.getElementById("theme-toggle").addEventListener("click", toggleTheme)

// Drag the divider to resize the results panel without changing the app window.
const layoutEl = document.querySelector(".layout")
const splitterEl = document.getElementById("results-splitter")
let resizingResults = false
splitterEl.addEventListener("pointerdown", (event) => {
  resizingResults = true
  splitterEl.setPointerCapture(event.pointerId)
  splitterEl.classList.add("active")
})
splitterEl.addEventListener("pointermove", (event) => {
  if (!resizingResults) return
  const rect = layoutEl.getBoundingClientRect()
  const width = Math.max(260, Math.min(620, rect.right - event.clientX))
  layoutEl.style.gridTemplateColumns = `264px minmax(280px, 1fr) 8px ${width}px`
})
const stopResizing = () => {
  resizingResults = false
  splitterEl.classList.remove("active")
}
splitterEl.addEventListener("pointerup", stopResizing)
splitterEl.addEventListener("pointercancel", stopResizing)
splitterEl.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
  const current = parseInt(getComputedStyle(layoutEl).gridTemplateColumns.split(" ").pop(), 10)
  const next = current + (event.key === "ArrowLeft" ? 20 : -20)
  layoutEl.style.gridTemplateColumns = `264px minmax(280px, 1fr) 8px ${Math.max(260, Math.min(620, next))}px`
})

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
