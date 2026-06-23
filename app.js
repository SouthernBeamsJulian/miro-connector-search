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

// Resolve an endpoint to its actual ATTACH POINT on the board (not just the
// item center). The connector attaches at a point on the item's border defined
// either by snapTo (a side) or by position {x,y} (0..1 across the item box).
async function endpointAttachPoint(endpoint) {
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
  // DIAGNOSTIC: show the raw item so we can spot frame-relative coords or
  // unexpectedly large values.
  console.log("[connector-search] endpoint item:", {
    id: item.id,
    type: item.type,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    relativeTo: item.relativeTo,
    parentId: item.parentId,
    snapTo: endpoint.snapTo,
  });

  const cx = item.x;
  const cy = item.y;
  const w = typeof item.width === "number" ? item.width : 0;
  const h = typeof item.height === "number" ? item.height : 0;

  // snapTo gives a side of the item box.
  const snap = endpoint.snapTo;
  if (snap === "top") return { x: cx, y: cy - h / 2 };
  if (snap === "bottom") return { x: cx, y: cy + h / 2 };
  if (snap === "left") return { x: cx - w / 2, y: cy };
  if (snap === "right") return { x: cx + w / 2, y: cy };

  // position {x,y} 0..1 across the item box.
  const pos = endpoint.position;
  if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
    return { x: cx - w / 2 + pos.x * w, y: cy - h / 2 + pos.y * h };
  }
  // Fallback: item center.
  return { x: cx, y: cy };
}

// Reconstruct the elbowed (right-angle) path between two attach points.
// Miro routes elbowed connectors in axis-aligned segments. The common case is
// an L or Z: exit one point, turn at a shared mid-coordinate, enter the other.
// We build a small polyline of corner points that approximates that routing.
function buildElbowPath(a, b, startSnap, endSnap) {
  // Decide whether each end exits vertically or horizontally based on its snap
  // side (top/bottom => vertical exit; left/right => horizontal exit).
  const aVertical = startSnap === "top" || startSnap === "bottom";
  const bVertical = endSnap === "top" || endSnap === "bottom";

  // Case 1: both exit vertically (typical for the vertical wire-number lines):
  // go vertical from A to a shared mid-Y, horizontal across, vertical into B.
  if (aVertical && bVertical) {
    const midY = (a.y + b.y) / 2;
    return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
  }
  // Case 2: both exit horizontally: horizontal to mid-X, vertical, horizontal.
  if (!aVertical && !bVertical) {
    const midX = (a.x + b.x) / 2;
    return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
  }
  // Case 3: mixed (one vertical, one horizontal): single L-corner.
  if (aVertical && !bVertical) {
    return [a, { x: a.x, y: b.y }, b];
  }
  return [a, { x: b.x, y: a.y }, b];
}

// Walk a polyline by arc-length fraction t (0..1) and return the point there.
function pointAlongPath(points, t) {
  if (points.length === 1) return points[0];
  // Segment lengths.
  const segLen = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    const len = Math.hypot(dx, dy);
    segLen.push(len);
    total += len;
  }
  if (total === 0) return points[0];

  let target = t * total;
  for (let i = 0; i < segLen.length; i++) {
    if (target <= segLen[i] || i === segLen.length - 1) {
      const frac = segLen[i] === 0 ? 0 : target / segLen[i];
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * frac,
        y: points[i].y + (points[i + 1].y - points[i].y) * frac,
      };
    }
    target -= segLen[i];
  }
  return points[points.length - 1];
}

async function captionPathPoint(connector) {
  const a = await endpointAttachPoint(connector.start);
  const b = await endpointAttachPoint(connector.end);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;

  // Caption fraction along the path.
  let t = 0.5;
  const caps = connector.captions || [];
  if (caps.length && typeof caps[0].position === "number") {
    t = Math.min(1, Math.max(0, caps[0].position));
  }

  let path;
  if (connector.shape === "elbowed") {
    path = buildElbowPath(a, b, connector.start?.snapTo, connector.end?.snapTo);
  } else {
    // straight or curved: treat as a straight segment for positioning.
    path = [a, b];
  }

  const p = pointAlongPath(path, t);
  console.log(
    "[connector-search] A:", a, "B:", b, "t:", t,
    "shape:", connector.shape, "path:", path, "-> point:", p
  );
  return p;
}

async function centerOnCaption(connector) {
  const p = await captionPathPoint(connector);

  if (p) {
    statusEl.textContent = `centering on x=${Math.round(p.x)} y=${Math.round(p.y)}`;
  }

  if (!p) {
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
