import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import { pipeline } from "@xenova/transformers";
import QRCode from "qrcode";
import fs from "fs/promises";
import fsSync from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(express.json());

// ✅ RUTAS primero (evita conflictos con estáticos)
app.get("/", (_req, res) => res.redirect("/join"));

app.get("/join", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "join.html"));
});

app.get("/presenter", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "presenter.html"));
});

// ✅ Healthcheck (útil en Render)
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ✅ QR server-side (sin CDN)
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

// ✅ Estáticos después
app.use(express.static(path.join(__dirname, "public")));

const httpServer = createServer(app);

// ✅ Ajustes keep-alive (Render/proxies)
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;

// =========================
// Socket.IO (más estable)
// =========================
const io = new Server(httpServer, {
  transports: ["websocket", "polling"],
  cors: { origin: true, methods: ["GET", "POST"] },

  // engine.io ping settings (reduce desconexiones por micro-freezes)
  pingInterval: 25_000,
  pingTimeout: 25_000,

  // evita payloads gigantes
  maxHttpBufferSize: 1e6,
});

// =======================================================
// ✅ PERSISTENCIA (mejora “desaparece” si hay reinicio suave)
// OJO: si Render reinicia contenedor, el FS puede ser efímero.
// Aun así ayuda para caídas/restarts no destructivos.
// =======================================================
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

    console.log("✅ Estado cargado desde state.json");
  } catch (e) {
    console.error("loadState error:", e);
  }
}

// =======================================================
// ===== ESTADO DE LA APP =====
// - q1/q2 guardan CLAVE CANÓNICA -> count
// - q1Label/q2Label guardan el TEXTO del primer usuario (lo que se muestra)
// =======================================================
const state = {
  q1: new Map(),
  q2: new Map(),
  q1Label: new Map(),
  q2Label: new Map(),
  canonEmbeddings: new Map(), // opcional
};

let stateVersion = 0;

