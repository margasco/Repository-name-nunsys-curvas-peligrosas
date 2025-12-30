document.addEventListener("DOMContentLoaded", () => {
  // Socket robusto en Render (websocket + fallback)
  const socket = io({
    transports: ["websocket", "polling"],
  });

  const view = document.body.dataset.view; // "join" o "presenter"

  // ======================
  // UTIL: helpers
  // ======================
  const LS_KEY = "curvas:lastState:v1";

  function safeJsonParse(s, fallback) {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  }

  function isEmptyState(st) {
    const q1 = Array.isArray(st?.q1) ? st.q1.length : 0;
    const q2 = Array.isArray(st?.q2) ? st.q2.length : 0;
    return q1 === 0 && q2 === 0;
  }

  function hasAnyData(st) {
    const q1 = Array.isArray(st?.q1) ? st.q1.length : 0;
    const q2 = Array.isArray(st?.q2) ? st.q2.length : 0;
    return q1 + q2 > 0;
  }

  function setSocketStatus(msg) {
    // En presenter existe #socketStatus (según tu HTML)
    const el = document.getElementById("socketStatus");
    if (el) el.textContent = msg;
  }

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

    const max = items[0]?.count || 1;

    items.forEach(({ text, count }, idx) => {
      const span = document.createElement("span");
      span.className = "cloud-word";
      span.textContent = String(text || "").toUpperCase();

      // Tamaño proporcional (cuanto más repetida, más grande)
      const size = 16 + (Number(count || 0) / max) * 48;
      span.style.fontSize = `${size}px`;

      // ✅ Estética: rosa NUNSYS + menos “mazo” que negro/bold
      span.style.color = "var(--pink)";
      span.style.fontWeight = "650";
      span.style.fontFamily =
        "ui-rounded, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";

      // ✅ Top visual un poquito más destacado
      if (idx === 0) {
        span.style.background = "rgba(255,74,167,.14)";
        span.style.borderColor = "rgba(255,74,167,.38)";
      }

      container.appendChild(span);
    });
  }

  // ======================
  // SOCKET: estado conexión (debug real)
  // ======================
  let lastDisconnectAt = 0;

  socket.on("connect", () => {
    console.log("🟢 Socket conectado:", socket.id);
    setSocketStatus("🟢 Conectado");
  });

  socket.on("disconnect", (reason) => {
    console.log("🔴 Socket desconectado:", reason);
    lastDisconnectAt = Date.now();
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
    let sendingQ1 = false;
    let sendingQ2 = false;

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
      q1Chips?.appendChild(chip);
    }

    function clearQ1UI() {
      q1Items.length = 0;
      if (q1Chips) q1Chips.innerHTML = "";
      if (q1Input) q1Input.value = "";
    }

    function emitOptimistic(eventName, payload, btn, onSuccess) {
      // Si no hay conexión, lo dejamos claro
      if (!socket.connected) {
        console.log(`❌ No conectado: no se puede enviar ${eventName}`);
        flashBtn(btn, "Sin conexión");
        return;
      }

      let done = false;

      // ✅ IMPORTANTE:
      // Aunque el server ya responde ACK inmediato, si algo raro ocurre en móvil/red,
      // NO queremos falsos “Error envío”. Si no vuelve callback rápido, asumimos OK.
      const optimisticTimer = setTimeout(() => {
        if (done) return;
        done = true;
        console.log(`⚠️ ACK tardío/no devuelto en ${eventName} → asumimos enviado`);
        flashBtn(btn, "Enviado ✓");
        onSuccess?.();
      }, 900);

      try {
        socket.emit(eventName, payload, (res) => {
          if (done) return;
          done = true;
          clearTimeout(optimisticTimer);

          if (res && res.ok === false) {
            console.log(`❌ Server respondió ok:false en ${eventName}:`, res);
            flashBtn(btn, "Error envío");
            return;
          }

          console.log(`✅ ${eventName} enviado OK:`, res);
          flashBtn(btn, "Enviado ✓");
          onSuccess?.();
        });
      } catch (e) {
        console.log(`⚠️ Emit error en ${eventName}:`, e);
        clearTimeout(optimisticTimer);
        flashBtn(btn, "Enviado ✓");
        onSuccess?.();
      }
    }

    q1Add?.addEventListener("click", () => {
      const v = q1Input?.value?.trim() || "";
      if (!v) return;

      q1Items.push(v);
      if (q1Input) q1Input.value = "";
      addChip(v);
      q1Input?.focus();
    });

    // Enter = añadir (móvil)
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

    // ENVIAR Q1
    q1Send?.addEventListener("click", () => {
      if (sendingQ1) return;
      if (q1Items.length === 0) return;

      sendingQ1 = true;
      if (q1Send) q1Send.disabled = true;

      const payload = { items: [...q1Items] };

      emitOptimistic("q1:submit", payload, q1Send, () => {
        // ✅ UX: al enviar, desaparecen los chips (como querías)
        clearQ1UI();

        sendingQ1 = false;
        if (q1Send) q1Send.disabled = false;
      });

      // seguridad extra por si algo rarísimo bloquea
      setTimeout(() => {
        sendingQ1 = false;
        if (q1Send) q1Send.disabled = false;
      }, 2000);
    });

    // ENVIAR Q2
    q2Send?.addEventListener("click", () => {
      if (sendingQ2) return;

      const v = q2Input?.value?.trim() || "";
      if (!v) return;

      sendingQ2 = true;
      if (q2Send) q2Send.disabled = true;

      const payload = { item: v };

      emitOptimistic("q2:submit", payload, q2Send, () => {
        // ✅ UX: al enviar, limpiamos input
        if (q2Input) q2Input.value = "";

        sendingQ2 = false;
        if (q2Send) q2Send.disabled = false;
      });

      setTimeout(() => {
        sendingQ2 = false;
        if (q2Send) q2Send.disabled = false;
      }, 2000);
    });
  }

  // ======================
  // PRESENTER (moderador)
  // ======================
  if (view === "presenter") {
    const cloudBox = document.getElementById("cloudBox");
    const modalCloud = document.getElementById("modalCloud");
    const cloudTitle = document.getElementById("cloudTitle");

    // Zoom modal elements (según tu presenter.html)
    const zoomBtn = document.getElementById("zoomBtn");
    const zoomModal = document.getElementById("zoomModal");
    const modalClose = document.getElementById("modalClose");
    const modalX = document.getElementById("modalX");
    const modalTitle = document.getElementById("modalTitle");

    let current = "q1";
    let lastState =
      safeJsonParse(localStorage.getItem(LS_KEY), null) || { q1: [], q2: [] };

    // Para evitar “borrado fantasma”
    let resetRequestedAt = 0;

    function currentTitle() {
      return current === "q1"
        ? "¿QUÉ TAREAS TE CONSUMEN MÁS TIEMPO?"
        : "¿CUÁL ES LA TAREA QUE MENOS TE GUSTA REALIZAR?";
    }

    function refresh() {
      const data = lastState[current] || [];
      renderCloud(cloudBox, data);
      renderCloud(modalCloud, data);

      const title = currentTitle();
      if (cloudTitle) cloudTitle.textContent = title;
      if (modalTitle) modalTitle.textContent = title;
    }

    // Pintar inmediatamente lo cacheado (si hay) para evitar parpadeos
    refresh();

    socket.on("state:update", (state) => {
      console.log("📥 state:update recibido:", state);

      const incoming = state || { q1: [], q2: [] };
      const incomingEmpty = isEmptyState(incoming);
      const weHaveData = hasAnyData(lastState);

      // ✅ Si llega vacío “de golpe” y NO has hecho reset,
      // y además hubo desconexión reciente, NO borramos.
      const recentlyDisconnected = Date.now() - lastDisconnectAt < 15000;
      const recentlyReset = Date.now() - resetRequestedAt < 8000;

      if (incomingEmpty && weHaveData && !recentlyReset && recentlyDisconnected) {
        console.log(
          "⚠️ Estado vacío tras desconexión reciente → mantenemos último estado (anti-borrado)."
        );
        setSocketStatus("🟡 Conectado (mostrando últimos datos)");
        refresh();
        return;
      }

      lastState = incoming;
      localStorage.setItem(LS_KEY, JSON.stringify(lastState));
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

    // RESET con “permitir vacío”
    document.getElementById("resetBtn")?.addEventListener("click", () => {
      const btn = document.getElementById("resetBtn");
      if (!socket.connected) return;

      resetRequestedAt = Date.now();

      let done = false;
      const optimisticTimer = setTimeout(() => {
        if (done) return;
        done = true;
        if (btn) btn.textContent = "RESET ✓";
        setTimeout(() => btn && (btn.textContent = "RESET"), 900);
      }, 900);

      socket.emit("admin:reset", (res) => {
        if (done) return;
        done = true;
        clearTimeout(optimisticTimer);

        console.log("✅ Reset response:", res);
        if (btn) btn.textContent = "RESET ✓";
        setTimeout(() => btn && (btn.textContent = "RESET"), 900);
      });
    });

    // ✅ ZOOM: abrir/cerrar modal (robusto)
    function openZoom() {
      if (!zoomModal) return;
      zoomModal.classList.add("open");
      zoomModal.setAttribute("aria-hidden", "false");
    }

    function closeZoom() {
      if (!zoomModal) return;
      zoomModal.classList.remove("open");
      zoomModal.setAttribute("aria-hidden", "true");
    }

    zoomBtn?.addEventListener("click", () => openZoom());
    modalClose?.addEventListener("click", () => closeZoom());
    modalX?.addEventListener("click", () => closeZoom());

    // Cerrar al clicar fuera del panel (backdrop)
    zoomModal?.addEventListener("click", (e) => {
      if (e.target === zoomModal) closeZoom();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeZoom();
    });

    // QR
    const joinUrl = `${location.origin}/join`;
    const qrImg = document.getElementById("qrImg");
    const joinUrlEl = document.getElementById("joinUrl");

    if (qrImg) qrImg.src = `/qr?u=${encodeURIComponent(joinUrl)}`;
    if (joinUrlEl) joinUrlEl.textContent = joinUrl;
  }
});
