document.addEventListener("DOMContentLoaded", () => {
  const socket = io();

  const view = document.body.dataset.view; // "join" o "presenter"

  // -------------------------
  // Util: render nube
  // -------------------------
  function renderCloud(container, items) {
    if (!container) return;

    container.innerHTML = "";

    if (!items || items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cloud-empty";
      empty.textContent = "Aún no hay respuestas…";
      container.appendChild(empty);
      return;
    }

    const max = Math.max(...items.map(x => x.count), 1);
    const min = Math.min(...items.map(x => x.count), 1);

    // Escala de tamaños (más visual)
    const minSize = 14;
    const maxSize = 54;

    items.forEach(({ text, count }) => {
      const t = document.createElement("span");
      t.className = "word";

      // ✅ Siempre en MAYÚSCULAS en la nube (como pediste)
      t.textContent = String(text || "").toUpperCase();

      // Normalización de tamaño (evita que todo quede igual)
      const norm = (count - min) / (max - min + 1e-9);
      const size = Math.round(minSize + norm * (maxSize - minSize));

      t.style.fontSize = `${size}px`;
      t.style.setProperty("--w", size);

      // un pelín de “peso” extra según frecuencia
      if (count >= max) t.classList.add("top");
      if (count <= min) t.classList.add("low");

      // Tooltip con recuento
      t.title = `${count} votos`;

      container.appendChild(t);
    });
  }

  // -------------------------
  // JOIN: botones + envío
  // -------------------------
  if (view === "join") {
    const q1Input = document.getElementById("q1Input");
    const q1Add = document.getElementById("q1Add");
    const q1Send = document.getElementById("q1Send");
    const q1Chips = document.getElementById("q1Chips");

    const q2Input = document.getElementById("q2Input");
    const q2Send = document.getElementById("q2Send");

    let q1Items = [];

    function addChip(text) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = text;

      const x = document.createElement("button");
      x.className = "chip-x";
      x.type = "button";
      x.textContent = "×";
      x.addEventListener("click", () => {
        q1Items = q1Items.filter(v => v !== text);
        chip.remove();
      });

      chip.appendChild(x);
      q1Chips.appendChild(chip);
    }

    q1Add?.addEventListener("click", () => {
      const raw = (q1Input?.value || "").trim();
      if (!raw) return;
      q1Items.push(raw);
      addChip(raw);
      q1Input.value = "";
      q1Input.focus();
    });

    q1Input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") q1Add?.click();
    });

    q1Send?.addEventListener("click", () => {
      if (!q1Items.length) return;
      socket.emit("q1:submit", { items: q1Items });
      // Limpieza visual
      q1Items = [];
      q1Chips.innerHTML = "";
    });

    q2Send?.addEventListener("click", () => {
      const raw = (q2Input?.value || "").trim();
      if (!raw) return;
      socket.emit("q2:submit", { item: raw });
      q2Input.value = "";
      q2Input.focus();
    });

    q2Input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") q2Send?.click();
    });
  }

  // -------------------------
  // PRESENTER: QR + nube + vistas
  // -------------------------
  if (view === "presenter") {
    const cloudQ1 = document.getElementById("cloudQ1");
    const cloudQ2 = document.getElementById("cloudQ2");

    const resetBtn = document.getElementById("resetBtn");

    const joinUrlEl = document.getElementById("joinUrl");
    const qrHintEl = document.getElementById("qrHint");
    const qrCanvas = document.getElementById("qrCanvas");

    const btnCompare = document.getElementById("viewCompare");
    const btnQ1 = document.getElementById("viewQ1");
    const btnQ2 = document.getElementById("viewQ2");
    const grid = document.getElementById("presenterGrid");

    const cardQ1 = document.getElementById("cardQ1");
    const cardQ2 = document.getElementById("cardQ2");

    // QR a /join
    const joinUrl = `${window.location.origin}/join`;
    if (joinUrlEl) joinUrlEl.textContent = joinUrl;

    function setSeg(active) {
      [btnCompare, btnQ1, btnQ2].forEach(b => b?.classList.remove("on"));
      if (active === "compare") btnCompare?.classList.add("on");
      if (active === "q1") btnQ1?.classList.add("on");
      if (active === "q2") btnQ2?.classList.add("on");
    }

    function setMode(mode) {
      grid?.classList.remove("mode-compare", "mode-q1", "mode-q2");
      if (mode === "compare") grid?.classList.add("mode-compare");
      if (mode === "q1") grid?.classList.add("mode-q1");
      if (mode === "q2") grid?.classList.add("mode-q2");
      setSeg(mode);
    }

    btnCompare?.addEventListener("click", () => setMode("compare"));
    btnQ1?.addEventListener("click", () => setMode("q1"));
    btnQ2?.addEventListener("click", () => setMode("q2"));

    // Zoom por tarjeta
    document.querySelectorAll(".zoomBtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const which = btn.dataset.zoom; // q1 o q2
        if (which === "q1") setMode("q1");
        if (which === "q2") setMode("q2");
      });
    });

    // Default: comparar
    setMode("compare");

    // Generación QR (usa librería qrcode)
    try {
      if (window.QRCode && qrCanvas) {
        window.QRCode.toCanvas(qrCanvas, joinUrl, { margin: 1, width: 240 }, (err) => {
          if (err && qrHintEl) qrHintEl.textContent = "No se pudo generar el QR.";
        });
      } else if (qrHintEl) {
        qrHintEl.textContent = "Cargando generador de QR…";
      }
    } catch {
      if (qrHintEl) qrHintEl.textContent = "No se pudo generar el QR.";
    }

    resetBtn?.addEventListener("click", () => socket.emit("admin:reset"));

    // Recibir estado en tiempo real y pintar
    socket.on("state:update", (payload) => {
      const q1 = payload?.q1 || [];
      const q2 = payload?.q2 || [];
      renderCloud(cloudQ1, q1);
      renderCloud(cloudQ2, q2);
    });
  }
});
