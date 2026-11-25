#!/usr/bin/env node
"use strict"

const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")

const ROOT = __dirname
const HOST = process.env.HOST || "127.0.0.1"
const PORT = Number(process.env.PORT || 8080)
const MAX_BODY_BYTES = 30 * 1024 * 1024
const MAX_CSV_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_DATA_URI_CHARS = 28 * 1024 * 1024
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = Number(process.env.WEB_RATE_LIMIT || 20)
const PYTHON = process.env.DREAMY_PYTHON || (process.platform === "win32" ? "python" : "python3")
const ALLOWED_METHODS = new Set(["preprocess", "visualize", "explain"])
const rateBuckets = new Map()
const pending = new Map()
let rpcId = 0
let pyProc = null
let requestActive = false

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  res.end(JSON.stringify(value))
}

function pythonScriptPath() {
  return path.join(ROOT, "python", "server.py")
}

function startPython() {
  if (pyProc) return
  pyProc = spawn(PYTHON, [pythonScriptPath()], { stdio: ["pipe", "pipe", "pipe"] })
  let buffer = ""

  pyProc.stdout.on("data", (chunk) => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        console.warn("[python] non-protocol output:", line)
        continue
      }
      const entry = pending.get(message.id)
      if (!entry) continue
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(message.error))
      else entry.resolve(message.result)
    }
  })

  pyProc.stderr.on("data", (chunk) => console.error("[python]", chunk.toString().trimEnd()))
  pyProc.on("error", (error) => {
    console.error("[web] Could not start Python sidecar:", error.message)
    pyProc = null
    rejectPending(new Error("Could not start Python. Install Python 3 and python/requirements.txt."))
  })
  pyProc.on("exit", (code) => {
    console.error("[web] Python sidecar exited with code", code)
    pyProc = null
    rejectPending(new Error("Python sidecar stopped. Check Python and its requirements."))
  })
}

function rejectPending(error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
    entry.reject(error)
  }
  pending.clear()
}

function callPython(method, params) {
  return new Promise((resolve, reject) => {
    if (!pyProc || pyProc.killed || !pyProc.stdin.writable) {
      reject(new Error("Python sidecar is not running. Install Python 3 and python/requirements.txt."))
      return
    }
    const id = ++rpcId
    const timeoutMs = method === "explain" && params?.technique === "gradcam" ? 300_000 : 120_000
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error("The researcher module timed out."))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    pyProc.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (!error) return
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      clearTimeout(timer)
      reject(error)
    })
  })
}

function clientAddress(req) {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = req.headers["x-forwarded-for"]
    if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim()
  }
  return req.socket.remoteAddress || "unknown"
}

function checkRateLimit(req) {
  const now = Date.now()
  const address = clientAddress(req)
  let bucket = rateBuckets.get(address)
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 }
    rateBuckets.set(address, bucket)
  }
  bucket.count += 1
  if (rateBuckets.size > 10_000) {
    for (const [key, value] of rateBuckets) {
      if (now - value.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(key)
    }
  }
  return bucket.count <= RATE_LIMIT
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on("data", (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        reject(Object.assign(new Error("Request is too large (30 MB maximum)."), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (tooLarge) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }))
      }
    })
    req.on("error", reject)
  })
}

function allowedStaticFile(urlPath) {
  const routes = [
    ["/src/", path.join(ROOT, "src")],
    ["/node_modules/monaco-editor/min/", path.join(ROOT, "node_modules", "monaco-editor", "min")],
  ]
  for (const [prefix, directory] of routes) {
    if (!urlPath.startsWith(prefix)) continue
    let relative
    try {
      relative = decodeURIComponent(urlPath.slice(prefix.length))
    } catch {
      return null
    }
    const resolved = path.resolve(directory, relative)
    if (resolved === directory || resolved.startsWith(directory + path.sep)) return resolved
  }
  return null
}

function webCsp() {
  return [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "connect-src 'self' https://cdn.jsdelivr.net",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ")
}

async function serveStatic(req, res, urlPath) {
  const filename = allowedStaticFile(urlPath)
  if (!filename) return sendJson(res, 404, { error: "Not found" })

  let stat
  try {
    stat = await fs.promises.stat(filename)
    if (!stat.isFile()) throw new Error("Not a file")
  } catch {
    return sendJson(res, 404, { error: "Not found" })
  }

  const contentType = MIME_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream"
  const headers = {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": webCsp(),
  }
  if (filename.endsWith("index.html")) {
    const html = await fs.promises.readFile(filename, "utf8")
    const webHtml = html.replace(
      /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i,
      `<meta http-equiv="Content-Security-Policy" content="${webCsp()}" />`,
    )
    headers["Content-Length"] = Buffer.byteLength(webHtml)
    res.writeHead(200, headers)
    return res.end(req.method === "HEAD" ? undefined : webHtml)
  }
  res.writeHead(200, headers)
  if (req.method === "HEAD") return res.end()
  fs.createReadStream(filename).pipe(res)
}

const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  } catch {
    return sendJson(res, 400, { error: "Invalid request URL." })
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
    res.writeHead(302, { Location: "/src/index.html", "Cache-Control": "no-store" })
    return res.end()
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true })
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    return sendJson(res, 200, { running: !!pyProc && !pyProc.killed })
  }
  if (req.method === "POST" && url.pathname === "/api/research") {
    if (!checkRateLimit(req)) return sendJson(res, 429, { error: "Too many requests. Please wait a minute and try again." })
    if (requestActive) return sendJson(res, 503, { error: "The researcher is busy. Please retry shortly." })

    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message })
    }
    const method = body?.method
    if (!ALLOWED_METHODS.has(method)) {
      return sendJson(res, 403, { error: "This web service only accepts the built-in researcher modules. Notebook code runs privately in your browser." })
    }
    if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
      return sendJson(res, 400, { error: "A params object is required." })
    }
    if (typeof body.params.csv === "string" && Buffer.byteLength(body.params.csv) > MAX_CSV_BYTES) {
      return sendJson(res, 413, { error: "CSV files must be 5 MB or smaller in the web version." })
    }
    if (typeof body.params.image === "string" && body.params.image.length > MAX_IMAGE_DATA_URI_CHARS) {
      return sendJson(res, 413, { error: "Images must be 20 MB or smaller in the web version." })
    }

    requestActive = true
    try {
      const result = await callPython(method, body.params)
      return sendJson(res, 200, { result })
    } catch (error) {
      return sendJson(res, 500, { error: error.message || "Research module failed." })
    } finally {
      requestActive = false
    }
  }

  if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/")) {
    return serveStatic(req, res, url.pathname)
  }
  return sendJson(res, 404, { error: "Not found" })
})

startPython()
server.listen(PORT, HOST, () => {
  console.log(`[web] Dreamy Researcher listening at http://${HOST}:${PORT}`)
  console.log("[web] Notebook Python runs in browser Pyodide; API accepts only built-in research modules.")
})

function shutdown() {
  server.close()
  if (pyProc && !pyProc.killed) pyProc.kill()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
