import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import { pipeline } from "@xenova/transformers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Sirve TODO lo que haya dentro de /public (css, js, html, etc.)
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    // Forzamos el tipo correcto para que el navegador NO “descargue” el HTML
    if (filePath.endsWith(".html")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Disposition", "inline");
    }
  }
}));

// Al entrar en la URL base, llevamos a /join (alumnos)
app.get("/", (_req, res) => {
  res.redirect("/join");
});

// Vista alumnos (2 encuestas)
app.get("/join", (_req, res) => {
  res.type("html");
  res.sendFile(path.join(__dirname, "public", "join.html"));
});

// Vista moderador (QR + nubes + franja animada)
app.get("/presenter", (_req, res) => {
  res.type("html");
  res.sendFile(path.join(__dirname, "public", "presenter.html"));
});

// Si alguien entra a cualquier otra ruta, lo llevamos a /join
app.get("*", (_req, res) => {
  res.redirect("/join");
});

const httpServer = createServer(app);
const io = new Server(httpServer);

// ===== ESTADO DE LA APP (se borra con RESET) =====
const state = {
  q1: new Map(),
  q2: new Map(),
  canonEmbeddings: new Map(),
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
  io.emit("state:update", {
    q1: mapToArray(state.q1),
    q2: mapToArray(state.q2),
  });
}

// ===== NORMALIZACIÓN DE TEXTO (ANTES DE IA) =====
const STOP = new Set([
  "de","la","el","los","las","un","una","y","o","a","en","para","por","con",
  "del","al","que","me","mi","mis","tu","tus","su","sus","hacer","realizar"
]);

const SYN = [
  { re: /\b(e-?mails?|emails?)\b/g, to: "correo" },
  { re: /\b(outlook)\b/g, to: "correo" },
  { re: /\b(reuniones?)\b/g, to: "reunion" },
  { re: /\b(informes?)\b/g, to: "informe" },
  { re: /\b(reportes?)\b/g, to: "informe" },
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

// ===== IA LOCAL (SIN API KEYS) =====
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

async function embed(text) {
  const embedder = await getEmbedder();
  const out = await embedder(text, { pooling: "mean", normalize: true });
  return Float32Array.from(out.data);
}

async function canonicalize(userText, threshold = 0.78) {
  const norm = normalizeText(userText);
  if (!norm) return null;
  if (state.canonEmbeddings.has(norm)) return norm;

  let v;
  try {
    v = await embed(norm);
  } catch {
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

// ===== SOCKETS (TIEMPO REAL) =====
io.on("connection", (socket) => {
  socket.emit("state:update", {
    q1: mapToArray(state.q1),
    q2: mapToArray(state.q2),
  });

  socket.on("admin:reset", () => {
    resetAll();
    emitState();
  });

  socket.on("q1:submit", async ({ items }) => {
    for (const raw of items || []) {
      const canon = await canonicalize(raw);
      if (!canon) continue;
      state.q1.set(canon, (state.q1.get(canon) || 0) + 1);
    }
    emitState();
  });

  socket.on("q2:submit", async ({ item }) => {
    const canon = await canonicalize(item);
    if (!canon) return;
    state.q2.set(canon, (state.q2.get(canon) || 0) + 1);
    emitState();
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log("Servidor activo en puerto", PORT));
