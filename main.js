// --- API base detection ---
// Production API = your Render URL (HTTPS, no trailing slash)
const PROD_API = "https://sl-backend-zbny.onrender.com";
// Local dev API (adjust if your local port differs)
const LOCAL_DEV_API = "http://localhost:8081";

// Use PROD when hosted on GitHub Pages; otherwise use local
const API_BASE = location.hostname.endsWith("github.io") ? PROD_API : LOCAL_DEV_API;

// --- DOM refs ---
const fromQ    = document.getElementById("fromQuery");
const toQ      = document.getElementById("toQuery");
const fromList = document.getElementById("fromList");
const toList   = document.getElementById("toList");
const depart   = document.getElementById("depart");
const goBtn    = document.getElementById("goBtn");
const swapBtn  = document.getElementById("swapBtn");
const statusEl = document.getElementById("status");
const legsEl   = document.getElementById("legs");

// Selected stop IDs + names + coords cache
let fromId = "", toId = "";
let fromName = "", toName = "";
let fromLat = null, fromLon = null;
let toLat = null, toLon = null;

// Cache: stopId -> { id, name, lat, lon }
const stopCache = new Map();

// --- Leaflet map setup + layers ---
let map;
let fromMarker = null;
let toMarker = null;
// FeatureGroup supports getBounds()
let routeLayer = L.featureGroup();