function resetAll() {
  state.q1.clear();
  state.q2.clear();
  state.q1Label.clear();
  state.q2Label.clear();
  state.canonEmbeddings.clear();
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

function emitState(metaExtra = {}) {
  stateVersion += 1;
  const payload = {
    meta: {
      version: stateVersion,
      ts: Date.now(),
      ...metaExtra,
    },
    q1: mapToArray(state.q1, state.q1Label),
    q2: mapToArray(state.q2, state.q2Label),
  };
  io.emit("state:update", payload);
}

// =======================================================
// ===== NORMALIZACIÓN + REGLAS (AGRUPACIÓN REAL) =====
// Prioridad: estabilidad + agrupación fiable.
// =======================================================
const STOP = new Set([
  // conectores / pronombres
  "de","la","el","los","las","un","una","y","o","a","en","para","por","con",
  "del","al","que","me","mi","mis","tu","tus","su","sus",

  // verbos muy comunes (nos quedamos con el concepto)
  "hacer","realizar","tener","gestionar","llevar",
  "responder","contestar","redactar","escribir","enviar","leer","revisar",
  "preparar","crear","rellenar","completar","tramitar","procesar","organizar",
  "coordinar","planificar","agendar","programar","buscar","actualizar",
  "solucionar","resolver","atender","seguir","seguimiento",
  "pasar","sacar","generar","montar","armar","revisar","validar","definir"
]);

// Sustituciones “claras”
const SYN = [
  // emails/correos
  { re: /\b(e-?mails?|emails?|mail(?:es)?|correo(?:s)?|correos? electronicos?)\b/g, to: "correo" },
  { re: /\b(outlook)\b/g, to: "correo" },

  // reuniones
  { re: /\b(reuniones?)\b/g, to: "reunion" },

  // informes/reportes
  { re: /\b(informes?|reportes?)\b/g, to: "informe" },

  // actas/minutas
  { re: /\b(actas?|minutas?)\b/g, to: "acta" },

  // propuestas / ofertas / presupuestos / cotizaciones
  { re: /\b(propuestas?|ofertas?|presupuestos?|cotizaciones?)\b/g, to: "propuesta" },

  // requisitos
  { re: /\b(requisitos?)\b/g, to: "requisito" },

  // técnico(s)
  { re: /\b(tecnicos?|tecnicas?)\b/g, to: "tecnico" },
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
  return tokens;
}

// 👉 Reglas de agrupación (las “familias” que nos has pedido)
function ruleCanonical(tokens) {
  const set = new Set(tokens);

  // 1) Correos / email
  if (set.has("correo")) return "correo";

  // 2) Actas / resúmenes de reuniones
  // acta reunion, resumen reunion, informe reunion...
  if (set.has("reunion") && (set.has("acta") || set.has("resumen") || set.has("informe"))) {
    return "acta reunion";
  }

  // 3) Propuestas comerciales
  // “informe comercial”, “propuesta comercial”, “redactar oferta comercial”...
  const isCommercial = set.has("comercial") || set.has("venta") || set.has("ventas");
  if (isCommercial && (set.has("propuesta") || set.has("informe"))) {
    return "propuesta comercial";
  }

  // 4) Requisitos técnicos
  if (set.has("requisito") && set.has("tecnico")) return "requisitos tecnicos";

  // 5) Informes (genérico)
  if (set.has("informe")) return "informe";

  // Fallback: devolvemos tokens unidos (concepto)
  if (tokens.length) return tokens.join(" ");

  return null;
}

// =======================================================
// ===== IA LOCAL (embeddings) - opcional =====
// (por defecto OFF para no romper estabilidad en Render)
// =======================================================
const USE_EMBEDDINGS = String(process.env.USE_EMBEDDINGS || "") === "1";

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

let embedderPromise = null;
async function getEmbedder() {
  if (!embedderPromise) {
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

async function canonicalize(userText, threshold = 0.76) {
  const toks = tokensFrom(userText);
  if (!toks.length) return null;

  // 1) reglas deterministas (rápidas y fiables)
  const ruleKey = ruleCanonical(toks);
  if (ruleKey) return ruleKey;

  // 2) sin embeddings: devolvemos concepto tokens
  const concept = toks.join(" ").trim();
  if (!USE_EMBEDDINGS) return concept;

  // 3) embeddings opcionales (más “IA” pero más riesgo de freeze)
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

  if (bestCanon && bestScore >= threshold) return bestCanon;

  state.canonEmbeddings.set(concept, v);
  return concept;
}

// =======================================================
// ===== HELPERS: parse payloads robustos =====
// =======================================================
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

// =======================================================
// ===== PROCESADO (ACK inmediato para no dar “Error envío”) =====
// =======================================================
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
    emitState();
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

  emitState();
  scheduleSave();
}

// =======================================================
// ===== SOCKETS =====
// =======================================================
io.on("connection", (socket) => {
  console.log("🟢 socket conectado:", socket.id);

  socket.on("disconnect", (reason) => {
    console.log("🔴 socket desconectado:", socket.id, reason);
  });

  // estado inicial (incluye meta.version)
  emitState({ reason: "initial-connection", to: socket.id });
  // 👆 emitState emite a todos; si prefieres solo a ese socket:
  // socket.emit("state:update", { meta:{version:stateVersion,ts:Date.now()}, q1:..., q2:... });

  // RESET (ACK inmediato + emit vacío)
  socket.on("admin:reset", (ack) => {
    try {
      if (typeof ack === "function") ack({ ok: true });
    } catch {}
    resetAll();
    emitState({ reason: "admin-reset" });
  });

  const q1Handlers = ["q1:submit", "q1:send", "q1:answers", "q1"];
  const q2Handlers = ["q2:submit", "q2:send", "q2:answer", "q2"];

  for (const ev of q1Handlers) {
    socket.on(ev, (payload, ack) => {
      const items = extractItems(payload).map((x) => toStringSafe(x).trim()).filter(Boolean);

      // ✅ ACK inmediato (evita timeouts del cliente)
      try {
        if (typeof ack === "function") ack({ ok: true, accepted: items.length });
      } catch {}

      if (!items.length) return;
      processQ1(items).catch((e) => console.error("processQ1 error:", e));
    });
  }

  for (const ev of q2Handlers) {
    socket.on(ev, (payload, ack) => {
      const items = extractItems(payload);
      const raw = toStringSafe(items[0] || "").trim();

      try {
        if (typeof ack === "function") ack({ ok: true, accepted: raw ? 1 : 0 });
      } catch {}

      if (!raw) return;
      processQ2(raw).catch((e) => console.error("processQ2 error:", e));
    });
  }
});

// =======================================================
// ✅ ARRANQUE
// =======================================================
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

await loadState();

// Render expone PORT en env
const PORT = Number(process.env.PORT || 3000);
httpServer.listen(PORT, () => console.log("Servidor activo en puerto", PORT));
