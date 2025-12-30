document.addEventListener("DOMContentLoaded", () => {
  const socket = io();
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

    const max = items[0].count;

    items.forEach(({ text, count }) => {
      const span = document.createElement("span");
      span.className = "cloud-word";

      // Normalizamos a MAYÚSCULAS (como pediste)
      span.textContent = text.toUpperCase();

      // Tamaño proporcional
      const size = 16 + (count / max) * 48;
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

    q1Add?.addEventListener("click", () => {
      const v = q1Input.value.trim();
      if (!v) return;

      q1Items.push(v);
      q1Input.value = "";

      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = v;
      q1Chips.appendChild(chip);
    });

    q1Send?.addEventListener("click", () => {
      if (q1Items.length === 0) return;
      socket.emit("q1:submit", { items: q1Items });
      q1Items.length = 0;
      q1Chips.innerHTML = "";
    });

    q2Send?.addEventListener("click", () => {
      const v = q2Input.value.trim();
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

    let current = "q1";
    let lastState = { q1: [], q2: [] };

    function refresh() {
      const data = lastState[current];
      renderCloud(cloudBox, data);
      renderCloud(modalCloud, data);

      cloudTitle.textContent =
        current === "q1"
          ? "¿QUÉ TAREAS TE CONSUMEN MÁS TIEMPO?"
          : "¿CUÁL ES LA TAREA QUE MENOS TE GUSTA REALIZAR?";
    }

    socket.on("state:update", (state) => {
      lastState = state;
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
      socket.emit("admin:reset");
    });

    // QR
    const joinUrl = `${location.origin}/join`;
    const qrImg = document.getElementById("qrImg");
    const joinUrlEl = document.getElementById("joinUrl");

    if (qrImg) qrImg.src = `/qr?u=${encodeURIComponent(joinUrl)}`;
    if (joinUrlEl) joinUrlEl.textContent = joinUrl;
  }
});