function initMap() {
  const stockholm = [59.3293, 18.0686];
  map = L.map("map", { zoomControl: true }).setView(stockholm, 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  routeLayer.addTo(map);
}
initMap();

// --- Utilities ---
function hhmm(totalMin) {
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}
function clearElement(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function setStatus(msg) { statusEl.textContent = msg || ""; }

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// Wake the backend gently (Render free may be cold). We call this before the first search and route.
let lastHealthPing = 0;
async function wakeBackendIfIdle() {
  const now = Date.now();
  if (now - lastHealthPing < 60000) return; // once per minute max
  lastHealthPing = now;
  try {
    await fetchWithTimeout(`${API_BASE}/health`, { cache: "no-store" }, 10000);
  } catch (_) {
    // ignore; main request will still show a nice error
  }
}

// Marker helper
function setMarker(kind, lat, lon, label) {
  const color = (kind === "from") ? "#0b7" : "#d33";
  const opt = { radius: 8, weight: 2, color, fillColor: color, fillOpacity: 0.6 };
  const popup = label || "";
  if (kind === "from") {
    if (fromMarker) fromMarker.remove();
    fromMarker = L.circleMarker([lat, lon], opt).bindPopup(popup).addTo(map);
  } else {
    if (toMarker) toMarker.remove();
    toMarker = L.circleMarker([lat, lon], opt).bindPopup(popup).addTo(map);
  }
}

// Fit map to route + endpoint markers
function fitToContent() {
  let bounds = null;
  if (routeLayer && routeLayer.getLayers && routeLayer.getLayers().length > 0) {
    bounds = routeLayer.getBounds();
  }
  if (fromMarker && fromMarker.getLatLng) {
    const ll = fromMarker.getLatLng();
    bounds = bounds ? bounds.extend(ll) : L.latLngBounds(ll, ll);
  }
  if (toMarker && toMarker.getLatLng) {
    const ll = toMarker.getLatLng();
    bounds = bounds ? bounds.extend(ll) : L.latLngBounds(ll, ll);
  }
  if (bounds) map.fitBounds(bounds.pad(0.2));
}

// Resolve stop coords via /api/stops
async function resolveStop(id, name) {
  if (id && stopCache.has(String(id))) return stopCache.get(String(id));
  const url = `${API_BASE}/api/stops?q=${encodeURIComponent(name || "")}`;
  const res = await fetchWithTimeout(url, { cache: "no-store" }, 15000);
  if (!res.ok) throw new Error("stop lookup failed");
  const arr = await res.json();
  let found = null;
  if (id) found = arr.find(s => String(s.id) === String(id));
  if (!found && name) {
    const n = (name || "").toLowerCase();
    found = arr.find(s => (s.name || "").toLowerCase() === n) || arr[0];
  } else if (!found) {
    found = arr[0];
  }
  if (found) {
    stopCache.set(String(found.id), found);
    return found;
  }
  throw new Error("stop not found");
}

// --- Stop suggestions (debounced, with status + retry) ---
let fromTimer = 0, toTimer = 0;

fromQ.addEventListener("input", () => {
  clearElement(fromList);
  fromId = ""; fromName = ""; fromLat = fromLon = null;
  if (fromTimer) clearTimeout(fromTimer);
  const q = fromQ.value.trim();
  if (!q) return;
  fromTimer = setTimeout(() => doSearchStops(q, fromList, (s) => {
    fromId = s.id; fromName = s.name; fromQ.value = s.name;
    fromLat = s.lat; fromLon = s.lon;
    stopCache.set(String(s.id), s);
    clearElement(fromList);
    setMarker("from", s.lat, s.lon, `From: ${s.name}`);
    fitToContent();
  }), 250);
});

toQ.addEventListener("input", () => {
  clearElement(toList);
  toId = ""; toName = ""; toLat = toLon = null;
  if (toTimer) clearTimeout(toTimer);
  const q = toQ.value.trim();
  if (!q) return;
  toTimer = setTimeout(() => doSearchStops(q, toList, (s) => {
    toId = s.id; toName = s.name; toQ.value = s.name;
    toLat = s.lat; toLon = s.lon;
    stopCache.set(String(s.id), s);
    clearElement(toList);
    setMarker("to", s.lat, s.lon, `To: ${s.name}`);
    fitToContent();
  }), 250);
});

async function doSearchStops(query, listEl, onPick) {
  setStatus("Searching stops…");
  await wakeBackendIfIdle();

  const url = `${API_BASE}/api/stops?q=${encodeURIComponent(query)}`;
  try {
    let res = await fetchWithTimeout(url, { cache: "no-store" }, 15000);
    // If the backend just woke up and returned a gateway error, retry once after a short pause
    if (!res.ok && res.status >= 500) {
      await new Promise(r => setTimeout(r, 800));
      res = await fetchWithTimeout(url, { cache: "no-store" }, 15000);
    }
    if (!res.ok) throw new Error(`Stop search failed (${res.status})`);

    const items = await res.json();
    clearElement(listEl);
    for (const s of items) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.textContent = `${s.name}  ·  ${s.id}`;
      btn.addEventListener("click", () => onPick(s));
      li.appendChild(btn);
      listEl.appendChild(li);
    }
    if (items.length === 0) setStatus("No stops found.");
    else setStatus("");
  } catch (err) {
    setStatus("Error searching stops: " + err.message);
  }
}

// --- Swap ---
swapBtn.addEventListener("click", () => {
  const fText = fromQ.value;
  fromQ.value = toQ.value;
  toQ.value = fText;
  [fromId, toId]       = [toId, fromId];
  [fromName, toName]   = [toName, fromName];
  [fromLat, toLat]     = [toLat, fromLat];
  [fromLon, toLon]     = [toLon, fromLon];
  if (fromLat != null && fromLon != null) setMarker("from", fromLat, fromLon, `From: ${fromName}`);
  if (toLat != null && toLon != null)     setMarker("to", toLat, toLon, `To: ${toName}`);
  fitToContent();
});

// --- Route + draw (with wake + timeout) ---
goBtn.addEventListener("click", async () => {
  setStatus("");
  clearElement(legsEl);
  routeLayer.clearLayers();

  if (!fromId && !fromQ.value.trim()) return setStatus("Pick a 'From' stop.");
  if (!toId && !toQ.value.trim())     return setStatus("Pick a 'To' stop.");

  await wakeBackendIfIdle();

  const body = {
    fromId: fromId || undefined,
    toId: toId || undefined,
    fromName: fromName || (fromId ? undefined : fromQ.value.trim()),
    toName: toName || (toId ? undefined : toQ.value.trim()),
    depart: depart.value || "08:00"
  };

  try {
    let res = await fetchWithTimeout(`${API_BASE}/api/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store"
    }, 20000);

    if (!res.ok && res.status >= 500) {
      // possible cold start hiccup; retry once
      await new Promise(r => setTimeout(r, 800));
      res = await fetchWithTimeout(`${API_BASE}/api/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store"
      }, 20000);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setStatus(data.error || "No route found.");
      return;
    }

    const { legs, total, transfers } = data;

    const hdr = document.createElement("div");
    hdr.className = "muted";
    hdr.textContent = `Total: ${Math.round(total)} min  ·  Transfers: ${transfers}`;
    legsEl.appendChild(hdr);

    for (const leg of legs) {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div><b>${leg.trip || ""}</b> ${leg.headsign ? "· " + leg.headsign : ""}</div>
        <div><b>${hhmm(leg.dep)}</b> ${leg.fromName}</div>
        <div><b>${hhmm(leg.arr)}</b> ${leg.toName}</div>
      `;
      legsEl.appendChild(card);
    }

    for (const leg of legs) {
      const a = await resolveStop(leg.fromId, leg.fromName);
      const b = await resolveStop(leg.toId, leg.toName);
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { weight: 4, opacity: 0.9 }).addTo(routeLayer);
    }

    const first = legs[0];
    const last  = legs[legs.length - 1];
    const a0 = await resolveStop(first.fromId, first.fromName);
    const bN = await resolveStop(last.toId, last.toName);
    if (a0) { fromLat = a0.lat; fromLon = a0.lon; fromName = a0.name; fromId = String(a0.id); setMarker("from", a0.lat, a0.lon, `From: ${a0.name}`); }
    if (bN) { toLat   = bN.lat; toLon   = bN.lon; toName = bN.name; toId   = String(bN.id);   setMarker("to", bN.lat, bN.lon, `To: ${bN.name}`); }

    fitToContent();
  } catch (e) {
    setStatus("Error: " + e.message);
  }
});

// Health check on load (no-cache; just for user feedback)
(async () => {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/health`, { cache: "no-store" }, 10000);
    if (!res.ok) throw new Error("Backend not reachable");
  } catch (e) {
    setStatus("Backend not reachable at " + API_BASE + " (" + e.message + ")");
  }
})();
