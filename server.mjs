import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import QRCode from "qrcode";
import fs from "fs/promises";
import fsSync from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));

// ==============================
// RUTAS
// ==============================
app.get("/", (_req, res) => res.redirect("/join"));

app.get("/join", (_req, res) => {
  // ✅ evita que el HTML se quede cacheado en móviles “raros”
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "join.html"));
});

app.get("/presenter", (_req, res) => {
  // ✅ evita que el HTML se quede cacheado
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "presenter.html"));
});

// Healthcheck (útil en Render)
app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send("ok");
});

// QR server-side (sin CDN)
app.get("/qr", async (req, res) => {
  try {
    const u = String(req.query.u || "");
    if (!u) return res.status(400).send("Missing url");

    const pngBuffer = await QRCode.toBuffer(u, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 8,
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(pngBuffer);
  } catch (e) {
    console.error("QR error:", e);
    res.status(500).send("QR error");
  }
});

// Estáticos
// ✅ maxAge OK si usas ?v= en assets. Mantengo tu config.
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

const httpServer = createServer(app);

// Ajustes keep-alive (proxies tipo Render)
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;

// ==============================
// SOCKET.IO (más estable)
// ==============================
const io = new Server(httpServer, {
  transports: ["websocket", "polling"],
  cors: { origin: true, methods: ["GET", "POST"] },
  pingInterval: 25_000,
  pingTimeout: 30_000,
  maxHttpBufferSize: 1e6,
});

// ==============================
// PERSISTENCIA (best-effort)
// ==============================
const STATE_FILE = path.join(__dirname, "state.json");
let saveTimer = null;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveState().catch((e) => console.error("saveState error:", e));
  }, 500);
}

async function saveState() {
  const payload = {
    q1: Array.from(state.q1.entries()).map(([k, count]) => ({
      k,
      count,
      label: state.q1Label.get(k) || k,
    })),
    q2: Array.from(state.q2.entries()).map(([k, count]) => ({
      k,
      count,
      label: state.q2Label.get(k) || k,
    })),
    meta: {
      version: stateVersion,
      ts: Date.now(),
    },
  };

  await fs.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

async function loadState() {
  try {
    if (!fsSync.existsSync(STATE_FILE)) return;

    const raw = await fs.readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);

    state.q1.clear();
    state.q2.clear();
    state.q1Label.clear();
    state.q2Label.clear();
    state.canonEmbeddings.clear();

    for (const row of data?.q1 || []) {
      if (!row?.k) continue;
      state.q1.set(row.k, Number(row.count || 0));
      state.q1Label.set(row.k, String(row.label || row.k));
    }
    for (const row of data?.q2 || []) {
      if (!row?.k) continue;
      state.q2.set(row.k, Number(row.count || 0));
      state.q2Label.set(row.k, String(row.label || row.k));
    }

    const v = Number(data?.meta?.version || 0);
    if (Number.isFinite(v) && v > 0) stateVersion = v;

    console.log("✅ Estado cargado desde state.json (version:", stateVersion + ")");
  } catch (e) {
    console.error("loadState error:", e);
  }
}

// ==============================
// ESTADO
// ==============================
const state = {
  q1: new Map(), // canonKey -> count
  q2: new Map(), // canonKey -> count
  q1Label: new Map(), // canonKey -> primer texto humano
  q2Label: new Map(),
  canonEmbeddings: new Map(), // solo si USE_EMBEDDINGS=1
};

let stateVersion = 0;

function bumpVersion(reason) {
  stateVersion += 1;
  console.log("🧾 stateVersion:", stateVersion, "reason:", reason);
}

function resetAll() {
  state.q1.clear();
  state.q2.clear();
  state.q1Label.clear();
  state.q2Label.clear();
  state.canonEmbeddings.clear();
  bumpVersion("admin-reset");
  scheduleSave();
}

