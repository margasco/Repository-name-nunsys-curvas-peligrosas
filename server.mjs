import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import { pipeline } from "@xenova/transformers";
import QRCode from "qrcode";

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

// ===== ESTADO DE LA APP =====
const state = {
  q1: new Map(),             // canon -> count
  q2: new Map(),             // canon -> count
  canonEmbeddings: new Map() // canon -> embedding(Float32Array)
};

function resetAll() {
  state.q1.clear();
  state.q2.clear();
  state.canonEmbeddings.clear();
}

function mapToArray(map) {
  return Array.from(map.entries())
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count);
}

function emitState() {
  const payload = {
    q1: mapToArray(state.q1),
    q2: mapToArray(state.q2),
  };
  io.emit("state:update", payload);
}

// ===== NORMALIZACIÓN (rápida, antes de IA) =====
const STOP = new Set([
  "de","la","el","los","las","un","una","y","o","a","en","para","por","con",
  "del","al","que","me","mi","mis","tu","tus","su","sus","hacer","realizar",
  "tener","gestionar","llevar"
]);

const SYN = [
  { re: /\b(e-?mails?|emails?|correo?s?)\b/g, to: "correo" },
  { re: /\b(outlook)\b/g, to: "correo" },
  { re: /\b(reuniones?)\b/g, to: "reunion" },
  { re: /\b(informes?|reportes?)\b/g, to: "informe" },
  { re: /\b(llamadas?)\b/g, to: "llamada" },
];

function normalizeText(input) {
  let s = (input || "").trim().toLowerCase();
  s = s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  s = s.replace(/[^\p{Letter}\p{Number}\s]/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  for (const { re, to } of SYN) s = s.replace(re, to);
  const tokens = s.split(" ").filter((t) => t && !STOP.has(t));
  return tokens.join(" ").trim();
}

// ===== IA LOCAL (con timeout para no bloquear) =====
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
  } catch (e) {
    return null;
  }
}

async function canonicalize(userText, threshold = 0.78) {
  const norm = normalizeText(userText);
  if (!norm) return null;

  // si ya existe exacto, devolvemos
  if (state.canonEmbeddings.has(norm)) return norm;

  // intentamos embedding (pero SIN bloquear si tarda)
  const v = await embedSafe(norm, 1200);
  if (!v) {
    // fallback sin IA
    return norm;
  }

  let bestCanon = null;
  let bestScore = -1;
  for (const [canon, vec] of state.canonEmbeddings.entries()) {
    const score = cosine(v, vec);
    if (score > bestScore) {
      bestScore = score;
      bestCanon = canon;
    }
  }

  if (bestCanon && bestScore >= threshold) return bestCanon;

  state.canonEmbeddings.set(norm, v);
  return norm;
}

// ===== HELPERS: parse payloads robustos =====
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

// ===== SOCKETS =====
io.on("connection", (socket) => {
  console.log("🟢 socket conectado:", socket.id);

  // Loguea cualquier evento que llegue (clave para debug en Render)
  socket.onAny((eventName, ...args) => {
    // OJO: no imprimimos args enormes, solo resumen
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
    q1: mapToArray(state.q1),
    q2: mapToArray(state.q2),
  });

  socket.on("admin:reset", (ack) => {
    resetAll();
    emitState();
    if (typeof ack === "function") ack({ ok: true });
  });

  // Aceptamos varios nombres por si el front aún estaba emitiendo distinto
  const q1Handlers = ["q1:submit", "q1:send", "q1:answers", "q1"];
  const q2Handlers = ["q2:submit", "q2:send", "q2:answer", "q2"];

  for (const ev of q1Handlers) {
    socket.on(ev, async (payload, ack) => {
      const items = extractItems(payload);
      if (!items.length) {
        if (typeof ack === "function") ack({ ok: false, reason: "no-items" });
        return;
      }

      for (const raw of items) {
        const clean = toStringSafe(raw).trim();
        if (!clean) continue;

        const canon = await canonicalize(clean);
        if (!canon) continue;

        state.q1.set(canon, (state.q1.get(canon) || 0) + 1);
      }

      emitState();
      if (typeof ack === "function") ack({ ok: true, q1Size: state.q1.size });
    });
  }

  for (const ev of q2Handlers) {
    socket.on(ev, async (payload, ack) => {
      const items = extractItems(payload);
      const raw = items[0] || "";
      const clean = toStringSafe(raw).trim();
      if (!clean) {
        if (typeof ack === "function") ack({ ok: false, reason: "no-item" });
        return;
      }

      const canon = await canonicalize(clean);
      if (!canon) {
        if (typeof ack === "function") ack({ ok: false, reason: "no-canon" });
        return;
      }

      state.q2.set(canon, (state.q2.get(canon) || 0) + 1);
      emitState();
      if (typeof ack === "function") ack({ ok: true, q2Size: state.q2.size });
    });
  }
});

// Render expone PORT en env
const PORT = Number(process.env.PORT || 3000);
httpServer.listen(PORT, () => console.log("Servidor activo en puerto", PORT));
