const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const pty = require("node-pty");
const Busboy = require("busboy");
const { WebSocketServer } = require("ws");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 7681);
const SHELL = process.env.SHELL || process.env.ComSpec || "cmd.exe";
const PROJECT_DIR = String(process.env.PROJECT_DIR || process.cwd())
  .trim()
  .replace(/^"|"$/g, "");
let termCwd = fs.existsSync(PROJECT_DIR) ? path.resolve(PROJECT_DIR) : process.cwd();
// Never put a path in the shell command line — Windows node-pty quoting
// mangles `mimo "C:\..."` into `C:\..."C:\..."`. cwd already selects the project.
const START_CMD = process.env.MIMO_CMD || "mimo";
// Phone photos / notes land here inside the active project.
const INBOX_SUBDIR = process.env.MIMO_INBOX || "inbox";
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024;

// ---- switchable project directories (projects.json next to this file) ----
const PROJECTS_FILE = path.join(__dirname, "projects.json");

function seedPresets() {
  const desktop = path.join(process.env.USERPROFILE || "C:\\Users\\Administrator", "Desktop");
  return [
    { name: "StockTrading", path: "G:\\website\\StockTrading" },
    { name: "mimo-web", path: __dirname },
    { name: "桌面", path: desktop },
  ].filter((p) => {
    try {
      return fs.existsSync(p.path);
    } catch {
      return false;
    }
  });
}

function loadProjects() {
  try {
    const j = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
    const presets = Array.isArray(j.presets) ? j.presets.filter((p) => p && p.path) : [];
    const active = typeof j.active === "string" && j.active ? j.active : "";
    return { active, presets };
  } catch {
    return { active: "", presets: seedPresets() };
  }
}

const projects = loadProjects();
// A saved active dir wins over PROJECT_DIR so a switch survives restarts.
if (projects.active && fs.existsSync(projects.active)) {
  termCwd = path.resolve(projects.active);
} else {
  projects.active = termCwd;
}
// Keep the current dir visible in the preset list.
function rememberActiveInPresets() {
  if (projects.presets.some((p) => path.resolve(p.path) === termCwd)) return;
  projects.presets.unshift({ name: path.basename(termCwd) || termCwd, path: termCwd });
}

function saveProjects() {
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2) + "\n");
  } catch {}
}

// ---- mimo CLI entry (chat tab: `mimo run --format json`) ----
function resolveMimoBin() {
  const cands = [process.env.MIMO_BIN];
  const npmPrefix = path.join(process.env.APPDATA || "", "npm");
  cands.push(path.join(npmPrefix, "node_modules", "@mimo-ai", "cli", "bin", "mimo"));
  const localApp = process.env.LOCALAPPDATA || "";
  cands.push(path.join(localApp, "Programs", "mimocode", "resources", "app.asar.unpacked", "node_modules", "@mimo-ai", "cli", "bin", "mimo"));
  for (const c of cands) {
    if (!c) continue;
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}
const MIMO_BIN = resolveMimoBin();
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS || 10 * 60 * 1000);

// ---- MiMo TTS ----
const TTS_URL_DEFAULT = "https://api.xiaomimimo.com/v1/chat/completions";
const TTS_MODEL_DEFAULT = "mimo-v2.5-tts";
const TTS_VOICES = ["mimo_default", "default_zh", "default_en", "Mia", "Chloe", "Milo", "Dean"];
const TTS_DEFAULT_VOICE = process.env.MIMO_TTS_VOICE || "mimo_default";
const TTS_CONFIG_CANDIDATES = [
  process.env.MIMO_TTS_CONFIG,
  path.join(__dirname, "tts.config.json"),
].filter(Boolean);

function extractTtsKey(raw) {
  if (!raw) return "";
  const objMatch = raw.match(/"(?:key|apiKey|api_key|mimo_tts_api_key)"\s*:\s*"([^"]+)"/);
  if (objMatch && objMatch[1]) return objMatch[1].trim();
  const sk = raw.match(/\bsk-[A-Za-z0-9]{16,}\b/);
  if (sk) return sk[0];
  return "";
}

