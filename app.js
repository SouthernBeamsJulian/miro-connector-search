// ---------------------------------------------------------------------------
// Connector Search — panel logic
// Reads every connector on the current board, filters by caption text, and
// lets you click a result to frame the connector (its two endpoints) in view.
// Runs entirely client-side through the Web SDK — no REST API, no tokens.
// ---------------------------------------------------------------------------

const qEl = document.getElementById("q");
const goEl = document.getElementById("go");
const sortEl = document.getElementById("sort");
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

// Zoom tightly onto a single point (one endpoint). Smaller = closer.
const ENDPOINT_FRAME = 1200; // board units (dp) of the framed area's width

async function zoomToPoint(p) {
  if (!p) return;
  let aspect = 16 / 9;
  try {
    const vp = await miro.board.viewport.get();
    if (vp && vp.width > 0 && vp.height > 0) aspect = vp.width / vp.height;
  } catch {
    /* keep default */
  }
  const halfW = ENDPOINT_FRAME / 2;
  const halfH = halfW / aspect;
  await miro.board.viewport.set({
    viewport: {
      x: p.x - halfW,
      y: p.y - halfH,
      width: halfW * 2,
      height: halfH * 2,
    },
    animationDurationInMs: 300,
  });
}

async function connectorEndpoints(connector) {
  const a = await endpointPoint(connector.start);
  const b = await endpointPoint(connector.end);
  return [a, b].filter(Boolean);
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

  // Order results according to the sort selector. "Natural" comparison so that
  // wire numbers sort sensibly (e.g. 808 before 80116, not after it as raw
  // strings would do). "board" leaves them in the order the board returned.
  const mode = sortEl ? sortEl.value : "az";
  if (mode !== "board") {
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    matches.sort((m1, m2) => collator.compare(m1.text, m2.text));
    if (mode === "za") matches.reverse();
  }

  for (const m of matches) {
    const div = document.createElement("div");
    div.className = "result";
    div.innerHTML =
      `<div class="caption">${highlight(m.text, term)}</div>`;
    // Each result remembers which endpoint to show next, so repeated clicks
    // toggle: 1st click -> endpoint A, 2nd -> endpoint B, 3rd -> A, ...
    let endpointCursor = 0;
    div.addEventListener("click", async () => {
      try {
        const pts = await connectorEndpoints(m.connector);
        if (pts.length === 0) {
          await miro.board.viewport.zoomTo(m.connector);
          return;
        }
        const p = pts[endpointCursor % pts.length];
        endpointCursor++;
        await zoomToPoint(p);
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
if (sortEl) sortEl.addEventListener("change", runSearch);

qEl.focus();