function mapToArray(map, labelMap) {
  return Array.from(map.entries())
    .map(([canonKey, count]) => ({
      text: labelMap.get(canonKey) || canonKey,
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

function getStatePayload(metaExtra = {}) {
  return {
    meta: {
      version: stateVersion,
      ts: Date.now(),
      ...metaExtra,
    },
    q1: mapToArray(state.q1, state.q1Label),
    q2: mapToArray(state.q2, state.q2Label),
  };
}

function emitState(metaExtra = {}) {
  io.emit("state:update", getStatePayload(metaExtra));
}

// ==============================
// NORMALIZACIÓN + AGRUPACIÓN
// ==============================
const STOP = new Set([
  "de","la","el","los","las","un","una","y","o","a","en","para","por","con",
  "del","al","que","me","mi","mis","tu","tus","su","sus",

  // verbos frecuentes (quitar “acción” y quedarse con “concepto”)
  "hacer","realizar","tener","gestionar","llevar",
  "responder","contestar","redactar","escribir","enviar","leer","revisar",
  "preparar","crear","rellenar","completar","tramitar","procesar","organizar",
  "coordinar","planificar","agendar","programar","buscar","actualizar",
  "solucionar","resolver","atender","seguir","seguimiento",
  "pasar","sacar","generar","montar","armar","validar","definir",

  // ✅ importante: “resumir” es el caso que te fallaba
  "resumir",
]);

const SYN = [
  // correos
  { re: /\b(e-?mails?|emails?|mail(?:es)?|correo(?:s)?|correos? electronicos?)\b/g, to: "correo" },
  { re: /\b(outlook)\b/g, to: "correo" },

  // reuniones
  { re: /\b(reuniones?)\b/g, to: "reunion" },

  // informes
  { re: /\b(informes?|reportes?)\b/g, to: "informe" },

  // actas/minutas
  { re: /\b(actas?|minutas?)\b/g, to: "acta" },

  // propuestas / ofertas / presupuestos / cotizaciones
  { re: /\b(propuestas?|ofertas?|presupuestos?|cotizaciones?)\b/g, to: "propuesta" },

  // requisitos
  { re: /\b(requisitos?)\b/g, to: "requisito" },

  // técnico(s)
  { re: /\b(tecnicos?|tecnicas?)\b/g, to: "tecnico" },

  // resumen(es)
  { re: /\b(resumen(?:es)?)\b/g, to: "resumen" },

  // ✅ clave: “resumir reuniones” -> “resumen reunion”
  { re: /\b(resumir)\b/g, to: "resumen" },
];

function normalizeBase(input) {
  let s = (input || "").trim().toLowerCase();
  s = s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  s = s.replace(/[^\p{Letter}\p{Number}\s]/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  for (const { re, to } of SYN) s = s.replace(re, to);
  return s.trim();
}

function singularizeToken(t) {
  if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

function tokensFrom(input) {
  const base = normalizeBase(input);
  if (!base) return [];
  let tokens = base.split(" ").filter(Boolean).map(singularizeToken);
  tokens = tokens.filter((t) => t && !STOP.has(t));

  // uniq manteniendo orden
  const out = [];
  const seen = new Set();
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// Reglas “familias” (las que nos pediste)
function ruleCanonical(tokens) {
  const set = new Set(tokens);

  // 1) Correos (cualquier variante)
  if (set.has("correo")) return "correo";

  // 2) Actas/resúmenes de reuniones
  if (set.has("reunion") && (set.has("acta") || set.has("resumen") || set.has("informe"))) {
    return "acta reunion";
  }

  // 3) Propuestas comerciales
  const isCommercial = set.has("comercial") || set.has("venta") || set.has("ventas");
  if (isCommercial && (set.has("propuesta") || set.has("informe"))) {
    return "propuesta comercial";
  }

  // 4) Requisitos técnicos
  if (set.has("requisito") && set.has("tecnico")) return "requisitos tecnicos";

  // 5) Informes genérico
  if (set.has("informe")) return "informe";

  return null;
}

// Fuzzy matching ligero (sin IA pesada) para agrupar tokens muy parecidos
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function existingCanonKeys() {
  return new Set([...state.q1.keys(), ...state.q2.keys()]);
}

function tokenSetFromCanonKey(k) {
  const parts = String(k || "").split(" ").filter(Boolean);
  return new Set(parts);
}

// ==============================
// EMBEDDINGS (IA semántica opcional)
// ==============================
const USE_EMBEDDINGS = String(process.env.USE_EMBEDDINGS || "") === "1";
let embedderPromise = null;

async function getEmbedder() {
  if (!embedderPromise) {
    const { pipeline } = await import("@xenova/transformers");
    embedderPromise = pipeline(
      "feature-extraction",
      "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      { quantized: true }
    );
  }
  return embedderPromise;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

async function embed(text) {
  const embedder = await getEmbedder();
  const out = await embedder(text, { pooling: "mean", normalize: true });
  return Float32Array.from(out.data);
}

async function embedSafe(text, ms = 900) {
  try {
    return await withTimeout(embed(text), ms);
  } catch {
    return null;
  }
}

async function canonicalize(userText) {
  const toks = tokensFrom(userText);
  if (!toks.length) return null;

  // 1) reglas deterministas
  const rk = ruleCanonical(toks);
  if (rk) return rk;

  // 2) concepto base
  const concept = toks.join(" ").trim();
  if (!concept) return null;

  // 3) fuzzy ligero contra claves existentes (sin embeddings)
  const keys = existingCanonKeys();
  if (keys.size > 0) {
    const newSet = new Set(toks);
    let best = null;
    let bestScore = 0;

    for (const k of keys) {
      const kSet = tokenSetFromCanonKey(k);
      const score = jaccard(newSet, kSet);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }

    // ✅ umbral algo más “amable” para agrupar frases cercanas sin ser agresivo
    if (best && bestScore >= 0.60) return best;
  }

  // 4) embeddings opcionales (semántica “IA”)
  if (!USE_EMBEDDINGS) return concept;

  if (state.canonEmbeddings.has(concept)) return concept;

  const v = await embedSafe(concept, 900);
  if (!v) return concept;

  let bestCanon = null;
  let bestScore = -1;

  for (const [canon, vec] of state.canonEmbeddings.entries()) {
    if (!vec) continue;
    const score = cosine(v, vec);
    if (score > bestScore) {
      bestScore = score;
      bestCanon = canon;
    }
  }

  if (bestCanon && bestScore >= 0.76) return bestCanon;

  state.canonEmbeddings.set(concept, v);
  return concept;
}

// ==============================
// HELPERS payload
// ==============================
function toStringSafe(x) {
  if (typeof x === "string") return x;
  if (x == null) return "";
  try { return String(x); } catch { return ""; }
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload.map(toStringSafe);
  if (payload && Array.isArray(payload.items)) return payload.items.map(toStringSafe);
  if (payload && typeof payload.item === "string") return [payload.item];
  if (typeof payload === "string") return [payload];
  return [];
}

// ==============================
// PROCESADO (ACK inmediato)
// ==============================
async function processQ1(items) {
  let changed = false;

  for (const raw of items) {
    const clean = toStringSafe(raw).trim();
    if (!clean) continue;

    const canonKey = await canonicalize(clean);
    if (!canonKey) continue;

    if (!state.q1Label.has(canonKey)) state.q1Label.set(canonKey, clean);
    state.q1.set(canonKey, (state.q1.get(canonKey) || 0) + 1);
    changed = true;
  }

  if (changed) {
    bumpVersion("q1");
    emitState({ reason: "q1-update" });
    scheduleSave();
  }
}

async function processQ2(item) {
  const clean = toStringSafe(item).trim();
  if (!clean) return;

  const canonKey = await canonicalize(clean);
  if (!canonKey) return;

  if (!state.q2Label.has(canonKey)) state.q2Label.set(canonKey, clean);
  state.q2.set(canonKey, (state.q2.get(canonKey) || 0) + 1);

  bumpVersion("q2");
  emitState({ reason: "q2-update" });
  scheduleSave();
}

// ==============================
// SOCKETS
// ==============================
io.on("connection", (socket) => {
  console.log("🟢 socket conectado:", socket.id);

  socket.on("disconnect", (reason) => {
    console.log("🔴 socket desconectado:", socket.id, reason);
  });

  // ✅ estado inicial SOLO para el socket que entra (NO broadcast)
  socket.emit("state:update", getStatePayload({ reason: "initial-connection" }));

  // Cliente puede pedir estado al reconectar
  socket.on("state:request", () => {
    socket.emit("state:update", getStatePayload({ reason: "client-request" }));
  });

  // RESET (ACK inmediato + broadcast vacío)
  socket.on("admin:reset", (ack) => {
    try { if (typeof ack === "function") ack({ ok: true }); } catch {}
    resetAll();
    emitState({ reason: "admin-reset" });
  });

  const q1Handlers = ["q1:submit", "q1:send", "q1:answers", "q1"];
  const q2Handlers = ["q2:submit", "q2:send", "q2:answer", "q2"];

  // Anti-flood simple por socket
  let bucket = 0;
  const refill = setInterval(() => { bucket = 0; }, 2500);
  refill.unref?.(); // ✅ no bloquea el apagado del proceso
  socket.on("disconnect", () => clearInterval(refill));

  for (const ev of q1Handlers) {
    socket.on(ev, (payload, ack) => {
      if (bucket > 25) {
        try { if (typeof ack === "function") ack({ ok: false, reason: "rate-limit" }); } catch {}
        return;
      }
      bucket += 1;

      const items = extractItems(payload).map((x) => toStringSafe(x).trim()).filter(Boolean);

      // ACK inmediato
      try { if (typeof ack === "function") ack({ ok: true, accepted: items.length }); } catch {}

      if (!items.length) return;
      processQ1(items).catch((e) => console.error("processQ1 error:", e));
    });
  }

  for (const ev of q2Handlers) {
    socket.on(ev, (payload, ack) => {
      if (bucket > 25) {
        try { if (typeof ack === "function") ack({ ok: false, reason: "rate-limit" }); } catch {}
        return;
      }
      bucket += 1;

      const items = extractItems(payload);
      const raw = toStringSafe(items[0] || "").trim();

      try { if (typeof ack === "function") ack({ ok: true, accepted: raw ? 1 : 0 }); } catch {}

      if (!raw) return;
      processQ2(raw).catch((e) => console.error("processQ2 error:", e));
    });
  }
});

// ==============================
// ARRANQUE + APAGADO SEGURO
// ==============================
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

async function gracefulShutdown(signal) {
  try {
    console.log(`🟠 ${signal}: guardando estado y cerrando servidor...`);
    await saveState().catch(() => {});
  } finally {
    try { httpServer.close(() => process.exit(0)); } catch { process.exit(0); }
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

await loadState();

const PORT = Number(process.env.PORT || 3000);
httpServer.listen(PORT, () => console.log("Servidor activo en puerto", PORT));
