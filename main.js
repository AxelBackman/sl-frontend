// --- API base detection ---
const PROD_API = "https://sl-backend-zbny.onrender.com"; // <-- change to your prod URL when you switch hosts
const LOCAL_DEV_API = "http://localhost:8081";
export const API_BASE = location.hostname.endsWith("github.io") ? PROD_API : LOCAL_DEV_API;

// --- DOM refs ---
const fromQ    = document.getElementById("fromQuery");
const toQ      = document.getElementById("toQuery");
const fromList = document.getElementById("fromList");
const toList   = document.getElementById("toList");
const depart   = document.getElementById("depart");
const goBtn    = document.getElementById("goBtn");
const swapBtn  = document.getElementById("swapBtn");
const statusEl = document.getElementById("status");

// Overlay
const bootOverlay = document.getElementById("bootOverlay");
const bootMsg     = document.getElementById("bootMsg");

// --- Globals ---
let fromSel = null; // { id,name,lat?,lon? }
let toSel   = null; // { id,name,lat?,lon? }
let map, fromMarker, toMarker, routeLayer;

// --- Utils ---
function setStatus(msg) { statusEl.textContent = msg || ""; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}
function debounce(fn, delay = 200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), delay); };
}
function takeSnippet(text, n = 180) {
  if (!text) return ""; const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

// --- Stops API (exact to your backend) ---
async function queryStops(q, { signal } = {}) {
  const url = `${API_BASE}/api/stops?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  // Normalize common field names
  return (Array.isArray(data) ? data : (data.results || data.stops || []))
    .map(it => ({
      id:  it.id ?? it.stop_id ?? it.siteId ?? it.site_id ?? it.name,
      name:it.name ?? it.stop_name ?? it.displayName ?? it.Name,
      lat: it.lat ?? it.stop_lat ?? it.latitude,
      lon: it.lon ?? it.stop_lon ?? it.longitude
    }))
    .filter(s => s.id && s.name);
}

// --- Suggest UI ---
function renderSuggest(listEl, items, onPick) {
  listEl.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "hint";
    li.textContent = "No matches";
    listEl.appendChild(li);
    listEl.hidden = false;
    return;
  }
  for (const s of items.slice(0, 12)) {
    const li = document.createElement("li");
    li.textContent = s.name;
    li.addEventListener("click", () => onPick(s));
    listEl.appendChild(li);
  }
  listEl.hidden = false;
}

function bindAutocomplete(inputEl, listEl, setSel, markerKey) {
  let inflight = null;

  const runSearch = async () => {
    const q = inputEl.value.trim();
    setSel(null);
    if (!q) { listEl.hidden = true; return; }

    if (inflight) inflight.abort();
    inflight = new AbortController();

    listEl.hidden = false;
    listEl.innerHTML = `<li class="hint">Searching…</li>`;

    try {
      const items = await queryStops(q, { signal: inflight.signal });
      renderSuggest(listEl, items, (s) => {
        inputEl.value = s.name;
        listEl.hidden = true;
        setSel(s);
        if (s.lat != null && s.lon != null) {
          setMarker(markerKey, s.lat, s.lon, `${markerKey === "from" ? "From" : "To"}: ${s.name}`);
          fitToContent();
        } else {
          if (markerKey === "from") clearMarker("from"); else clearMarker("to");
        }
      });
    } catch {
      listEl.innerHTML = `<li class="hint">Error searching stops</li>`;
    }
  };

  const debounced = debounce(runSearch, 150); // works well for single letters like "k"
  inputEl.addEventListener("input", debounced);
  inputEl.addEventListener("focus", () => { if (inputEl.value) debounced(); });
  document.addEventListener("click", (e) => {
    if (!listEl.contains(e.target) && e.target !== inputEl) listEl.hidden = true;
  });
}

// --- Map ---
function initMap() {
  const stockholm = [59.3293, 18.0686];
  map = L.map("map", { zoomControl: true }).setView(stockholm, 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
}
function setMarker(type, lat, lon, label) {
  const marker = L.marker([lat, lon]).bindPopup(label);
  if (type === "from") {
    if (fromMarker) fromMarker.remove();
    fromMarker = marker.addTo(map);
  } else {
    if (toMarker) toMarker.remove();
    toMarker = marker.addTo(map);
  }
}
function clearMarker(type) {
  if (type === "from" && fromMarker) { fromMarker.remove(); fromMarker = null; }
  if (type === "to"   && toMarker)   { toMarker.remove();   toMarker = null; }
}
function fitToContent() {
  const bounds = [];
  if (fromMarker) bounds.push(fromMarker.getLatLng());
  if (toMarker) bounds.push(toMarker.getLatLng());
  routeLayer.eachLayer(l => {
    if (l.getBounds) {
      const b = l.getBounds();
      if (b.isValid()) bounds.push(b.getNorthWest(), b.getSouthEast());
    }
  });
  if (bounds.length) map.fitBounds(L.latLngBounds(bounds), { padding: [30, 30] });
}

// --- Route rendering ---
function clearRoute() { routeLayer.clearLayers(); document.getElementById("legs").innerHTML = ""; }
function addPolyline(latlngs) {
  try { const line = L.polyline(latlngs, { weight: 5, opacity: 0.9 }); routeLayer.addLayer(line); return line; }
  catch { return null; }
}
function renderLegs(legs = [], summary = "") {
  const wrap = document.getElementById("legs");
  wrap.innerHTML = "";
  if (summary) {
    const p = document.createElement("p");
    p.style.margin = "0 0 8px";
    p.textContent = summary;
    wrap.appendChild(p);
  }
  for (const leg of legs) {
    const div = document.createElement("div");
    div.className = "leg";
    const title = document.createElement("h3");
    title.textContent = `${leg.mode || "Leg"} · ${leg.fromName || ""} → ${leg.toName || ""}`;
    const body = document.createElement("p");
    const mins = leg.durationMin != null ? `${leg.durationMin} min` : "";
    const dist = leg.distanceM != null ? ` · ${Math.round(leg.distanceM)} m` : "";
    body.textContent = [mins, dist].filter(Boolean).join("");
    div.append(title, body);
    wrap.appendChild(div);
  }
}
function extractShapes(routeJson) {
  const shapes = [];
  const legs   = [];
  if (Array.isArray(routeJson.legs)) {
    for (const leg of routeJson.legs) {
      let coords = [];
      if (Array.isArray(leg.geometry)) {
        coords = leg.geometry.map(([lat, lon]) => [lat, lon]);
      } else if (leg.geometry && leg.geometry.type === "LineString" && Array.isArray(leg.geometry.coordinates)) {
        coords = leg.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      }
      if (coords.length) shapes.push(coords);
      legs.push({
        mode: leg.mode,
        fromName: leg.fromName || leg.from || "",
        toName: leg.toName || leg.to || "",
        durationMin: leg.durationMin ?? null,
        distanceM: leg.distanceM ?? null
      });
    }
  } else if (routeJson.geometry && routeJson.geometry.type === "LineString") {
    const coords = routeJson.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    if (coords.length) shapes.push(coords);
  }
  return { shapes, legs };
}

// --- Backend warmup (use /health) ---
async function wakeBackend() {
  if (!bootOverlay) return;

  const phrases = [
    "Waking the server…",
    "Almost there…",
    "Render free plan can take ~1 minute on first request…"
  ];
  let phraseIdx = 0;
  const ticker = setInterval(() => {
    bootMsg.textContent = phrases[phraseIdx % phrases.length];
    phraseIdx++;
  }, 2000);

  const attempts = 10;
  for (let i = 0; i < attempts; i++) {
    try {
      // Hit /health with a short timeout; any 2xx means it's up.
      const res = await fetchWithTimeout(`${API_BASE}/health`, {}, 6000);
      if (res.ok) break;
    } catch {
      // ignore and retry
    }
    const left = attempts - i - 1;
    if (left > 0) {
      bootMsg.textContent = `Waking the server… retrying (${left} left)`;
      await sleep(800 + i * 400);
    } else {
      clearInterval(ticker);
      bootMsg.textContent = "Server didn’t respond. Please refresh or try again shortly.";
      return; // leave overlay to block broken UI
    }
  }

  clearInterval(ticker);
  bootOverlay.classList.add("hide");
  setTimeout(() => bootOverlay.remove(), 350);
}

// --- Route action (exact /api/route POST) ---
async function findRoute() {
  if (!fromQ.value.trim() || !toQ.value.trim()) {
    setStatus("Pick both 'From' and 'To' stops.");
    return;
  }

  clearRoute();
  setStatus("Finding route…");

  // mini overlay (in case the server idled again)
  const blocker = document.createElement("div");
  blocker.style.position = "fixed";
  blocker.style.inset = "0";
  blocker.style.background = "rgba(255,255,255,.6)";
  blocker.style.zIndex = "500";
  blocker.innerHTML = '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);"><div class="loader"></div></div>';
  document.body.appendChild(blocker);

  try {
    const when = depart.value ? new Date(depart.value) : new Date();
    const body = {
      from: {
        id:  fromSel?.id ?? null,
        name:fromSel?.name ?? fromQ.value.trim(),
        lat: fromSel?.lat ?? null,
        lon: fromSel?.lon ?? null
      },
      to: {
        id:  toSel?.id ?? null,
        name:toSel?.name ?? toQ.value.trim(),
        lat: toSel?.lat ?? null,
        lon: toSel?.lon ?? null
      },
      departIso: when.toISOString()
    };

    // Try up to 2 times (handles brief cold-start hiccups)
    let lastErr;
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetchWithTimeout(`${API_BASE}/api/route`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }, 25000);
        const text = await res.text();
        let json = {};
        try { json = JSON.parse(text); } catch {}

        if (!res.ok) {
          // Your backend returns 404 when no route found (ok=false)
          throw new Error(`${res.status} ${takeSnippet(json.error || text)}`);
        }

        const { shapes, legs } = extractShapes(json);
        for (const shape of shapes) addPolyline(shape);
        renderLegs(legs, json.summary || "");
        fitToContent();
        setStatus("Done.");
        return;
      } catch (e) {
        lastErr = e;
        setStatus(`Retrying… ${i + 1}/2`);
        await sleep(600);
      }
    }
    throw lastErr || new Error("Unknown error");
  } catch (e) {
    console.error(e);
    setStatus(`Error finding route: ${e.message || "backend unreachable"}`);
  } finally {
    blocker.remove();
  }
}

// --- Wire up UI ---
swapBtn.addEventListener("click", () => {
  [fromSel, toSel] = [toSel, fromSel];
  [fromQ.value, toQ.value] = [toQ.value, fromQ.value];
  const a = fromMarker ? fromMarker.getLatLng() : null;
  const b = toMarker ? toMarker.getLatLng() : null;
  clearMarker("from"); clearMarker("to");
  if (b) setMarker("from", b.lat, b.lng, `From: ${toQ.value || (toSel?.name || "")}`);
  if (a) setMarker("to",   a.lat, a.lng,   `To: ${fromQ.value || (fromSel?.name || "")}`);
  fitToContent();
});

goBtn.addEventListener("click", findRoute);

// Default depart time = now (local)
(function initDepartNow(){
  const now = new Date();
  now.setSeconds(0,0);
  const pad = n => String(n).padStart(2,"0");
  const local = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  depart.value = local;
})();

// Bind autocomplete (backend-powered)
bindAutocomplete(fromQ, fromList, s => (fromSel = s), "from");
bindAutocomplete(toQ,   toList,   s => (toSel   = s), "to");

// Init map and boot
initMap();
(async function boot() {
  await wakeBackend(); // block until /health is OK
  setStatus("Ready.");
})();