function loadTtsConfig() {
  if (process.env.MIMO_TTS_KEY) {
    return {
      key: process.env.MIMO_TTS_KEY.trim(),
      url: process.env.MIMO_TTS_URL || TTS_URL_DEFAULT,
      model: process.env.MIMO_TTS_MODEL || TTS_MODEL_DEFAULT,
      voice: process.env.MIMO_TTS_VOICE || TTS_DEFAULT_VOICE,
      format: process.env.MIMO_TTS_FORMAT || "mp3",
    };
  }
  for (const p of TTS_CONFIG_CANDIDATES) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const key = extractTtsKey(raw);
      if (!key) continue;
      let url = process.env.MIMO_TTS_URL || TTS_URL_DEFAULT;
      let model = process.env.MIMO_TTS_MODEL || TTS_MODEL_DEFAULT;
      let voice = process.env.MIMO_TTS_VOICE || TTS_DEFAULT_VOICE;
      let format = process.env.MIMO_TTS_FORMAT || "mp3";
      try {
        const j = JSON.parse(raw);
        if (j.url) url = String(j.url).trim();
        if (j.model) model = String(j.model).trim();
        if (j.voice) voice = String(j.voice).trim();
        if (j.format) format = String(j.format).trim().toLowerCase();
      } catch {}
      return { key, url, model, voice, format };
    } catch {}
  }
  return { key: "", url: TTS_URL_DEFAULT, model: TTS_MODEL_DEFAULT, voice: TTS_DEFAULT_VOICE, format: "mp3" };
}
const TTS = loadTtsConfig();
const TTS_KEY = TTS.key;
const TTS_URL = TTS.url;
const TTS_MODEL = TTS.model;
const TTS_FORMAT = TTS.format === "wav" ? "wav" : "mp3";
const TTS_AUDIO_TYPE = TTS_FORMAT === "wav" ? "audio/wav" : "audio/mpeg";

const ttsCache = new Map();
const TTS_CACHE_MAX = 60;

