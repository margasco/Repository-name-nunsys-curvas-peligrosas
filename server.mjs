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
app.use(express.json());

// ✅ RUTAS primero (evita conflictos con estáticos)
app.get("/", (_req, res) => res.redirect("/join"));

app.get("/join", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "join.html"));
});

app.get("/presenter", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "presenter.html"));
});

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

// ✅ Socket.IO robusto en Render
const io = new Server(httpServer, {
  transports: ["websocket", "polling"],
  cors: {
    origin: true,
    methods: ["GET", "POST"],
  },
});

// =======================================================
// ✅ PERSISTENCIA (evita “desaparece sola” si Render reinicia)
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
// - q1/q2 guardan la CLAVE CANÓNICA -> count
// - q1Label/q2Label guardan el TEXTO del primer usuario (lo que tú pediste)
// =======================================================
const state = {
  q1: new Map(),             // canonKey -> count
  q2: new Map(),             // canonKey -> count
  q1Label: new Map(),        // canonKey -> primer texto visto (para mostrar)
  q2Label: new Map(),        // canonKey -> primer texto visto (para mostrar)
  canonEmbeddings: new Map() // canonKey -> embedding(Float32Array)
};

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

function emitState() {
  const payload = {
    q1: mapToArray(state.q1, state.q1Label),
    q2: mapToArray(state.q2, state.q2Label),
  };
  io.emit("state:update", payload);
}

// =======================================================
// ===== NORMALIZACIÓN (clave para “agrupar tareas similares”) =====
// Objetivo: convertir frases distintas a un "concepto" común.
//
// Ej:
//  - "responder correos" -> "correo"
//  - "redactar mails"    -> "correo"
//  - "hacer informes"    -> "informe"
// =======================================================
const STOP = new Set([
  // conectores / pronombres
  "de","la","el","los","las","un","una","y","o","a","en","para","por","con",
  "del","al","que","me","mi","mis","tu","tus","su","sus",

  // verbos muy comunes (los quitamos para quedarnos con el concepto)
  "hacer","realizar","tener","gestionar","llevar",
  "responder","contestar","redactar","escribir","enviar","leer","revisar",
  "preparar","crear","rellenar","completar","tramitar","procesar","organizar",
  "coordinar","planificar","agendar","programar","buscar","actualizar",
  "solucionar","resolver","atender","seguir","seguimiento"
]);

const SYN = [
  // email/correo
  { re: /\b(e-?mails?|emails?|mail(?:es)?|correo(?:s)?|correos? electronicos?)\b/g, to: "correo" },
  { re: /\b(outlook)\b/g, to: "correo" },

  // reuniones
  { re: /\b(reuniones?)\b/g, to: "reunion" },

  // informes/reportes
  { re: /\b(informes?|reportes?)\b/g, to: "informe" },

  // llamadas
  { re: /\b(llamadas?)\b/g, to: "llamada" },

  // incidencias
  { re: /\b(incidencias?)\b/g, to: "incidencia" },

  // facturas / facturación (si lo usan)
  { re: /\b(facturacion|facturas?)\b/g, to: "factura" },

  // tickets (si alguien lo usa)
  { re: /\b(tickets?)\b/g, to: "ticket" },
];

function normalizeConcept(input) {
  let s = (input || "").trim().toLowerCase();
  s = s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  s = s.replace(/[^\p{Letter}\p{Number}\s]/gu, " ");
  s = s.replace(/\s+/g, " ").trim();

  for (const { re, to } of SYN) s = s.replace(re, to);

  let tokens = s.split(" ").filter(Boolean);

  // quitamos STOP
  tokens = tokens.filter((t) => !STOP.has(t));

  // mini singularización segura (muy suave): correos -> correo (ya lo cubre SYN)
  // para otros plurales simples:
  tokens = tokens.map((t) => {
    if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
    if (t.length > 4 && t.endsWith("s")) return t.slice(0, -1);
    return t;
  });

  // si se queda vacío, al menos devolvemos el string base limpio
  const out = tokens.join(" ").trim();
  return out || s;
}

// =======================================================
// ===== IA LOCAL (embeddings) =====
// - Se usa SOLO para agrupar conceptos que no caen en reglas/sinónimos.
// - Con timeout para no bloquear.
// =======================================================
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

async function embedSafe(text, ms = 1200) {
  try {
    return await withTimeout(embed(text), ms);
  } catch {
    return null;
  }
}

