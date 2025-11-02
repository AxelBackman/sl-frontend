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

// --- In-browser stops data (loaded from stops.csv) ---
/**
 * After load, stops = [{ id: "740001174", name: "Stockholm Frihamnen", lat: 59.341502, lon: 18.117975 }, ...]
 */
let stops = [];
const stopById = new Map();

async function loadStopsCsv() {
  setStatus("Loading stations…");
  const res = await fetch("./stops.csv", { cache: "no-store" });
  if (!res.ok) throw new Error("failed to load stops.csv");
  const text = await res.text();

  // Parse a simple CSV: id,name,lat,lon,(ignore rest)
  // Handles optional header; trims whitespace; ignores empty lines.
  const lines = text.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;

    // naive split (OK for your data; no quoted commas expected)
    const cols = raw.split(",").map(s => s.trim());
    if (cols.length < 4) continue;

    // Skip header row if present
    if (i === 0 && (cols[0].toLowerCase().includes("id") || cols[2].toLowerCase().includes("lat"))) {
      continue;
    }

    const id  = cols[0];
    const name= cols[1];
    const lat = parseFloat(cols[2]);
    const lon = parseFloat(cols[3]);

    if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    out.push({ id, name, lat, lon });
  }
  stops = out;
  stopById.clear();
  for (const s of stops) stopById.set(String(s.id), s);
  setStatus(""); // ready
}

function searchStopsLocal(q, limit = 25) {
  const n = q.trim().toLowerCase();
  if (n.length < 2) return [];
  // Very lightweight: startsWith gets priority, then contains
  const starts = [];
  const contains = [];
  for (const s of stops) {
    const name = s.name.toLowerCase();
    if (name.startsWith(n)) starts.push(s);
    else if (name.includes(n)) contains.push(s);
    if (starts.length >= limit) break;
  }
  return (starts.concat(contains)).slice(0, limit);
}

function resolveStopLocal(id, name) {
  if (id && stopById.has(String(id))) return stopById.get(String(id));
  if (name) {
    const n = name.toLowerCase();
    // exact name match first
    let found = stops.find(s => s.name.toLowerCase() === n);
    if (!found) found = stops.find(s => s.name.toLowerCase().includes(n));
    return found || null;
  }
  return null;
}

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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
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

// --- Stop suggestions (client-side, debounced) ---
let fromTimer = 0, toTimer = 0;

fromQ.addEventListener("input", () => {
  clearElement(fromList);
  fromId = ""; fromName = ""; fromLat = fromLon = null;
  if (fromTimer) clearTimeout(fromTimer);
  const q = fromQ.value.trim();
  if (!q) return;
  fromTimer = setTimeout(() => {
    const items = searchStopsLocal(q);
    clearElement(fromList);
    for (const s of items) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.textContent = `${s.name}  ·  ${s.id}`;
      btn.addEventListener("click", () => {
        fromId = s.id; fromName = s.name; fromQ.value = s.name;
        fromLat = s.lat; fromLon = s.lon;
        clearElement(fromList);
        setMarker("from", s.lat, s.lon, `From: ${s.name}`);
        fitToContent();
      });
      li.appendChild(btn);
      fromList.appendChild(li);
    }
  }, 200);
});

toQ.addEventListener("input", () => {
  clearElement(toList);
  toId = ""; toName = ""; toLat = toLon = null;
  if (toTimer) clearTimeout(toTimer);
  const q = toQ.value.trim();
  if (!q) return;
  toTimer = setTimeout(() => {
    const items = searchStopsLocal(q);
    clearElement(toList);
    for (const s of items) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.textContent = `${s.name}  ·  ${s.id}`;
      btn.addEventListener("click", () => {
        toId = s.id; toName = s.name; toQ.value = s.name;
        toLat = s.lat; toLon = s.lon;
        clearElement(toList);
        setMarker("to", s.lat, s.lon, `To: ${s.name}`);
        fitToContent();
      });
      li.appendChild(btn);
      toList.appendChild(li);
    }
  }, 200);
});

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

// --- Route + draw ---
goBtn.addEventListener("click", async () => {
  setStatus("");
  clearElement(legsEl);
  routeLayer.clearLayers();

  if (!fromId && !fromQ.value.trim()) return setStatus("Pick a 'From' stop.");
  if (!toId && !toQ.value.trim())     return setStatus("Pick a 'To' stop.");

  // Fill in IDs/names from local DB if missing
  if (!fromId && fromQ.value) {
    const s = resolveStopLocal(null, fromQ.value);
    if (s) { fromId = s.id; fromName = s.name; fromLat = s.lat; fromLon = s.lon; }
  }
  if (!toId && toQ.value) {
    const s = resolveStopLocal(null, toQ.value);
    if (s) { toId = s.id; toName = s.name; toLat = s.lat; toLon = s.lon; }
  }

  const body = {
    fromId: fromId || undefined,
    toId: toId || undefined,
    fromName: fromName || (fromId ? undefined : fromQ.value.trim()),
    toName: toName || (toId ? undefined : toQ.value.trim()),
    depart: depart.value || "08:00"
  };

  // Be patient with Render cold start
  const backoffs = [0, 1500, 3000, 6000, 12000];
  for (let i = 0; i < backoffs.length; i++) {
    if (i > 0) {
      setStatus(`Finding route… (retry ${i + 1}/${backoffs.length})`);
      await sleep(backoffs[i]);
    }
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store"
      }, 45000);
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

      // draw leg lines using local coords
      for (const leg of legs) {
        const a = resolveStopLocal(leg.fromId, leg.fromName);
        const b = resolveStopLocal(leg.toId, leg.toName);
        if (a && b) {
          L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { weight: 4, opacity: 0.9 }).addTo(routeLayer);
        }
      }

      // ensure endpoint markers
      const first = legs[0];
      const last  = legs[legs.length - 1];
      const a0 = resolveStopLocal(first.fromId, first.fromName);
      const bN = resolveStopLocal(last.toId, last.toName);
      if (a0) { fromLat = a0.lat; fromLon = a0.lon; fromName = a0.name; fromId = String(a0.id); setMarker("from", a0.lat, a0.lon, `From: ${a0.name}`); }
      if (bN) { toLat   = bN.lat; toLon   = bN.lon; toName = bN.name; toId   = String(bN.id);   setMarker("to", bN.lat, bN.lon, `To: ${bN.name}`); }

      fitToContent();
      setStatus("");
      return;
    } catch (e) {
      // retry loop
    }
  }
  setStatus("Error finding route (backend slow/unreachable).");
});

// Load stops on startup, then we’re ready
loadStopsCsv().catch(err => setStatus("Failed to load stations: " + err.message));
