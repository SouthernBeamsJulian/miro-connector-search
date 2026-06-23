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
        // TEMP: log the connector so we can confirm its box/caption fields.
        console.log("[connector-search] connector:", m.connector);
        await centerOnCaption(m.connector);
      } catch (e) {
        statusEl.textContent = "Couldn't zoom: " + e.message;
      }
    });
    resultsEl.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// Center the viewport on a connector's CAPTION.
//
// Key facts learned from the live data:
//  - Connectors here are `elbowed` and have NO top-level x/y (only width/height
//    of the overall bounding box). So we cannot use a box center.
//  - Each connector has `start` and `end`, each attached to a board ITEM
//    (start.item / end.item). Those items DO have real x/y coordinates.
//  - A caption has a `position` (0..1) along the connector path.
//
// Strategy: look up the two endpoint items to get their board coordinates, then
// interpolate between them by the caption's position. For elbowed lines this
// isn't the exact path point, but it lands on the segment between the ends —
// close to the caption — far better than the bounding-box center (which is huge
// and off to the side).
//
// Panel correction: right-side padding = panel width, so the target sits in the
// middle of the VISIBLE canvas (the panel covers the right of the window).
// ---------------------------------------------------------------------------

const FRAME_HALF_WIDTH = 600;   // smaller = closer zoom
const PANEL_WIDTH_DP = 368;     // Miro panel width, for horizontal centering

// Look up an endpoint's attached item and return its center {x, y}.
async function endpointItemPoint(endpoint) {
  if (!endpoint || !endpoint.item) return null;
  let item;
  try {
    [item] = await miro.board.get({ id: endpoint.item });
  } catch {
    return null;
  }
  if (!item) return null;
  if (typeof item.x === "number" && typeof item.y === "number") {
    return { x: item.x, y: item.y };
  }
  return null;
}

async function captionPointFromEndpoints(connector) {
  const a = await endpointItemPoint(connector.start);
  const b = await endpointItemPoint(connector.end);

  // Use the FIRST caption's position as the fraction along the line.
  let t = 0.5;
  const caps = connector.captions || [];
  if (caps.length && typeof caps[0].position === "number") {
    t = Math.min(1, Math.max(0, caps[0].position));
  }

  console.log("[connector-search] endpoint A:", a, "endpoint B:", b, "t:", t);

  if (a && b) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  if (a) return a;
  if (b) return b;
  return null;
}

async function centerOnCaption(connector) {
  const p = await captionPointFromEndpoints(connector);

  if (p) {
    statusEl.textContent = `centering on x=${Math.round(p.x)} y=${Math.round(p.y)}`;
  }

  if (!p) {
    // Couldn't resolve endpoints -> let the SDK frame the whole connector.
    await miro.board.viewport.zoomTo(connector);
    return;
  }

  let aspect = 16 / 9;
  try {
    const vp = await miro.board.viewport.get();
    if (vp && vp.width > 0 && vp.height > 0) aspect = vp.width / vp.height;
  } catch {
    /* keep default */
  }

  const halfW = FRAME_HALF_WIDTH;
  const halfH = halfW / aspect;

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
