// Point this to your backend URL.
// Local dev default:
const API_BASE = "http://localhost:8080";

// --- DOM refs ---
const fromQ   = document.getElementById("fromQuery");
const toQ     = document.getElementById("toQuery");
const fromList= document.getElementById("fromList");
const toList  = document.getElementById("toList");
const depart  = document.getElementById("depart");
const goBtn   = document.getElementById("goBtn");
const swapBtn = document.getElementById("swapBtn");
const statusEl= document.getElementById("status");
const legsEl  = document.getElementById("legs");

// Selected stop IDs + names + coords cache (we store coords when you pick a suggestion)
let fromId = "";
let toId   = "";
let fromName = "";
let toName = "";
let fromLat = null, fromLon = null;
let toLat = null, toLon = null;

// Cache by id -> {id, name, lat, lon}
const stopCache = new Map();

// --- Leaflet map setup + layers ---
let map;
let fromMarker = null;
let toMarker = null;
let routeLayer = L.layerGroup(); // polylines and any mid-leg markers

function initMap() {
  // Stockholm center
  const stockholm = [59.3293, 18.0686];

  map = L.map("map", { zoomControl: true }).setView(stockholm, 11);

  // OSM tiles
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  routeLayer.addTo(map);
}
initMap(); // render once on load

// --- Helpers ---
function hhmm(totalMin) {
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}
function clearElement(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function setStatus(msg) { statusEl.textContent = msg || ""; }

// Create/update a marker (simple circle style so it’s lightweight)
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

// Fit map to whatever we currently have (route + markers)
function fitToContent() {
  const group = L.featureGroup([routeLayer, fromMarker, toMarker].filter(Boolean));
  if (group.getLayers().length > 0) map.fitBounds(group.getBounds().pad(0.2));
}

// Resolve stop coordinates by id/name using your /api/stops search
// Important: your backend returns StopDto {id,name,lat,lon}, so we can resolve endpoints for drawing.
async function resolveStop(id, name) {
  if (id && stopCache.has(id)) return stopCache.get(id);

  // Fall back to name search (server returns {id,name,lat,lon})
  const url = `${API_BASE}/api/stops?q=${encodeURIComponent(name || "")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("stop lookup failed");
  const arr = await res.json();

  // Try exact id match first, else name match, else first result
  let found = null;
  if (id) found = arr.find(s => String(s.id) === String(id));
  if (!found && name) {
    const n = name.toLowerCase();
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

// --- Stop search (debounced fetch to /api/stops?q=) ---
let fromTimer = 0, toTimer = 0;

fromQ.addEventListener("input", () => {
  clearElement(fromList);
  fromId = ""; fromName = ""; fromLat = fromLon = null;
  if (fromTimer) clearTimeout(fromTimer);
  const q = fromQ.value.trim();
  if (!q) return;
  fromTimer = setTimeout(() => searchStops(q, fromList, (s) => {
    fromId = s.id; fromName = s.name; fromQ.value = s.name;
    fromLat = s.lat; fromLon = s.lon;
    stopCache.set(String(s.id), s); // keep for later route drawing
    clearElement(fromList);

    // Update marker immediately when a suggestion is chosen
    setMarker("from", s.lat, s.lon, `From: ${s.name}`);
    fitToContent();
  }), 200);
});

toQ.addEventListener("input", () => {
  clearElement(toList);
  toId = ""; toName = ""; toLat = toLon = null;
  if (toTimer) clearTimeout(toTimer);
  const q = toQ.value.trim();
  if (!q) return;
  toTimer = setTimeout(() => searchStops(q, toList, (s) => {
    toId = s.id; toName = s.name; toQ.value = s.name;
    toLat = s.lat; toLon = s.lon;
    stopCache.set(String(s.id), s);
    clearElement(toList);

    setMarker("to", s.lat, s.lon, `To: ${s.name}`);
    fitToContent();
  }), 200);
});

async function searchStops(query, listEl, onPick) {
  try {
    const url = `${API_BASE}/api/stops?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
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
  } catch (err) {
    setStatus("Error searching stops: " + err.message);
  }
}

// --- Swap ---
swapBtn.addEventListener("click", () => {
  // swap text
  const fText = fromQ.value;
  fromQ.value = toQ.value;
  toQ.value = fText;

  // swap ids/names/coords
  [fromId, toId] = [toId, fromId];
  [fromName, toName] = [toName, fromName];
  [fromLat, toLat] = [toLat, fromLat];
  [fromLon, toLon] = [toLon, fromLon];

  // update markers if we have coords
  if (fromLat != null && fromLon != null) setMarker("from", fromLat, fromLon, `From: ${fromName}`);
  if (toLat != null && toLon != null) setMarker("to", toLat, toLon, `To: ${toName}`);
  fitToContent();
});

// --- Find route (POST /api/route) and draw on the map ---
goBtn.addEventListener("click", async () => {
  setStatus("");
  clearElement(legsEl);
  routeLayer.clearLayers(); // remove any previous route

  // Validate minimal inputs
  if (!fromId && !fromQ.value.trim()) {
    setStatus("Pick a 'From' stop.");
    return;
  }
  if (!toId && !toQ.value.trim()) {
    setStatus("Pick a 'To' stop.");
    return;
  }

  const body = {
    // Server accepts either IDs or names; we send both safely.
    fromId: fromId || undefined,
    toId: toId || undefined,
    fromName: fromName || (fromId ? undefined : fromQ.value.trim()),
    toName: toName || (toId ? undefined : toQ.value.trim()),
    depart: depart.value || "08:00"
  };

  try {
    const res = await fetch(`${API_BASE}/api/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || "No route found.");
      return;
    }

    // Render legs
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

    // Draw legs on the map (resolve leg endpoints to coordinates)
    for (const leg of legs) {
      const a = await resolveStop(leg.fromId, leg.fromName);
      const b = await resolveStop(leg.toId, leg.toName);
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { weight: 4, opacity: 0.9 }).addTo(routeLayer);
    }

    // Ensure endpoint markers are set from first/last leg
    const first = legs[0];
    const last = legs[legs.length - 1];
    const a0 = await resolveStop(first.fromId, first.fromName);
    const bN = await resolveStop(last.toId, last.toName);

    if (a0) {
      fromLat = a0.lat; fromLon = a0.lon; fromName = a0.name; fromId = String(a0.id);
      setMarker("from", a0.lat, a0.lon, `From: ${a0.name}`);
    }
    if (bN) {
      toLat = bN.lat; toLon = bN.lon; toName = bN.name; toId = String(bN.id);
      setMarker("to", bN.lat, bN.lon, `To: ${bN.name}`);
    }

    fitToContent();
  } catch (e) {
    setStatus("Error: " + e.message);
  }
});

// Optional: quick health check on load for clearer errors
(async () => {
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (!res.ok) throw new Error("Backend not reachable");
  } catch (e) {
    setStatus("Backend not reachable at " + API_BASE + " (" + e.message + ")");
  }
})();
