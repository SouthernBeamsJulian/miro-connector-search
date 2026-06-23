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
// Approach: a connector has its own bounding box (x, y, width, height = the
// box's CENTER and size). The caption sits at a fractional position along the
// connector (caption.position, 0..1). For the near-vertical connectors on this
// board, we map that fraction onto the bounding box's vertical extent to land
// on the text, then frame a fixed-size window around that point.
//
// Panel correction: the app panel covers the right side of the window, so the
// visible-canvas center is left of the window center. Right-side padding equal
// to the panel width pushes the target into the middle of the VISIBLE area.
// ---------------------------------------------------------------------------

// Half-width (board units / dp) of the framed area. Smaller = closer zoom.
const FRAME_HALF_WIDTH = 600;

// Miro app panel width in dp (per Miro docs, 368 dp incl. padding).
const PANEL_WIDTH_DP = 368;

// Find the caption's board point using the connector's OWN bounding box.
// connector.x / connector.y = box center; width/height = box size.
function captionPointFromBox(connector) {
  const hasBox =
    typeof connector.x === "number" &&
    typeof connector.y === "number" &&
    typeof connector.width === "number" &&
    typeof connector.height === "number";
  if (!hasBox) return null;

  // Caption fraction along the connector (default mid).
  let t = 0.5;
  const caps = connector.captions || [];
  if (caps.length && typeof caps[0].position === "number") {
    t = Math.min(1, Math.max(0, caps[0].position));
  }

  // Box edges.
  const top = connector.y - connector.height / 2;
  const left = connector.x - connector.width / 2;

  // For a near-vertical connector, map t onto the vertical extent; keep x at
  // the box's horizontal center. (t=0 -> top edge, t=1 -> bottom edge.)
  const x = connector.x;
  const y = top + t * connector.height;

  return { x, y, boxCenter: { x: connector.x, y: connector.y } };
}

async function centerOnCaption(connector) {
  const p = captionPointFromBox(connector);

  // On-screen diagnostic so we can verify without the console.
  if (p) {
    statusEl.textContent =
      `target x=${Math.round(p.x)} y=${Math.round(p.y)} ` +
      `(box center y=${Math.round(p.boxCenter.y)})`;
  }

  if (!p) {
    // No usable box -> fall back to the SDK's own framing.
    await miro.board.viewport.zoomTo(connector);
    return;
  }

  // Match target rect to the live viewport aspect ratio so set() doesn't
  // reshape and shift our framing.
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
