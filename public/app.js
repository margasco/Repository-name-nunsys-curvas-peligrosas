document.addEventListener("DOMContentLoaded", () => {
  // Socket robusto en Render (websocket + fallback)
  const socket = io({
    transports: ["websocket", "polling"],
  });

  const view = document.body.dataset.view; // "join" o "presenter"

  // ======================
  // UTIL: render nube
  // ======================
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

    const max = items[0].count || 1;

    items.forEach(({ text, count }) => {
      const span = document.createElement("span");
      span.className = "cloud-word";
      span.textContent = String(text || "").toUpperCase();

      const size = 16 + (count / max) * 48;
      span.style.fontSize = `${size}px`;

      container.appendChild(span);
    });
  }

  // ======================
  // SOCKET: estado conexión (para debug real)
  // ======================
  function setSocketStatus(msg) {
    // En presenter existe #socketStatus (según tu HTML)
    const el = document.getElementById("socketStatus");
    if (el) el.textContent = msg;
  }

  socket.on("connect", () => {
    console.log("🟢 Socket conectado:", socket.id);
    setSocketStatus("🟢 Conectado");
  });

  socket.on("disconnect", (reason) => {
    console.log("🔴 Socket desconectado:", reason);
    setSocketStatus("🔴 Desconectado");
  });

  socket.on("connect_error", (err) => {
    console.log("⚠️ connect_error:", err?.message || err);
    setSocketStatus("⚠️ Error de conexión");
  });

  // ======================
  // JOIN (alumnos)
  // ======================
  if (view === "join") {
    const q1Input = document.getElementById("q1Input");
    const q1Add = document.getElementById("q1Add");
    const q1Send = document.getElementById("q1Send");
    const q1Chips = document.getElementById("q1Chips");

    const q2Input = document.getElementById("q2Input");
    const q2Send = document.getElementById("q2Send");

    const q1Items = [];

    function flashBtn(btn, text, ms = 900) {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = text;
      setTimeout(() => (btn.textContent = old), ms);
    }

    function addChip(v) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = v;
      q1Chips.appendChild(chip);
    }

    q1Add?.addEventListener("click", () => {
      const v = q1Input.value.trim();
      if (!v) return;

      q1Items.push(v);
      q1Input.value = "";
      addChip(v);
      q1Input.focus();
    });

    // Enter = añadir (más natural en móvil)
    q1Input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        q1Add?.click();
      }
    });

    q2Input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        q2Send?.click();
      }
    });

    // ENVIAR Q1 con ACK (confirmación del servidor)
    q1Send?.addEventListener("click", () => {
      if (q1Items.length === 0) return;

      // Si no hay conexión, lo verás claro
      if (!socket.connected) {
        console.log("❌ No conectado: no se puede enviar Q1");
        flashBtn(q1Send, "Sin conexión");
        return;
      }

      const payload = { items: [...q1Items] };

      socket.timeout(3000).emit("q1:submit", payload, (err, res) => {
        if (err) {
          console.log("❌ Q1 ACK timeout/error:", err);
          flashBtn(q1Send, "Error envío");
          return;
        }

        console.log("✅ Q1 enviado OK:", res);
        flashBtn(q1Send, "Enviado ✓");

        // limpiamos solo si el servidor lo confirma
        q1Items.length = 0;
        if (q1Chips) q1Chips.innerHTML = "";
      });
    });

    // ENVIAR Q2 con ACK
    q2Send?.addEventListener("click", () => {
      const v = q2Input.value.trim();
      if (!v) return;

      if (!socket.connected) {
        console.log("❌ No conectado: no se puede enviar Q2");
        flashBtn(q2Send, "Sin conexión");
        return;
      }

      const payload = { item: v };

      socket.timeout(3000).emit("q2:submit", payload, (err, res) => {
        if (err) {
          console.log("❌ Q2 ACK timeout/error:", err);
          flashBtn(q2Send, "Error envío");
          return;
        }

        console.log("✅ Q2 enviado OK:", res);
        flashBtn(q2Send, "Enviado ✓");
        q2Input.value = "";
      });
    });
  }

  // ======================
  // PRESENTER (moderador)
  // ======================
  if (view === "presenter") {
    const cloudBox = document.getElementById("cloudBox");
    const modalCloud = document.getElementById("modalCloud");
    const cloudTitle = document.getElementById("cloudTitle");

    let current = "q1";
    let lastState = { q1: [], q2: [] };

    function refresh() {
      const data = lastState[current] || [];
      renderCloud(cloudBox, data);
      renderCloud(modalCloud, data);

      cloudTitle.textContent =
        current === "q1"
          ? "¿QUÉ TAREAS TE CONSUMEN MÁS TIEMPO?"
          : "¿CUÁL ES LA TAREA QUE MENOS TE GUSTA REALIZAR?";
    }

    socket.on("state:update", (state) => {
      // Esto debería saltar SIEMPRE que alguien envía
      console.log("📥 state:update recibido:", state);
      lastState = state || { q1: [], q2: [] };
      refresh();
    });

    document.getElementById("viewQ1")?.addEventListener("click", () => {
      current = "q1";
      refresh();
    });

    document.getElementById("viewQ2")?.addEventListener("click", () => {
      current = "q2";
      refresh();
    });

    // RESET con ACK (para que “se note” que ha hecho algo)
    document.getElementById("resetBtn")?.addEventListener("click", () => {
      const btn = document.getElementById("resetBtn");
      if (!socket.connected) return;

      socket.timeout(3000).emit("admin:reset", (err, res) => {
        if (err) {
          console.log("❌ Reset error/timeout:", err);
          if (btn) btn.textContent = "RESET (error)";
          setTimeout(() => btn && (btn.textContent = "RESET"), 900);
          return;
        }

        console.log("✅ Reset OK:", res);
        if (btn) btn.textContent = "RESET ✓";
        setTimeout(() => btn && (btn.textContent = "RESET"), 900);
      });
    });

    // QR
    const joinUrl = `${location.origin}/join`;
    const qrImg = document.getElementById("qrImg");
    const joinUrlEl = document.getElementById("joinUrl");

    if (qrImg) qrImg.src = `/qr?u=${encodeURIComponent(joinUrl)}`;
    if (joinUrlEl) joinUrlEl.textContent = joinUrl;
  }
});
