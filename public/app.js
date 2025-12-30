document.addEventListener("DOMContentLoaded", () => {
  // Forzamos a que Socket.IO pueda conectar bien en Render (websocket/polling)
  const socket = io({ transports: ["websocket", "polling"] });
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

      // Normalizamos a MAYÚSCULAS (visual)
      span.textContent = String(text || "").toUpperCase();

      // Tamaño proporcional (suave)
      const ratio = Math.max(0, Math.min(1, (count || 0) / max));
      const size = 18 + ratio * 54; // 18..72
      span.style.fontSize = `${size}px`;

      container.appendChild(span);
    });
  }

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

    function addQ1ItemFromInput() {
      if (!q1Input) return;
      const v = q1Input.value.trim();
      if (!v) return;

      q1Items.push(v);
      q1Input.value = "";

      if (q1Chips) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = v;
        q1Chips.appendChild(chip);
      }
    }

    q1Add?.addEventListener("click", addQ1ItemFromInput);

    // Enter en Q1: añade
    q1Input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addQ1ItemFromInput();
      }
    });

    q1Send?.addEventListener("click", () => {
      // Si el usuario escribió algo y no le dio a "Añadir", lo metemos igualmente
      const pending = q1Input?.value?.trim();
      if (pending) addQ1ItemFromInput();

      if (q1Items.length === 0) return;

      socket.emit("q1:submit", { items: q1Items.slice() });

      q1Items.length = 0;
      if (q1Chips) q1Chips.innerHTML = "";
    });

    // Enter en Q2: envía
    q2Input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        q2Send?.click();
      }
    });

    q2Send?.addEventListener("click", () => {
      const v = q2Input?.value?.trim();
      if (!v) return;

      socket.emit("q2:submit", { item: v });
      q2Input.value = "";
    });
  }

  // ======================
  // PRESENTER (moderador)
  // ======================
  if (view === "presenter") {
    const cloudBox = document.getElementById("cloudBox");
    const modalCloud = document.getElementById("modalCloud");
    const cloudTitle = document.getElementById("cloudTitle");

    const btnQ1 = document.getElementById("viewQ1");
    const btnQ2 = document.getElementById("viewQ2");

    const resetBtn = document.getElementById("resetBtn");

    const zoomBtn = document.getElementById("zoomBtn");
    const zoomModal = document.getElementById("zoomModal");
    const modalClose = document.getElementById("modalClose");
    const modalX = document.getElementById("modalX");
    const modalTitle = document.getElementById("modalTitle");

    const socketStatus = document.getElementById("socketStatus");

    let current = "q1";
    let lastState = { q1: [], q2: [] };

    function setActiveTab() {
      if (!btnQ1 || !btnQ2) return;
      if (current === "q1") {
        btnQ1.classList.add("on");
        btnQ2.classList.remove("on");
      } else {
        btnQ2.classList.add("on");
        btnQ1.classList.remove("on");
      }
    }

    function getTitle() {
      return current === "q1"
        ? "¿QUÉ TAREAS TE CONSUMEN MÁS TIEMPO?"
        : "¿CUÁL ES LA TAREA QUE MENOS TE GUSTA REALIZAR?";
    }

    function refresh() {
      setActiveTab();

      const data = lastState[current] || [];
      renderCloud(cloudBox, data);
      renderCloud(modalCloud, data);

      if (cloudTitle) cloudTitle.textContent = getTitle();
      if (modalTitle) modalTitle.textContent = getTitle();
    }

    // --- SOCKET STATUS (debug útil)
    function setStatus(text) {
      if (socketStatus) socketStatus.textContent = text;
    }

    socket.on("connect", () => setStatus("Conectado · tiempo real activo ✅"));
    socket.on("disconnect", () => setStatus("Desconectado · reintentando… ⚠️"));
    socket.io.on("reconnect_attempt", () => setStatus("Reconectando… ⏳"));
    socket.on("connect_error", () => setStatus("Error de conexión · revisa red ⚠️"));

    // Estado en tiempo real
    socket.on("state:update", (state) => {
      lastState = state || { q1: [], q2: [] };
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

    resetBtn?.addEventListener("click", () => {
      socket.emit("admin:reset");
    });

    // --- QR
    const joinUrl = `${location.origin}/join`;
    const qrImg = document.getElementById("qrImg");
    const joinUrlEl = document.getElementById("joinUrl");

    if (qrImg) qrImg.src = `/qr?u=${encodeURIComponent(joinUrl)}`;
    if (joinUrlEl) joinUrlEl.textContent = joinUrl;

    // --- ZOOM MODAL
    function openModal() {
      if (!zoomModal) return;
      zoomModal.classList.add("open");
      zoomModal.setAttribute("aria-hidden", "false");
      refresh(); // asegúrate de que modalCloud se pinta al abrir
    }

    function closeModal() {
      if (!zoomModal) return;
      zoomModal.classList.remove("open");
      zoomModal.setAttribute("aria-hidden", "true");
    }

    zoomBtn?.addEventListener("click", openModal);
    modalClose?.addEventListener("click", closeModal);
    modalX?.addEventListener("click", closeModal);

    // Cerrar con ESC
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });

    // Primera pinta
    refresh();
  }
});
