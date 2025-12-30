document.addEventListener("DOMContentLoaded", () => {
  // ======================
  // SOCKET (más robusto)
  // ======================
  const socket = io({
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 600,
    reconnectionDelayMax: 2500,
    timeout: 20000, // timeout de conexión inicial
  });

  const view = document.body.dataset.view; // "join" o "presenter"

  // ======================
  // UTIL: storage + helpers
  // ======================
  const LS_STATE_KEY = "curvas:lastState:v2";
  const LS_OUTBOX_KEY = "curvas:outbox:v1";

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

  function now() {
    return Date.now();
  }

  function setSocketStatus(msg) {
    const el = document.getElementById("socketStatus");
    if (el) el.textContent = msg;
  }

  // ======================
  // OUTBOX (cola offline)
  // ======================
  function getOutbox() {
    return safeJsonParse(localStorage.getItem(LS_OUTBOX_KEY), []) || [];
  }

  function setOutbox(items) {
    localStorage.setItem(LS_OUTBOX_KEY, JSON.stringify(items));
  }

  function enqueue(eventName, payload) {
    const outbox = getOutbox();
    outbox.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ev: eventName,
      payload,
      ts: Date.now(),
    });
    // límite para no crecer infinito si alguien está sin red
    while (outbox.length > 50) outbox.shift();
    setOutbox(outbox);
  }

  function drainOutbox() {
    if (!socket.connected) return;

    const outbox = getOutbox();
    if (!outbox.length) return;

    // enviamos en orden; si algo falla, seguimos (best-effort)
    const remaining = [];
    for (const msg of outbox) {
      try {
        socket.emit(msg.ev, msg.payload, () => {});
      } catch {
        remaining.push(msg);
      }
    }
    setOutbox(remaining);
  }

  // ======================
  // RENDER NUBE (mejor escalado)
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

    // items viene ordenado desc por count (del server)
    const max = Number(items[0]?.count || 1);
    const n = items.length;

    // Ajuste dinámico para que NO se “coma” la pantalla si hay muchas palabras
    const minSize = 14;
    const maxSize = n > 40 ? 46 : n > 25 ? 54 : 64;

    const logMax = Math.log(max + 1);

    items.forEach(({ text, count }, idx) => {
      const span = document.createElement("span");
      span.className = "cloud-word";
      span.textContent = String(text || "").toUpperCase();

      const c = Math.max(1, Number(count || 1));
      // log scaling: separa bien 1,2,3… sin que “explote” el top
      const t = logMax > 0 ? Math.log(c + 1) / logMax : 0;
      const size = Math.round(minSize + t * (maxSize - minSize));
      span.style.fontSize = `${size}px`;

      // estética (rosa + menos pesado)
      span.style.color = "var(--pink)";
      span.style.fontWeight = "650";
      span.style.fontFamily =
        "ui-rounded, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";

      // micro-destacado del #1
      if (idx === 0) {
        span.style.background = "rgba(255,74,167,.14)";
        span.style.borderColor = "rgba(255,74,167,.38)";
      }

      // suaviza cambios al actualizar en vivo
      span.style.transition = "font-size 220ms ease, transform 220ms ease";
      container.appendChild(span);
    });
  }

  // ======================
  // SOCKET: estados conexión
  // ======================
  let lastDisconnectAt = 0;
  let lastConnectAt = 0;

  socket.on("connect", () => {
    lastConnectAt = now();
    console.log("🟢 Socket conectado:", socket.id);
    setSocketStatus("🟢 Conectado");
    drainOutbox();
  });

  socket.on("disconnect", (reason) => {
    console.log("🔴 Socket desconectado:", reason);
    lastDisconnectAt = now();
    setSocketStatus("🔴 Desconectado");
  });

  socket.on("connect_error", (err) => {
    // IMPORTANTE: connect_error a veces no dispara disconnect, pero ES un corte real
    console.log("⚠️ connect_error:", err?.message || err);
    lastDisconnectAt = now();
    setSocketStatus("⚠️ Error de conexión");
  });

  socket.io.on("reconnect_attempt", () => {
    setSocketStatus("🟡 Reintentando conexión…");
  });

  socket.io.on("reconnect", () => {
    setSocketStatus("🟢 Conectado");
    drainOutbox();
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

    function emitReliable(eventName, payload, btn, onSuccess) {
      // si no hay conexión: ENCOLA y UX OK (no error)
      if (!socket.connected) {
        enqueue(eventName, payload);
        flashBtn(btn, "En cola ✓");
        onSuccess?.();
        return;
      }

      let done = false;

      // si el ACK no vuelve (red móvil), no castigamos la UX
      const optimisticTimer = setTimeout(() => {
        if (done) return;
        done = true;
        flashBtn(btn, "Enviado ✓");
        onSuccess?.();
      }, 900);

      try {
        socket.emit(eventName, payload, (res) => {
          if (done) return;
          done = true;
          clearTimeout(optimisticTimer);

          if (res && res.ok === false) {
            flashBtn(btn, "Error envío");
            return;
          }

          flashBtn(btn, "Enviado ✓");
          onSuccess?.();
        });
      } catch (e) {
        clearTimeout(optimisticTimer);
        enqueue(eventName, payload);
        flashBtn(btn, "En cola ✓");
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

      emitReliable("q1:submit", payload, q1Send, () => {
        // UX: desaparecen chips al enviar (o al encolar)
        clearQ1UI();

        sendingQ1 = false;
        if (q1Send) q1Send.disabled = false;
      });

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

      emitReliable("q2:submit", payload, q2Send, () => {
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

    const zoomBtn = document.getElementById("zoomBtn");
    const zoomModal = document.getElementById("zoomModal");
    const modalClose = document.getElementById("modalClose");
    const modalX = document.getElementById("modalX");
    const modalTitle = document.getElementById("modalTitle");

    let current = "q1";

    // arrancamos con cache (evita “pantalla vacía”)
    let lastState =
      safeJsonParse(localStorage.getItem(LS_STATE_KEY), null) || { q1: [], q2: [] };

    // “ventana” donde SÍ permitimos estado vacío (solo tras reset)
    let allowEmptyUntil = 0;

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

    refresh();

    socket.on("state:update", (state) => {
      const incoming = state || { q1: [], q2: [] };

      const incomingEmpty = isEmptyState(incoming);
      const weHaveData = hasAnyData(lastState);

      const recentlyDisconnected = now() - lastDisconnectAt < 30000; // más generoso
      const allowEmpty = now() < allowEmptyUntil;

      // ✅ Anti-borrado REAL:
      // Si llega vacío y nosotros ya teníamos datos,
      // y NO estamos en ventana de “permitir vacío” (reset),
      // y además hubo problemas de conexión → IGNORAMOS el vacío.
      if (incomingEmpty && weHaveData && !allowEmpty && recentlyDisconnected) {
        console.log("⚠️ Ignoramos estado vacío tras corte/reconexión (anti-borrado).");
        setSocketStatus("🟡 Conectado (mostrando últimos datos)");
        refresh();
        return;
      }

      // ✅ Si llega vacío y NO es reset, pero también hubo corte, preferimos mantener
      if (incomingEmpty && weHaveData && !allowEmpty && recentlyDisconnected) {
        refresh();
        return;
      }

      lastState = incoming;
      localStorage.setItem(LS_STATE_KEY, JSON.stringify(lastState));
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

    // RESET: borra de verdad en UI + cache, y permite estado vacío del server
    document.getElementById("resetBtn")?.addEventListener("click", () => {
      const btn = document.getElementById("resetBtn");

      // ventana donde aceptamos vacío (porque lo hemos pedido nosotros)
      allowEmptyUntil = now() + 12000;

      // ✅ borrar local inmediatamente (UX)
      lastState = { q1: [], q2: [] };
      localStorage.setItem(LS_STATE_KEY, JSON.stringify(lastState));
      refresh();

      if (!socket.connected) {
        if (btn) {
          btn.textContent = "RESET ✓";
          setTimeout(() => btn && (btn.textContent = "RESET"), 900);
        }
        return;
      }

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

        if (btn) btn.textContent = "RESET ✓";
        setTimeout(() => btn && (btn.textContent = "RESET"), 900);
      });
    });

    // ZOOM modal
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
