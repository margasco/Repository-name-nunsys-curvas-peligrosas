const socket = io();

const path = window.location.pathname;
const isPresenter = path.includes("presenter");

document.getElementById("modeBadge").textContent = isPresenter ? "Moderador" : "Participante";

const resetBtn = document.getElementById("resetBtn");

if (isPresenter) {
  resetBtn.style.display = "inline-flex";
  document.getElementById("presenterGrid").style.display = "grid";
  document.getElementById("joinQ1").style.display = "none";
  document.getElementById("joinQ2").style.display = "none";
  document.getElementById("footerNote").innerHTML =
    `QR recomendado: <b>${window.location.origin}/join</b> · Proyector: <b>${window.location.origin}/presenter</b>`;
  resetBtn.onclick = () => socket.emit("admin:reset");
} else {
  document.getElementById("footerNote").textContent =
    "Tip: puedes enviar varias tareas en la primera pregunta. En la segunda, solo una.";
}

// ===== PARTICIPANTE: PREGUNTA 1 (múltiple) =====
const q1Input = document.getElementById("q1Input");
const q1Add = document.getElementById("q1Add");
const q1Send = document.getElementById("q1Send");
const q1Chips = document.getElementById("q1Chips");

let q1Items = [];

function renderQ1() {
  q1Chips.innerHTML = "";
  q1Items.forEach((t, idx) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = t;

    const x = document.createElement("button");
    x.textContent = "×";
    x.onclick = () => {
      q1Items = q1Items.filter((_, i) => i !== idx);
      renderQ1();
    };

    chip.appendChild(x);
    q1Chips.appendChild(chip);
  });

  q1Send.disabled = q1Items.length === 0;
}

if (q1Add) {
  q1Add.onclick = () => {
    const v = q1Input.value.trim();
    if (!v) return;
    q1Items.push(v);
    q1Input.value = "";
    renderQ1();
  };

  q1Input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      q1Add.click();
    }
  });

  q1Send.onclick = () => {
    socket.emit("q1:submit", { items: q1Items });
    q1Items = [];
    renderQ1();
    flashSent();
  };
}

// ===== PARTICIPANTE: PREGUNTA 2 (única) =====
const q2Input = document.getElementById("q2Input");
const q2Send = document.getElementById("q2Send");

if (q2Input) {
  q2Input.addEventListener("input", () => {
    q2Send.disabled = q2Input.value.trim().length < 2;
  });

  q2Input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      q2Send.click();
    }
  });

  q2Send.onclick = () => {
    socket.emit("q2:submit", { item: q2Input.value.trim() });
    q2Input.value = "";
    q2Send.disabled = true;
    flashSent();
  };
}

function flashSent() {
  const n = document.getElementById("sentNote");
  if (!n) return;
  n.style.display = "block";
  setTimeout(() => (n.style.display = "none"), 1200);
}

// ===== MODERADOR: WORD CLOUD =====
function drawCloud(containerId, data) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const width = el.parentElement.clientWidth;
  const height = el.parentElement.clientHeight;

  el.innerHTML = "";
  const svg = d3
    .select(el)
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  const words = (data || []).slice(0, 60).map((d) => ({
    text: d.text,
    size: 12 + Math.min(60, d.count * 10),
  }));

  if (words.length === 0) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#6b7280")
      .style("font-size", "14px")
      .text("Esperando respuestas…");
    return;
  }

  d3.layout
    .cloud()
    .size([width, height])
    .words(words)
    .padding(2)
    .rotate(() => 0)
    .font("system-ui")
    .fontSize((d) => d.size)
    .on("end", (layoutWords) => {
      svg
        .append("g")
        .attr("transform", `translate(${width / 2},${height / 2})`)
        .selectAll("text")
        .data(layoutWords)
        .enter()
        .append("text")
        .style("font-family", "system-ui")
        .style("font-size", (d) => `${d.size}px`)
        .style("fill", "#111827")
        .style("opacity", 0.92)
        .attr("text-anchor", "middle")
        .attr("transform", (d) => `translate(${d.x},${d.y})rotate(${d.rotate})`)
        .text((d) => d.text);
    })
    .start();
}

socket.on("state:update", (s) => {
  if (!isPresenter) return;

  drawCloud("cloud1", s.q1 || []);
  drawCloud("cloud2", s.q2 || []);

  const top1 =
    (s.q1 || [])
      .slice(0, 5)
      .map((x) => `${x.text} (${x.count})`)
      .join(" · ") || "—";

  const top2 =
    (s.q2 || [])
      .slice(0, 5)
      .map((x) => `${x.text} (${x.count})`)
      .join(" · ") || "—";

  document.getElementById("top1").textContent = "Top: " + top1;
  document.getElementById("top2").textContent = "Top: " + top2;
});
