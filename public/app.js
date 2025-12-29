document.addEventListener("DOMContentLoaded", () => {
  const socket = io();
  const view = document.body.dataset.view; // "join" o "presenter"

  // ===== Util: render nube =====
  function renderCloud(container, items) {
    if (!container) return;
    container.innerHTML = "";

    if (!items || items.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "#888";
      empty.textContent = "Aún no hay respuestas…";
      container.appendChild(empty);
      return;
    }

    const max = Math.max(...items.map(i => i.count));
    const min = Math.min(...items.map(i => i.count));
    const scale = (c) => (max === min ? 34 : 16 + ((c - min) / (max - min)) * 40);

    items.forEach(({ text, count }) => {
      const span = document.createElement("span");
      span.textContent = text;
      span.style.fontSize = `${scale(count)}px`;
      container.appendChild(span);
    });
  }

  // ===== PRESENTER =====
  if (view === "presenter") {
    const joinUrl = `${location.origin}/join`;

    const joinUrlText = document.getElementById("joinUrlText");
    if (joinUrlText) joinUrlText.textContent = joinUrl;

    const qrCanvas = document.getElementById("qrCanvas");
    if (window.QRious && qrCanvas) {
      new QRious({ element: qrCanvas, value: joinUrl, size: 260 });
    }

    const resetBtn = document.getElementById("resetBtn");
    resetBtn?.addEventListener("click", () => socket.emit("admin:reset"));

    const cloud1 = document.getElementById("cloud1");
    const cloud2 = document.getElementById("cloud2");

    socket.on("state:update", (state) => {
      renderCloud(cloud1, state.q1);
      renderCloud(cloud2, state.q2);
    });
  }

  // ===== JOIN =====
  if (view === "join") {
    const q1Input = document.getElementById("q1Input");
    const q1Add = document.getElementById("q1Add");
    const q1Send = document.getElementById("q1Send");
    const q1Chips = document.getElementById("q1Chips");

    const q2Input = document.getElementById("q2Input");
    const q2Send = document.getElementById("q2Send");

    let q1Items = [];

    function redrawChips() {
      q1Chips.innerHTML = "";
      q1Items.forEach((t, idx) => {
        const chip = document.createElement("div");
        chip.className = "chip";
        chip.textContent = t;

        const x = document.createElement("button");
        x.className = "chipX";
        x.type = "button";
        x.textContent = "×";
        x.addEventListener("click", () => {
          q1Items.splice(idx, 1);
          redrawChips();
        });

        chip.appendChild(x);
        q1Chips.appendChild(chip);
      });
    }

    function addQ1() {
      const v = (q1Input.value || "").trim();
      if (!v) return;
      q1Items.push(v);
      q1Input.value = "";
      redrawChips();
    }

    q1Add?.addEventListener("click", addQ1);
    q1Input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addQ1();
    });

    q1Send?.addEventListener("click", () => {
      const v = (q1Input.value || "").trim();
      if (v) q1Items.push(v);
      if (q1Items.length === 0) return;

      socket.emit("q1:submit", { items: q1Items });
      q1Items = [];
      q1Input.value = "";
      redrawChips();
    });

    q2Send?.addEventListener("click", () => {
      const v = (q2Input.value || "").trim();
      if (!v) return;
      socket.emit("q2:submit", { item: v });
      q2Input.value = "";
    });
  }
});
