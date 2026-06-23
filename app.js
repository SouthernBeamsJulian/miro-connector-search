// ---------------------------------------------------------------------------
// Connector Search — panel logic
// Reads every connector on the current board, filters by caption text, and
// lets you click a result to zoom the viewport to that connector.
// All of this runs client-side through the Web SDK — no REST API, no tokens.
// ---------------------------------------------------------------------------

const qEl = document.getElementById("q");
const goEl = document.getElementById("go");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

// Connector captions can contain inline HTML (e.g. "<p>depends</p>").
// Strip tags so we search and display the plain text the user actually sees.
function stripHtml(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || "").trim();
}

// Pull all caption strings off a single connector object.
// The SDK exposes captions as an array of { content, ... } objects.
function captionTextsOf(connector) {
  const caps = connector.captions || [];
  return caps
    .map((c) => stripHtml(typeof c === "string" ? c : c.content))
    .filter(Boolean);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function highlight(text, term) {
  const safe = escapeHtml(text);
  if (!term) return safe;
  const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return safe.replace(re, "<mark>$1</mark>");
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
    // get() returns every connector on the board. For very large boards this
    // is the slowest step, but it's a single call and runs locally.
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
      `<div class="sub">connector ${m.connector.id} — click to zoom</div>`;
    div.addEventListener("click", async () => {
      try {
        // Center the viewport on the caption. We deliberately do NOT call
        // miro.board.select() here: selecting an item is a WRITE operation
        // (it changes shared board state), which would force the boards:write
        // scope. Searching + zooming only need boards:read.
        await centerOnCaption(m.connector);
      } catch (e) {
        statusEl.textContent = "Couldn't zoom: " + e.message;
      }
    });
    resultsEl.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// Center the viewport on a connector's CAPTION, not its bounding box.
//
// Why: viewport.zoomTo(connector) frames the connector's whole bounding box, so
// for long or L-shaped connectors the caption ends up at the window edge. We
// instead compute the caption's actual board point and frame around it.
//
// Two corrections keep it dead-center on any display:
//   1. Aspect ratio: we read the live viewport's width/height ratio and build
//      the target rectangle to match, so viewport.set doesn't reshape (and
//      shift) our framing.
//   2. The app panel: this panel covers the right side of the window, so the
//      VISIBLE canvas center is left of the window center. We add right-side
//      padding equal to the panel width to push the caption into the middle of
//      the visible area, not the middle of the full window.
// ---------------------------------------------------------------------------

// Half-width (in board units / dp) of the area framed around the caption.
// Smaller = closer zoom. Tune this one number to taste.
const FRAME_HALF_WIDTH = 600; // ~1200 dp total width visible

// Width of the Miro app panel, in dp. Per Miro docs the panel is 368 dp wide
// (including its own padding). This is what we compensate for horizontally.
const PANEL_WIDTH_DP = 368;

// (endpointPoint and captionPoint are unchanged below.)

// Resolve a connector endpoint to absolute board {x, y}.
async function endpointPoint(endpoint) {
  if (!endpoint || !endpoint.item) return null;
  let item;
  try {
    [item] = await miro.board.get({ id: endpoint.item });
  } catch {
    return null;
  }
  if (!item) return null;

  const cx = typeof item.x === "number" ? item.x : 0;
  const cy = typeof item.y === "number" ? item.y : 0;
  const w = typeof item.width === "number" ? item.width : 0;
  const h = typeof item.height === "number" ? item.height : 0;

  const pos = endpoint.position;
  if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
    return { x: cx - w / 2 + pos.x * w, y: cy - h / 2 + pos.y * h };
  }
  return { x: cx, y: cy };
}

// Compute the caption's board point by interpolating along the line between
// the two endpoints by the caption's `position` (0..1 along the connector).
async function captionPoint(connector) {
  const a = await endpointPoint(connector.start);
  const b = await endpointPoint(connector.end);

  let t = 0.5;
  const caps = connector.captions || [];
  if (caps.length && typeof caps[0].position === "number") {
    t = Math.min(1, Math.max(0, caps[0].position));
  }

  if (a && b) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  if (a) return a;
  if (b) return b;
  if (typeof connector.x === "number" && typeof connector.y === "number") {
    return { x: connector.x, y: connector.y };
  }
  return null;
}

async function centerOnCaption(connector) {
  const p = await captionPoint(connector);
  if (!p) {
    await miro.board.viewport.zoomTo(connector);
    return;
  }

  // Match the target rectangle to the current viewport's aspect ratio so
  // viewport.set doesn't reshape (and thereby shift) our framing.
  let aspect = 16 / 9;
  try {
    const vp = await miro.board.viewport.get();
    if (vp && vp.width > 0 && vp.height > 0) aspect = vp.width / vp.height;
  } catch {
    /* keep default aspect */
  }

  const halfW = FRAME_HALF_WIDTH;
  const halfH = halfW / aspect;

  // Right-side padding shifts the effective center LEFT by half the panel
  // width, compensating for the panel covering the right of the window so the
  // caption sits in the middle of the *visible* canvas.
  const target = {
    x: p.x - halfW,
    y: p.y - halfH,
    width: halfW * 2,
    height: halfH * 2,
  };

  await miro.board.viewport.set({
    viewport: target,
    padding: { top: 0, bottom: 0, left: 0, right: PANEL_WIDTH_DP },
    animationDurationInMs: 300,
  });
}

goEl.addEventListener("click", runSearch);
qEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});

// Focus the input as soon as the panel opens.
qEl.focus();
