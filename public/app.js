document.addEventListener("DOMContentLoaded", () => {
  const socket = io();
  const view = document.body.dataset.view; // "join" o "presenter"

  // ---------- Util: render nube ----------
  function renderCloud(container, items) {
    if (!container) return;
    container.innerHTML = "";

    if (!items || items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "Aún no hay respuestas…";
      container.appendChild(empty);
      return;
    }

    const max = Math.max(...items.map(i => i.count));
    items.slice(0, 40).forEach(({ text, count }) => {
      const span = document.createElement("span");
      span.className = "tag";
      const scale = 0.85 + (count / max) * 1.35; // 0.85..2.2 aprox
      span.style.fontSize = `${scale}rem`;
      span.textContent = text;
      container.appendChild(span);
    });
  }

  // ---------- JOIN ----------
  if (view === "join") {
    const q1Input = document.getElementById("q1Input");
    const q1Add = document.getElementById("q1Add");
    const q1Send = document.getElementById("q1Send");
    const q1Chips = document.getElementById("q1Chips");

    const q2Input = document.getElementById("q2Input");
    const q2Send = document.getElementById("q2Send");

    const q1Items = [];

    function redrawChips() {
      q1Chips.innerHTML = "";
      q1Items.forEach((t, idx) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = t + "  ×";
        chip.addEventListener("click", () => {
          q1Items.splice(idx, 1);
          redrawChips();
        });
        q1Chips.appendChild(chip);
      });
    }

    q1Add?.addEventListener("click", () => {
      const v = (q1Input.value || "").trim();
      if (!v) return;
      q1Items.push(v);
      q1Input.value = "";
      redrawChips();
    });

    q1Send?.addEventListener("click", () => {
      // si no hay chips pero hay texto en el input, lo metemos
      const v = (q1Input.value || "").trim();
      if (v) {
        q1Items.push(v);
        q1Input.value = "";
      }
      if (q1Items.length === 0) return;

      socket.emit("q1:submit", { items: [...q1Items] });
      q1Items.length = 0;
      redrawChips();
    });

    q2Send?.addEventListener("click", () => {
      const v = (q2Input.value || "").trim();
      if (!v) return;
      socket.emit("q2:submit", { item: v });
      q2Input.value = "";
    });

    // Enter para comodidad
    q1Input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") q1Add.click();
    });
    q2Input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") q2Send.click();
    });
  }

  // ---------- PRESENTER ----------
  if (view === "presenter") {
    const cloudQ1 = document.getElementById("cloudQ1");
    const cloudQ2 = document.getElementById("cloudQ2");
    const resetBtn = document.getElementById("resetBtn");

    resetBtn?.addEventListener("click", () => {
      socket.emit("admin:reset");
    });

    // QR a /join
    const joinUrl = `${window.location.origin}/join`;
    const joinUrlEl = document.getElementById("joinUrl");
    if (joinUrlEl) joinUrlEl.textContent = joinUrl;

    const qrCanvas = document.getElementById("qrCanvas");
    if (window.QRCode && qrCanvas) {
      QRCode.toCanvas(qrCanvas, joinUrl, { width: 220, margin: 1 }, () => {});
    }

    socket.on("state:update", (payload) => {
      renderCloud(cloudQ1, payload.q1);
      renderCloud(cloudQ2, payload.q2);
    });
  }

  // Estado inicial para presenter (y por si quieres debug)
  socket.on("state:update", (payload) => {
    // si no es presenter, no pasa nada; lo recibimos igual
    if (view !== "presenter") return;
  });
});