async function synthesize(text, voice) {
  const clean = String(text || "").trim().slice(0, 2000);
  if (!clean) throw new Error("empty text");
  const v = TTS_VOICES.includes(voice) ? voice : TTS.voice;
  const cacheKey = crypto.createHash("sha1").update(v + "|" + TTS_FORMAT + "|" + clean).digest("hex");
  const hit = ttsCache.get(cacheKey);
  if (hit) return hit.buf;

  const res = await fetch(TTS_URL, {
    method: "POST",
    headers: {
      "api-key": TTS_KEY,
      Authorization: `Bearer ${TTS_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      messages: [
        { role: "user", content: "请朗读以下内容" },
        { role: "assistant", content: clean },
      ],
      audio: { voice: v, format: TTS_FORMAT },
    }),
    signal: AbortSignal.timeout(90000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json && json.error ? json.error.message || JSON.stringify(json.error) : `tts http ${res.status}`;
    throw new Error(msg);
  }
  const b64 =
    json &&
    json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    json.choices[0].message.audio &&
    json.choices[0].message.audio.data;
  if (!b64) throw new Error("no audio in response");
  const buf = Buffer.from(b64, "base64");
  if (ttsCache.size >= TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
  ttsCache.set(cacheKey, { buf, at: Date.now() });
  return buf;
}

/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();
/** live terminals, tracked so a project switch can restart them */
const liveTerms = new Set();
/** live `mimo run` children from the chat tab, killed on project switch */
const chatChildren = new Set();

function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

// Browsers can open a cross-origin WebSocket / form POST without CORS, which
// would let any site a visitor happens to be on drive the terminal or write
// files. Reject requests whose Origin is not this server itself. Non-browser
// clients (no Origin header) are allowed.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.host || "");
  } catch {
    return false;
  }
}

function safeJoin(root, rel) {
  const cleaned = String(rel || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..")
    .join(path.sep);
  const full = path.resolve(root, cleaned);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(rootWithSep)) return null;
  return full;
}

function sanitizeSegment(seg) {
  return String(seg)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .slice(0, 120);
}

function uniqueTarget(destDir, name) {
  let target = path.join(destDir, name);
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target).slice(0, path.basename(target).length - ext.length);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${stem}(${n})${ext}`);
    n++;
  }
  return target;
}

function inboxDir() {
  if (!fs.existsSync(termCwd)) throw new Error(`项目目录不存在：${termCwd}`);
  const dir = path.join(termCwd, INBOX_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function relToProject(abs) {
  return path.relative(termCwd, abs).split(path.sep).join("/");
}

// Phone uploads (photos / files). Text notes arrive as JSON and become a .md file.
function saveIngest(req, cb) {
  const contentType = req.headers["content-type"] || "";
  let dest;
  try {
    dest = inboxDir();
  } catch (e) {
    cb(e);
    return;
  }
  const saved = [];

  if (/^application\/json/i.test(contentType)) {
    let body = "";
    let tooBig = false;
    req.on("data", (c) => {
      body += c;
      if (body.length > 1000000) {
        tooBig = true;
        body = "";
      }
    });
    req.on("end", () => {
      if (tooBig) {
        cb(new Error("文本过长（上限约 1MB）"));
        return;
      }
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {}
      const text = String(payload.text || "").trim();
      if (!text) {
        cb(new Error("空文本"));
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const target = uniqueTarget(dest, sanitizeSegment(`note-${stamp}.md`) || "note.md");
      try {
        fs.writeFileSync(target, text, "utf8");
        saved.push({ name: path.basename(target), path: relToProject(target), size: Buffer.byteLength(text) });
        cb(null, saved);
      } catch (e) {
        cb(e);
      }
    });
    return;
  }

  if (!/^multipart\/form-data/i.test(contentType)) {
    cb(new Error("expected multipart/form-data or application/json"));
    return;
  }

  const bb = Busboy({
    headers: req.headers,
    preservePath: false,
    limits: { fileSize: MAX_UPLOAD, files: 40, fieldSize: 1024 * 1024 },
  });
  let pending = 0;
  let failed = null;
  let settled = false;
  const done = (err) => {
    if (settled) return;
    settled = true;
    cb(err, saved);
  };

  bb.on("file", (_name, file, info) => {
    pending++;
    const safe = sanitizeSegment(path.basename(info.filename || "upload.bin")) || "upload.bin";
    const target = uniqueTarget(dest, safe);
    let oversize = false;
    const out = fs.createWriteStream(target);
    file.pipe(out);
    file.on("limit", () => {
      // Busboy truncates the stream; drain it so 'close' still fires and the
      // request cannot hang. The partial file is removed below.
      oversize = true;
      failed = new Error(`文件过大（上限 ${Math.round(MAX_UPLOAD / (1024 * 1024))}MB）：${info.filename}`);
      try { file.resume(); } catch {}
    });
    file.on("error", (e) => {
      failed = e;
    });
    out.on("error", (e) => {
      failed = e;
      pending--;
      if (pending <= 0) done(failed);
    });
    out.on("close", () => {
      if (!failed && !oversize) {
        let size = 0;
        try {
          size = fs.statSync(target).size;
        } catch {}
        saved.push({ name: path.basename(target), path: relToProject(target), size });
      } else {
        try {
          fs.unlinkSync(target);
        } catch {}
      }
      pending--;
      if (pending <= 0) done(failed);
    });
  });

  bb.on("error", (e) => done(e));
  bb.on("close", () => {
    if (pending <= 0) done(failed);
  });
  req.pipe(bb);
}

function listFiles(dir, baseUrl = "") {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    out.push({
      name: e.name,
      path: (baseUrl ? baseUrl + "/" : "") + e.name,
      dir: e.isDirectory(),
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  }
  out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (!sameOrigin(req)) {
    json(res, 403, { error: "cross-origin request blocked" });
    req.resume();
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
    return;
  }

  if (pathname === "/api/status" && req.method === "GET") {
    json(res, 200, {
      project: termCwd,
      command: START_CMD,
      clients: clients.size,
      inbox: path.join(termCwd, INBOX_SUBDIR),
      inboxSubdir: INBOX_SUBDIR,
    });
    return;
  }

  if (pathname === "/api/files" && req.method === "GET") {
    const rel = url.searchParams.get("path") || "";
    const dir = rel ? safeJoin(termCwd, rel) : termCwd;
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      json(res, 400, { error: "bad path" });
      return;
    }
    json(res, 200, {
      path: rel,
      project: termCwd,
      files: listFiles(dir, rel),
    });
    return;
  }

  if (pathname === "/api/tts" && req.method === "POST") {
    if (!TTS_KEY) {
      json(res, 503, { error: "TTS key not configured (set MIMO_TTS_KEY or tts.config.json)" });
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 200000) req.destroy();
    });
    req.on("end", async () => {
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {}
      try {
        const buf = await synthesize(payload.text, payload.voice);
        res.writeHead(200, {
          "Content-Type": TTS_AUDIO_TYPE,
          "Content-Length": buf.length,
          "Cache-Control": "no-store",
        });
        res.end(buf);
      } catch (e) {
        json(res, 502, { error: String(e.message || e) });
      }
    });
    return;
  }

  if (pathname === "/api/tts-config" && req.method === "GET") {
    json(res, 200, {
      enabled: Boolean(TTS_KEY),
      model: TTS_MODEL,
      voices: TTS_VOICES,
      defaultVoice: TTS.voice || TTS_DEFAULT_VOICE,
      format: TTS_FORMAT,
      cached: ttsCache.size,
    });
    return;
  }

  // ---- chat: `mimo run --format json`, streamed as NDJSON ----
  if (pathname === "/api/chat" && req.method === "POST") {
    if (!MIMO_BIN) {
      json(res, 503, { error: "找不到 mimo CLI 入口，请设置环境变量 MIMO_BIN 指向 bin/mimo" });
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 500000) req.destroy();
    });
    req.on("end", () => {
      let payload = {};
      try {
        payload = JSON.parse(body.replace(/^﻿/, "") || "{}");
      } catch {}
      const message = String(payload.message || "").trim();
      if (!message) {
        json(res, 400, { error: "empty message" });
        return;
      }
      const sessionId = payload.sessionId ? String(payload.sessionId) : "";

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      const send = (obj) => {
        if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
      };

      const args = [MIMO_BIN, "run", "--format", "json"];
      if (sessionId) args.push("--session", sessionId);
      args.push(message);

      let child;
      try {
        child = spawn(process.execPath, args, {
          cwd: termCwd,
          env: process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        send({ type: "error", message: String(e.message || e) });
        res.end();
        return;
      }
      chatChildren.add(child);

      let buf = "";
      let newSession = "";
      let cost = 0;
      let stderrTail = "";
      let finished = false;

      const timer = setTimeout(() => {
        if (!finished) {
          send({ type: "error", message: `超时（${Math.round(CHAT_TIMEOUT_MS / 1000)}s）` });
          try { child.kill(); } catch {}
        }
      }, CHAT_TIMEOUT_MS);

      const handleLine = (line) => {
        const s = line.trim();
        if (!s) return;
        let ev;
        try {
          ev = JSON.parse(s);
        } catch {
          return;
        }
        if (ev.sessionID) newSession = ev.sessionID;
        const part = ev.part || {};
        if (ev.type === "text" && part.text) {
          send({ type: "text", text: part.text });
        } else if (ev.type === "step_finish") {
          if (part.tokens) cost += Number(part.cost || 0);
        } else if (ev.type === "tool" && part.tool) {
          send({ type: "tool", tool: part.tool, state: part.state && part.state.status });
        } else if (ev.type === "error") {
          send({ type: "error", message: (ev.error && ev.error.data && ev.error.data.message) || "错误" });
        }
      };

      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) handleLine(l);
      });
      child.stderr.on("data", (c) => {
        stderrTail = (stderrTail + c.toString("utf8")).slice(-2000);
      });

      const finish = (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        chatChildren.delete(child);
        if (buf.trim()) handleLine(buf);
        if (code !== 0 && !stderrTail && code !== null) {
          send({ type: "error", message: `mimo 退出码 ${code}` });
        } else if (code !== 0 && stderrTail) {
          send({ type: "error", message: stderrTail.trim().slice(-500) });
        }
        send({ type: "done", sessionId: newSession, cost });
        res.end();
      };

      child.on("close", (code) => finish(code));
      child.on("error", (e) => {
        send({ type: "error", message: String(e.message || e) });
        finish(-1);
      });

      res.on("close", () => {
        if (!finished) {
          try { child.kill(); } catch {}
          chatChildren.delete(child);
        }
      });
    });
    return;
  }

  if (pathname === "/api/chat-status" && req.method === "GET") {
    json(res, 200, { available: Boolean(MIMO_BIN), bin: MIMO_BIN || "", project: termCwd });
    return;
  }

  if (pathname === "/api/download" && req.method === "GET") {
    const rel = url.searchParams.get("path") || "";
    const file = safeJoin(termCwd, rel);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      json(res, 404, { error: "not found" });
      return;
    }
    const stat = fs.statSync(file);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(path.basename(file))}"`,
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (pathname === "/api/ingest" && req.method === "POST") {
    saveIngest(req, (err, saved) => {
      if (err) {
        json(res, 400, { error: String(err.message || err) });
        return;
      }
      if (!saved.length) {
        json(res, 400, { error: "没有收到文件" });
        return;
      }
      json(res, 200, { ok: true, files: saved, dir: INBOX_SUBDIR, project: termCwd });
    });
    return;
  }

  if (pathname === "/api/projects" && req.method === "GET") {
    rememberActiveInPresets();
    json(res, 200, { active: termCwd, presets: projects.presets });
    return;
  }

  if (pathname === "/api/project" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 100000) req.destroy();
    });
    req.on("end", () => {
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {}
      const raw = String(payload.path || "").trim().replace(/^"|"$/g, "");
      if (!raw) {
        json(res, 400, { error: "empty path" });
        return;
      }
      const abs = path.resolve(raw);
      let ok = false;
      try {
        ok = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
      } catch {}
      if (!ok) {
        json(res, 400, { error: `目录不存在：${abs}` });
        return;
      }
      termCwd = abs;
      projects.active = abs;
      if (payload.name) {
        const nm = String(payload.name).trim();
        projects.presets = projects.presets.filter((p) => path.resolve(p.path) !== abs);
        if (nm) projects.presets.unshift({ name: nm, path: abs });
      }
      rememberActiveInPresets();
      saveProjects();
      // Restart every live terminal so it picks up the new cwd. The pty exit
      // closes the socket, and the client reconnects on its own.
      let killed = 0;
      for (const entry of liveTerms) {
        try {
          entry.term.kill();
          killed++;
        } catch {}
      }
      // Chat runs hold the old cwd too — stop them so the next message uses the new project.
      let chatsStopped = 0;
      for (const child of chatChildren) {
        try {
          child.kill();
          chatsStopped++;
        } catch {}
      }
      json(res, 200, { ok: true, project: termCwd, restarted: killed, chatsStopped });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  if (!sameOrigin(req)) {
    ws.close(4003, "origin not allowed");
    return;
  }
  clients.add(ws);
  const args = SHELL.toLowerCase().endsWith("cmd.exe") ? ["/k", START_CMD] : ["-l", "-c", START_CMD];
  const term = pty.spawn(SHELL, args, {
    name: "xterm-color",
    cols: 100,
    rows: 28,
    cwd: termCwd,
    env: process.env,
  });
  const entry = { ws, term };
  liveTerms.add(entry);

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n[process exited: ${exitCode}]\r\n`);
      ws.close();
    }
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input") term.write(msg.data);
    if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) {
      try {
        term.resize(Number(msg.cols), Number(msg.rows));
      } catch {}
    }
  });

  const cleanup = () => {
    clients.delete(ws);
    liveTerms.delete(entry);
    try {
      term.kill();
    } catch {}
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

server.listen(PORT, HOST, () => {
  const nets = require("os").networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) ips.push(n.address);
    }
  }
  console.log("MiMoCode LAN web terminal + chat + phone capture");
  console.log(`  local:   http://127.0.0.1:${PORT}`);
  for (const ip of ips) console.log(`  phone:   http://${ip}:${PORT}`);
  console.log(`  project: ${termCwd}`);
  console.log(`  presets: ${projects.presets.map((p) => p.name).join(", ") || "(none)"}`);
  console.log(`  command: ${START_CMD}  (cwd = project)`);
  console.log(`  inbox:   ${path.join(termCwd, INBOX_SUBDIR)}`);
  console.log(`  chat:    ${MIMO_BIN ? MIMO_BIN : "not found"}`);
  console.log(`  tts:     ${TTS_KEY ? TTS_MODEL + " / " + (TTS.voice || TTS_DEFAULT_VOICE) + " / " + TTS_FORMAT : "not configured"}`);
});
