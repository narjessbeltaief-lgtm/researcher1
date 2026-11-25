/* Browser implementation of the small window.api contract used by renderer.js. */
if (!window.api) {
  const webNotice = document.getElementById("web-notice")
  if (webNotice) webNotice.hidden = false

  const pendingWorker = new Map()
  let pythonWorker = null
  let workerRequestId = 0
  let workerQueue = Promise.resolve()

  function ensureWorker() {
    if (pythonWorker) return pythonWorker
    pythonWorker = new Worker("/src/web-python-worker.js")
    pythonWorker.addEventListener("message", ({ data }) => {
      const entry = pendingWorker.get(data.id)
      if (!entry) return
      pendingWorker.delete(data.id)
      clearTimeout(entry.timer)
      if (data.error) entry.reject(new Error(data.error))
      else entry.resolve(data.result)
    })
    pythonWorker.addEventListener("error", (event) => {
      const error = new Error(event.message || "The browser Python worker failed to start.")
      for (const entry of pendingWorker.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      pendingWorker.clear()
      pythonWorker.terminate()
      pythonWorker = null
    })
    return pythonWorker
  }

  function runBrowserPython(code, dataset) {
    const run = () => new Promise((resolve, reject) => {
      const worker = ensureWorker()
      const id = ++workerRequestId
      const timer = setTimeout(() => {
        pendingWorker.delete(id)
        worker.terminate()
        pythonWorker = null
        reject(new Error("This code cell took too long and was stopped. Try a smaller calculation."))
      }, 180_000)
      pendingWorker.set(id, { resolve, reject, timer })
      worker.postMessage({ id, code, dataset: dataset || {} })
    })
    const result = workerQueue.then(run, run)
    workerQueue = result.catch(() => {})
    return result
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement("input")
      input.type = "file"
      input.accept = accept
      input.hidden = true
      document.body.appendChild(input)
      const finish = (value) => {
        input.remove()
        resolve(value)
      }
      input.addEventListener("change", () => finish(input.files?.[0] || null), { once: true })
      input.addEventListener("cancel", () => finish(null), { once: true })
      input.click()
    })
  }

  async function fileAsText(file) {
    return file.text()
  }

  function fileAsDataUri(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error("Could not read the selected image."))
      reader.readAsDataURL(file)
    })
  }

  function download(content, name) {
    const blob = new Blob([content], { type: "application/octet-stream" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = String(name || "download")
    anchor.hidden = true
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return { filePath: anchor.download }
  }

  async function apiRequest(url, options) {
    const response = await fetch(url, options)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`)
    return payload
  }

  window.api = {
    isWeb: true,
    openFile: async () => {
      const file = await pickFile(".dnb,.ipynb,.json,.csv,.txt,.py,.js,.md")
      if (!file) return null
      return { filePath: file.name, content: await fileAsText(file) }
    },
    openImage: async () => {
      const file = await pickFile("image/png,image/jpeg,image/webp,image/bmp")
      if (!file) return null
      if (file.size > 20 * 1024 * 1024) throw new Error("Image is too large. Please use an image under 20 MB.")
      return { filePath: file.name, name: file.name, dataUri: await fileAsDataUri(file) }
    },
    saveFile: async ({ filePath, content }) => download(content, filePath || "notebook.dnb"),
    exportFile: async ({ content, defaultName }) => download(content, defaultName || "export.html"),
    readFile: async () => { throw new Error("Reading arbitrary paths is not available in a browser.") },
    runResearch: async (method, params) => {
      if (method === "execute_code") return runBrowserPython(params?.code, params?.dataset)
      return (await apiRequest("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }),
      })).result
    },
    researchStatus: async () => apiRequest("/api/status"),
    onMenu: () => () => {},
    onPythonLog: () => () => {},
  }
}
