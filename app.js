// ---------------------------------------------------------------------------
// Connector Search — panel logic
// Reads every connector on the current board, filters by caption text, and
// lets you click a result to frame the connector (its two endpoints) in view.
// Runs entirely client-side through the Web SDK — no REST API, no tokens.
// ---------------------------------------------------------------------------

const qEl = document.getElementById("q");
const goEl = document.getElementById("go");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

// Connector captions can contain inline HTML (e.g. "<p>8002</p>"). Strip tags
// so we search and display the plain text the user actually sees.
function stripHtml(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || "").trim();
}

function captionTextsOf(connector) {
  const caps = connector.captions || [];
  return caps
    .map((c) => stripHtml(typeof c === "string" ? c : c.content))
    .filter(Boolean);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function highlight(text, term) {
  const safe = escapeHtml(text);
  if (!term) return safe;
  const re = new RegExp(
    `(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"
  );
  return safe.replace(re, "<mark>$1</mark>");
}

// Resolve a connector endpoint to its attach point on the board. The endpoint
// is attached to an item; snapTo gives a side, or position gives 0..1 in the
// item's box. Falls back to the item center.
async function endpointPoint(endpoint) {
  if (!endpoint || !endpoint.item) return null;
  let item;
  try {
    [item] = await miro.board.get({ id: endpoint.item });
  } catch {
    return null;
  }
  if (!item || typeof item.x !== "number" || typeof item.y !== "number") {
    return null;
  }
  const cx = item.x;
  const cy = item.y;
  const w = typeof item.width === "number" ? item.width : 0;
  const h = typeof item.height === "number" ? item.height : 0;
  const snap = endpoint.snapTo;
  if (snap === "top") return { x: cx, y: cy - h / 2 };
  if (snap === "bottom") return { x: cx, y: cy + h / 2 };
  if (snap === "left") return { x: cx - w / 2, y: cy };
  if (snap === "right") return { x: cx + w / 2, y: cy };
  const pos = endpoint.position;
  if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
    return { x: cx - w / 2 + pos.x * w, y: cy - h / 2 + pos.y * h };
  }
  return { x: cx, y: cy };
}

// Frame the connector's two endpoints in the viewport.
async function frameConnector(connector) {
  const a = await endpointPoint(connector.start);
  const b = await endpointPoint(connector.end);

  // If we can't resolve endpoints, fall back to the SDK's own framing.
  if (!a && !b) {
    await miro.board.viewport.zoomTo(connector);
    return;
  }
  const p1 = a || b;
  const p2 = b || a;

  // Bounding box around the two endpoints, with a margin so the line isn't
  // jammed against the window edges. Margin scales with the line's size but has
  // a sensible minimum for very short connectors.
  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const spanX = Math.abs(p2.x - p1.x);
  const spanY = Math.abs(p2.y - p1.y);
  const margin = Math.max(200, spanX * 0.2, spanY * 0.2);

  const viewport = {
    x: minX - margin,
    y: minY - margin,
    width: spanX + margin * 2,
    height: spanY + margin * 2,
  };

  await miro.board.viewport.set({
    viewport,
    animationDurationInMs: 300,
  });
}

async function runSearch() {
  const term = qEl.value.trim();
  resultsEl.innerHTML = "";

  if (!term) {
    statusEl.textContent = "Enter a search term first.";
    return;
  }

  statusEl.textContent = "Reading connectors…";

  let connectors;
  try {
    connectors = await miro.board.get({ type: "connector" });
  } catch (e) {
    statusEl.textContent = "Couldn't read the board: " + e.message;
    return;
  }

  const needle = term.toLowerCase();
  const matches = [];
  for (const c of connectors) {
    const texts = captionTextsOf(c);
    const hit = texts.find((t) => t.toLowerCase().includes(needle));
    if (hit) matches.push({ connector: c, text: hit });
  }

  statusEl.textContent =
    `${matches.length} match${matches.length === 1 ? "" : "es"} ` +
    `in ${connectors.length} connector${connectors.length === 1 ? "" : "s"}.`;

  if (matches.length === 0) {
    resultsEl.innerHTML =
      '<div class="muted">No connector captions contain that text.</div>';
    return;
  }

  for (const m of matches) {
    const div = document.createElement("div");
    div.className = "result";
    div.innerHTML =
      `<div class="caption">${highlight(m.text, term)}</div>` +
      `<div class="sub">connector ${m.connector.id} — click to view</div>`;
    div.addEventListener("click", async () => {
      try {
        await frameConnector(m.connector);
      } catch (e) {
        statusEl.textContent = "Couldn't focus: " + e.message;
      }
    });
    resultsEl.appendChild(div);
  }
}

goEl.addEventListener("click", runSearch);
qEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});

qEl.focus();
