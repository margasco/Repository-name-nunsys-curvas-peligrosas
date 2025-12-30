document.addEventListener("DOMContentLoaded", () => {
  const view = document.body.dataset.view; // "join" o "presenter"
  const socket = io({
    transports: ["websocket", "polling"],
  });

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

    const minSize = 16;
    const maxSize = 56;

    items.forEach(({ text, count }) => {
      const el = document.createElement("span");
      el.className = "word";
      // Siempre MAYÚSCULAS
      el.textContent = String(text || "").toUpperCase();
      el.title = `${count} votos`;

      const norm = (count - min) / (max - min + 1e-9);
      const size = Math.round(minSize + norm * (maxSize - minSize));
      el.style.fontSize = `${size}px`;

      if (count === max) el.classList.add("top");
      container.appendChild(el);
    });
  }

  // -------------------------
  // JOIN
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
      x.type = "button";
      x.className = "chip-x";
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
  // PRESENTER
  // -------------------------
  if (view === "presenter") {
    const joinUrl = `${window.location.origin}/join`;

    const joinUrlEl = document.getElementById("joinUrl");
    const qrImg = document.getElementById("qrImg");
    const socketStatus = document.getElementById("socketStatus");

    const resetBtn = document.getElementById("resetBtn");

    const btnQ1 = document.getElementById("viewQ1");
    const btnQ2 = document.getElementById("viewQ2");

    const cloudTitle = document.getElementById("cloudTitle");
    const cloudBox = document.getElementById("cloudBox");

    // Modal zoom
    const zoomBtn = document.getElementById("zoomBtn");
    const modal = document.getElementById("zoomModal");
    const modalClose = document.getElementById("modalClose");
    const modalX = document.getElementById("modalX");
    const modalTitle = document.getElementById("modalTitle");
    const modalCloud = document.getElementById("modalCloud");

    // Estado local
    let currentView = "q1";
    let lastState = { q1: [], q2: [] };

    function setActive(which) {
      currentView = which;

      btnQ1?.classList.toggle("on", which === "q1");
      btnQ2?.classList.toggle("on", which === "q2");

      if (which === "q1") {
        cloudTitle.textContent = "¿QUÉ TAREAS TE CONSUMEN MÁS TIEMPO?";
        renderCloud(cloudBox, lastState.q1);
      } else {
        cloudTitle.textContent = "¿CUÁL ES LA TAREA QUE MENOS TE GUSTA REALIZAR?";
        renderCloud(cloudBox, lastState.q2);
      }
    }

    btnQ1?.addEventListener("click", () => setActive("q1"));
    btnQ2?.addEventListener("click", () => setActive("q2"));

    // QR desde servidor (ruta /qr?u=...)
    if (joinUrlEl) joinUrlEl.textContent = joinUrl;
    if (qrImg) {
      qrImg.src = `/qr?u=${encodeURIComponent(joinUrl)}`;
    }

    // Socket status (para depurar)
    socket.on("connect", () => {
      if (socketStatus) socketStatus.textContent = "Conectado · tiempo real activo ✅";
    });
    socket.on("disconnect", () => {
      if (socketStatus) socketStatus.textContent = "Desconectado · revisa conexión ⚠️";
    });

    resetBtn?.addEventListener("click", () => socket.emit("admin:reset"));

    socket.on("state:update", (payload) => {
      lastState = {
        q1: payload?.q1 || [],
        q2: payload?.q2 || [],
      };
      // Re-render de la vista actual
      setActive(currentView);
    });

    // Zoom real (modal)
    function openModal() {
      if (!modal) return;
      modal.setAttribute("aria-hidden", "false");
      modal.classList.add("open");

      const title = currentView === "q1"
        ? "¿QUÉ TAREAS TE CONSUMEN MÁS TIEMPO?"
        : "¿CUÁL ES LA TAREA QUE MENOS TE GUSTA REALIZAR?";
      modalTitle.textContent = title;

      const items = currentView === "q1" ? lastState.q1 : lastState.q2;
      renderCloud(modalCloud, items);
    }

    function closeModal() {
      modal?.classList.remove("open");
      modal?.setAttribute("aria-hidden", "true");
    }

    zoomBtn?.addEventListener("click", openModal);
    modalClose?.addEventListener("click", closeModal);
    modalX?.addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });

    // Default Q1
    setActive("q1");
  }
});