// ✅ devuelve una CLAVE CANÓNICA (concepto) que agrupa frases parecidas
async function canonicalize(userText, threshold = 0.75) {
  const concept = normalizeConcept(userText);
  if (!concept) return null;

  // si ya existe exacto, devolvemos (rápido)
  if (state.q1.has(concept) || state.q2.has(concept) || state.canonEmbeddings.has(concept)) {
    // si faltara embedding, lo calculamos perezosamente
    if (!state.canonEmbeddings.has(concept)) {
      const v0 = await embedSafe(concept, 900);
      if (v0) state.canonEmbeddings.set(concept, v0);
    }
    return concept;
  }

  // si no hay embeddings previos, guardamos el concept tal cual
  if (state.canonEmbeddings.size === 0) {
    const v0 = await embedSafe(concept, 900);
    if (v0) state.canonEmbeddings.set(concept, v0);
    return concept;
  }

  // embedding del concepto nuevo
  const v = await embedSafe(concept, 1200);
  if (!v) {
    // fallback sin IA
    return concept;
  }

  // buscamos mejor match
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

  // si no hay match, registramos nuevo canon
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
  // soporta:
  // - {items:[...]}
  // - {item:"..."}
  // - ["a","b"]
  // - "texto"
  if (Array.isArray(payload)) return payload.map(toStringSafe);
  if (payload && Array.isArray(payload.items)) return payload.items.map(toStringSafe);
  if (payload && typeof payload.item === "string") return [payload.item];
  if (typeof payload === "string") return [payload];
  return [];
}

// =======================================================
// ===== PROCESADO (sin bloquear ACK del cliente) =====
// - Esto evita los "Error envío" aunque realmente haya llegado.
// =======================================================
async function processQ1(items) {
  let changed = false;

  for (const raw of items) {
    const clean = toStringSafe(raw).trim();
    if (!clean) continue;

    const canonKey = await canonicalize(clean);
    if (!canonKey) continue;

    // label: guardamos el primer texto humano que llegó para ese grupo
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

  socket.onAny((eventName, ...args) => {
    const preview = (() => {
      try {
        const a0 = args?.[0];
        if (!a0) return "";
        if (typeof a0 === "string") return a0.slice(0, 120);
        return JSON.stringify(a0).slice(0, 200);
      } catch {
        return "";
      }
    })();
    console.log("➡️ evento:", eventName, preview);
  });

  socket.on("disconnect", (reason) => {
    console.log("🔴 socket desconectado:", socket.id, reason);
  });

  // estado inicial
  socket.emit("state:update", {
    q1: mapToArray(state.q1, state.q1Label),
    q2: mapToArray(state.q2, state.q2Label),
  });

  // RESET (ACK inmediato)
  socket.on("admin:reset", (ack) => {
    try {
      if (typeof ack === "function") ack({ ok: true });
    } catch {}
    resetAll();
    emitState();
  });

  // Aceptamos varios nombres por si el front emite distinto
  const q1Handlers = ["q1:submit", "q1:send", "q1:answers", "q1"];
  const q2Handlers = ["q2:submit", "q2:send", "q2:answer", "q2"];

  for (const ev of q1Handlers) {
    socket.on(ev, (payload, ack) => {
      const items = extractItems(payload).map((x) => toStringSafe(x).trim()).filter(Boolean);

      // ✅ ACK inmediato (evita timeout del cliente)
      try {
        if (typeof ack === "function") ack({ ok: true, accepted: items.length });
      } catch {}

      if (!items.length) return;

      // Procesamos en “segundo plano” (sin bloquear)
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
// ✅ ARRANQUE: carga estado persistido + (opcional) precalienta embeddings
// =======================================================
async function warmEmbeddings() {
  // precalienta embeddings de los conceptos ya existentes (para agrupar mejor desde el inicio)
  const keys = new Set([
    ...Array.from(state.q1.keys()),
    ...Array.from(state.q2.keys()),
  ]);

  for (const k of keys) {
    if (state.canonEmbeddings.has(k)) continue;
    const v = await embedSafe(k, 900);
    if (v) state.canonEmbeddings.set(k, v);
  }
  console.log("✅ Embeddings precalentados:", state.canonEmbeddings.size);
}

await loadState();
warmEmbeddings().catch(() => {});

// Render expone PORT en env
const PORT = Number(process.env.PORT || 3000);
httpServer.listen(PORT, () => console.log("Servidor activo en puerto", PORT));
