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

  // ✅ FIX: escribe en presenter (#socketStatus) y en join (#joinSocketStatus)
  function setSocketStatus(msg) {
    const elPresenter = document.getElementById("socketStatus");
    if (elPresenter) elPresenter.textContent = msg;

    const elJoin = document.getElementById("joinSocketStatus");
    if (elJoin) elJoin.textContent = msg;
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
    while (outbox.length > 50) outbox.shift();
    setOutbox(outbox);
  }

  function drainOutbox() {
    if (!socket.connected) return;

    const outbox = getOutbox();
    if (!outbox.length) return;

    const remaining = [];
    for (const msg of outbox) {
      try {
        // envío best-effort: si no lanza error, lo damos por enviado
        socket.emit(msg.ev, msg.payload, () => {});
      } catch {
        remaining.push(msg);
      }
    }
    setOutbox(remaining);
  }

  // ======================
  // RENDER NUBE (escalado pro)
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

    // ✅ Evita que “reviente” si hay muchísimas palabras
    const minSize = 14;
    const maxSize = n > 40 ? 46 : n > 25 ? 54 : 64;

    const logMax = Math.log(max + 1);

    items.forEach(({ text, count }, idx) => {
      const span = document.createElement("span");
      span.className = "cloud-word";
      span.textContent = String(text || "").toUpperCase();

      const c = Math.max(1, Number(count || 1));

      // ✅ Escalado logarítmico: diferencia 1/2/3/4... pero sin gigantismos
      const t = logMax > 0 ? Math.log(c + 1) / logMax : 0;
      const size = Math.round(minSize + t * (maxSize - minSize));
      span.style.fontSize = `${size}px`;

      span.style.color = "var(--pink)";
      span.style.fontWeight = "650";
      span.style.fontFamily =
        "ui-rounded, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";

      if (idx === 0) {
        span.style.background = "rgba(255,74,167,.14)";
        span.style.borderColor = "rgba(255,74,167,.38)";
      }

      span.style.transition = "font-size 220ms ease, transform 220ms ease";
      container.appendChild(span);
    });
  }

  // ======================
  // SOCKET: estados conexión
  // ======================
  let lastDisconnectAt = 0;

  socket.on("connect", () => {
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
      // si no hay conexión: ENCOLA y UX OK
      if (!socket.connected) {
        enqueue(eventName, payload);
        flashBtn(btn, "En cola ✓");
        onSuccess?.();
        return;
      }

      let done = false;

      // si el ACK no vuelve (red móvil), no castigamos UX
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

    q1Send?.addEventListener("click", () => {
      if (sendingQ1) return;
      if (q1Items.length === 0) return;

      sendingQ1 = true;
      if (q1Send) q1Send.disabled = true;

      const payload = { items: [...q1Items] };

      emitReliable("q1:submit", payload, q1Send, () => {
        clearQ1UI();
        sendingQ1 = false;
        if (q1Send) q1Send.disabled = false;
      });

      setTimeout(() => {
        sendingQ1 = false;
        if (q1Send) q1Send.disabled = false;
      }, 2000);
    });

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

    let lastState =
      safeJsonParse(localStorage.getItem(LS_STATE_KEY), null) || { q1: [], q2: [] };

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
      // el server puede enviar {meta, q1, q2}. Nosotros solo miramos q1/q2.
      const incoming = state || { q1: [], q2: [] };

      const incomingEmpty = isEmptyState(incoming);
      const weHaveData = hasAnyData(lastState);

      const recentlyDisconnected = now() - lastDisconnectAt < 30000;
      const allowEmpty = now() < allowEmptyUntil;

      // ✅ FIX: anti-borrado limpio (sin if duplicado)
      if (incomingEmpty && weHaveData && !allowEmpty && recentlyDisconnected) {
        console.log("⚠️ Ignoramos estado vacío tras corte/reconexión (anti-borrado).");
        setSocketStatus("🟡 Conectado (mostrando últimos datos)");
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

    document.getElementById("resetBtn")?.addEventListener("click", () => {
      const btn = document.getElementById("resetBtn");

      allowEmptyUntil = now() + 12000;

      // ✅ UX: borrado inmediato local
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

      socket.emit("admin:reset", () => {
        if (done) return;
        done = true;
        clearTimeout(optimisticTimer);

        if (btn) btn.textContent = "RESET ✓";
        setTimeout(() => btn && (btn.textContent = "RESET"), 900);
      });
    });

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
