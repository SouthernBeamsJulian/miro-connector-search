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
        await centerOnCaption(m.connector);
        await miro.board.select({ id: m.connector.id });
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
// for long or L-shaped connectors the caption ends up at the window edge. Here
// we instead compute the caption's actual board point and set a fixed-size
// viewport rectangle centered exactly on it. Because viewport.set preserves the
// rectangle's CENTER regardless of the screen's aspect ratio/resolution, the
// caption lands dead-center on any display.
// ---------------------------------------------------------------------------

// How wide (in board units / dp) the framed area should be. Smaller = closer
// zoom. 1200 dp is a comfortable "see the connector and its surroundings" level.
const FRAME_WIDTH = 1200;
const FRAME_HEIGHT = 800;

// Resolve a connector endpoint to absolute board {x, y}.
// An endpoint is attached to an item; we read that item's center and, if a
// relative position (0..1 on the item's box) is given, offset within the box.
async function endpointPoint(endpoint) {
  if (!endpoint || !endpoint.item) return null;
  let item;
  try {
    [item] = await miro.board.get({ id: endpoint.item });
  } catch {
    return null;
  }
  if (!item) return null;

  // Item center in board coords.
  const cx = typeof item.x === "number" ? item.x : 0;
  const cy = typeof item.y === "number" ? item.y : 0;
  const w = typeof item.width === "number" ? item.width : 0;
  const h = typeof item.height === "number" ? item.height : 0;

  // endpoint.position is {x,y} in 0..1 across the item box (0.5,0.5 = center).
  const pos = endpoint.position;
  if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
    return { x: cx - w / 2 + pos.x * w, y: cy - h / 2 + pos.y * h };
  }
  // snapTo or unspecified -> just use the item center.
  return { x: cx, y: cy };
}

// Compute the caption's board point by interpolating along the line between
// the two endpoints by the caption's `position` (0..1 along the connector).
async function captionPoint(connector) {
  const a = await endpointPoint(connector.start);
  const b = await endpointPoint(connector.end);

  // Caption position along the connector (default mid-line).
  let t = 0.5;
  const caps = connector.captions || [];
  if (caps.length && typeof caps[0].position === "number") {
    t = Math.min(1, Math.max(0, caps[0].position));
  }

  if (a && b) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  if (a) return a;
  if (b) return b;
  // Last resort: connector's own x/y if present.
  if (typeof connector.x === "number" && typeof connector.y === "number") {
    return { x: connector.x, y: connector.y };
  }
  return null;
}

async function centerOnCaption(connector) {
  const p = await captionPoint(connector);
  if (!p) {
    // If we somehow can't locate the caption, fall back to default framing.
    await miro.board.viewport.zoomTo(connector);
    return;
  }
  // Build a rectangle centered on the caption. viewport.set keeps this center
  // fixed while it reshapes width/height to the actual screen aspect ratio.
  const target = {
    x: p.x - FRAME_WIDTH / 2,
    y: p.y - FRAME_HEIGHT / 2,
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
  };
  await miro.board.viewport.set({
    viewport: target,
    padding: { top: 0, bottom: 0, left: 0, right: 0 },
    animationDurationInMs: 300,
  });
}

goEl.addEventListener("click", runSearch);
qEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});

// Focus the input as soon as the panel opens.
qEl.focus();
