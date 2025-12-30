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

  // ✅ escribe en presenter (#socketStatus) y en join (#joinSocketStatus)
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

  // ✅ drenado FIFO más seguro (no borra toda la cola "a ciegas")
  function drainOutbox() {
    if (!socket.connected) return;

    const outbox = getOutbox();
    if (!outbox.length) return;

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
  // RENDER NUBE (jerarquía MUCHO más marcada + contador)
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
    const max = Math.max(1, Number(items[0]?.count || 1));
    const n = items.length;

    // Queremos MUCHA jerarquía:
    // - el top domina claramente cuando hay diferencia real
    // - pero sin que lo pequeño sea ilegible
    const minSize = 13;
    const maxSize = n > 40 ? 78 : n > 25 ? 88 : 96;

    // Escalado "power": si el top es 10x, se nota MUCHO.
    // t = (c/max)^p  con p < 1 amplifica diferencias en la cola,
    // pero aquí queremos lo contrario: más diferencia arriba, menos abajo,
    // así que usamos p > 1.
    const p = 1.75;

    items.forEach(({ text, count }, idx) => {
      const c = Math.max(1, Number(count || 1));

      const span = document.createElement("span");
      span.className = "cloud-word";
      span.textContent = String(text || "").toUpperCase();

      // ratio 0..1
      const r = c / max;
      // power scaling (más jerarquía)
      const t = Math.pow(r, 1 / p); // <— hace que el top escale más vs cola
      const size = Math.round(minSize + t * (maxSize - minSize));
      span.style.fontSize = `${size}px`;

      // micro-destacado del #1
      if (idx === 0) {
        span.style.background = "rgba(255,74,167,.14)";
        span.style.borderColor = "rgba(255,74,167,.38)";
      }

      // ✅ contador: badge
      const badge = document.createElement("span");
      badge.className = "cloud-count";
      badge.textContent = String(c);
      span.appendChild(badge);

      // suaviza cambios al actualizar en vivo
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

    function removeQ1ItemAt(index) {
      if (index < 0 || index >= q1Items.length) return;
      q1Items.splice(index, 1);
      renderQ1Chips();
    }

    function renderQ1Chips() {
      if (!q1Chips) return;
      q1Chips.innerHTML = "";

      q1Items.forEach((v, idx) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = v;

        const x = document.createElement("button");
        x.type = "button";
        x.className = "chip-x";
        x.setAttribute("aria-label", `Eliminar: ${v}`);
        x.textContent = "×";
        x.addEventListener("click", () => removeQ1ItemAt(idx));

        chip.appendChild(x);
        q1Chips.appendChild(chip);
      });
    }

    function clearQ1UI() {
      q1Items.length = 0;
      if (q1Chips) q1Chips.innerHTML = "";
      if (q1Input) q1Input.value = "";
    }

    function emitReliable(eventName, payload, btn, onSuccess) {
      if (!socket.connected) {
        enqueue(eventName, payload);
        flashBtn(btn, "En cola ✓");
        onSuccess?.();
        return;
      }

      let done = false;

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

    // ✅ Añadir chip manual
    q1Add?.addEventListener("click", () => {
      const v = q1Input?.value?.trim() || "";
      if (!v) return;

      q1Items.push(v);
      if (q1Input) q1Input.value = "";
      renderQ1Chips();
      q1Input?.focus();
    });

    // Enter en Q1 = Añadir
    q1Input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        q1Add?.click();
      }
    });

    // Enter en Q2 = Enviar
    q2Input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        q2Send?.click();
      }
    });

    // ✅ ENVIAR Q1:
    // - si hay chips: envía chips
    // - si hay input y no hay chips: envía 1 item
    // - si hay chips y hay input: añade el input automáticamente al envío
    q1Send?.addEventListener("click", () => {
      if (sendingQ1) return;

      const direct = q1Input?.value?.trim() || "";
      const hasChips = q1Items.length > 0;

      if (!hasChips && !direct) return;

      const itemsToSend = hasChips ? [...q1Items] : [];

      if (direct) itemsToSend.push(direct);

      sendingQ1 = true;
      if (q1Send) q1Send.disabled = true;

      const payload = { items: itemsToSend };

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

    const btnQ1 = document.getElementById("viewQ1");
    const btnQ2 = document.getElementById("viewQ2");

    let current = "q1";

    let lastState =
      safeJsonParse(localStorage.getItem(LS_STATE_KEY), null) || { q1: [], q2: [] };

    let allowEmptyUntil = 0;

    function currentTitle() {
      return current === "q1"
        ? "¿QUÉ TAREAS TE CONSUMEN MÁS TIEMPO?"
        : "¿CUÁL ES LA TAREA QUE MENOS TE GUSTA REALIZAR?";
    }

    function paintTabs() {
      if (!btnQ1 || !btnQ2) return;
      if (current === "q1") {
        btnQ1.classList.add("on");
        btnQ2.classList.remove("on");
        btnQ1.setAttribute("aria-selected", "true");
        btnQ2.setAttribute("aria-selected", "false");
      } else {
        btnQ2.classList.add("on");
        btnQ1.classList.remove("on");
        btnQ2.setAttribute("aria-selected", "true");
        btnQ1.setAttribute("aria-selected", "false");
      }
    }

    function refresh() {
      const data = lastState[current] || [];
      renderCloud(cloudBox, data);
      renderCloud(modalCloud, data);

      const title = currentTitle();
      if (cloudTitle) cloudTitle.textContent = title;
      if (modalTitle) modalTitle.textContent = title;

      paintTabs();
    }

    refresh();

    socket.on("state:update", (state) => {
      const incoming = state && (state.q1 || state.q2) ? state : { q1: [], q2: [] };

      const incomingQ1 = Array.isArray(incoming.q1) ? incoming.q1 : [];
      const incomingQ2 = Array.isArray(incoming.q2) ? incoming.q2 : [];

      const normalizedIncoming = { q1: incomingQ1, q2: incomingQ2 };

      const incomingEmpty = isEmptyState(normalizedIncoming);
      const weHaveData = hasAnyData(lastState);

      const recentlyDisconnected = now() - lastDisconnectAt < 30000;
      const allowEmpty = now() < allowEmptyUntil;

      if (incomingEmpty && weHaveData && !allowEmpty && recentlyDisconnected) {
        console.log("⚠️ Ignoramos estado vacío tras corte/reconexión (anti-borrado).");
        setSocketStatus("🟡 Conectado (mostrando últimos datos)");
        refresh();
        return;
      }

      lastState = normalizedIncoming;
      localStorage.setItem(LS_STATE_KEY, JSON.stringify(lastState));
      refresh();
    });

    btnQ1?.addEventListener("click", () => {
      current = "q1";
      refresh();
    });

    btnQ2?.addEventListener("click", () => {
      current = "q2";
      refresh();
    });

    document.getElementById("resetBtn")?.addEventListener("click", () => {
      const btn = document.getElementById("resetBtn");

      allowEmptyUntil = now() + 12000;

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
