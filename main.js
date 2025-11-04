// --- API base detection ---
const PROD_API = "https://sl-backend-zbny.onrender.com"; // <-- change to your prod URL if different
const LOCAL_DEV_API = "http://localhost:8081";
export const API_BASE = location.hostname.endsWith("github.io") ? PROD_API : LOCAL_DEV_API;

// --- DOM refs ---
const fromQ    = document.getElementById("fromQuery");
const toQ      = document.getElementById("toQuery");
const fromList = document.getElementById("fromList");
const toList   = document.getElementById("toList");
const depart   = document.getElementById("depart"); // type="time"
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
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}
function debounce(fn, delay = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), delay); }; }
function nowHHMM() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`; // local time → HH:mm
}

// --- Stops API ---
async function queryStops(q, { signal } = {}) {
  const url = `${API_BASE}/api/stops?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, mode: "cors" });
  if (!res.ok) return [];
  const data = await res.json();
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
  const debounced = debounce(runSearch, 150);
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
  if (type === "from") { if (fromMarker) fromMarker.remove(); fromMarker = marker.addTo(map); }
  else { if (toMarker) toMarker.remove(); toMarker = marker.addTo(map); }
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
    } else if (l.getLatLng) {
      bounds.push(l.getLatLng());
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

function mmToHHMM(mins) {
  if (!Number.isFinite(mins)) return "";
  const m = ((mins % (24*60)) + (24*60)) % (24*60); // wrap and keep positive
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
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

    // Title line shows times + endpoints
    const title = document.createElement("h3");
    const depStr = mmToHHMM(leg.depMin);
    const arrStr = mmToHHMM(leg.arrMin);
    title.textContent =
      `${depStr ? depStr + " " : ""}${leg.fromName || ""} → ${arrStr ? arrStr + " " : ""}${leg.toName || ""}`;

    // Body shows line/headsign, trip, duration
    const body = document.createElement("p");
    const bits = [];
    if (leg.headsign) bits.push(leg.headsign);
    if (leg.trip)     bits.push(`Trip ${leg.trip}`);
    if (Number.isFinite(leg.durationMin)) bits.push(`${leg.durationMin} min`);
    body.textContent = bits.join(" · ");

    div.append(title, body);
    wrap.appendChild(div);
  }
}

// --- Backend returns no polylines yet; we enrich legs and build geometry ourselves
function extractShapes(routeJson) {
  const shapes = [];  // backend doesn't return polyline shapes (yet)
  const legs   = [];

  if (Array.isArray(routeJson.legs)) {
    for (const leg of routeJson.legs) {
      const depMin = Number(leg.dep);
      const arrMin = Number(leg.arr);
      legs.push({
        // fields used by renderer
        mode: leg.headsign || "Ride",
        fromName: leg.fromName || "",
        toName: leg.toName || "",
        durationMin: Number.isFinite(depMin) && Number.isFinite(arrMin) ? (arrMin - depMin) : null,

        // enriched fields
        depMin,
        arrMin,
        headsign: leg.headsign || null,
        trip: leg.trip || null,

        // ids & hops for geometry
        fromId: leg.fromId ?? null,
        toId:   leg.toId   ?? null,
        hops:   Array.isArray(leg.hops) ? leg.hops : null
      });
    }
  }
  return { shapes, legs };
}

/* ============================
   Route geometry helpers (fallback)
   ============================ */

// Cache stops so we don’t re-fetch the same ones
const stopCache = new Map(); // key -> { id,name,lat,lon }
function putStopInCache(s) {
  if (!s) return;
  if (s.id != null) stopCache.set(String(s.id), s);
  if (s.name) stopCache.set(`name:${s.name.toLowerCase()}`, s);
}

// Try cache → /api/stops by id → /api/stops by name
async function lookupStop(keyId, nameFallback) {
  const kId = keyId != null ? String(keyId) : null;
  const kName = nameFallback ? `name:${nameFallback.toLowerCase()}` : null;

  if (kId && stopCache.has(kId)) return stopCache.get(kId);
  if (kName && stopCache.has(kName)) return stopCache.get(kName);

  if (kId) {
    try {
      const items = await queryStops(kId);
      const exact = items?.find(s => String(s.id) === kId);
      if (exact && Number.isFinite(exact.lat) && Number.isFinite(exact.lon)) {
        putStopInCache(exact);
        return exact;
      }
    } catch {}
  }

  if (nameFallback) {
    try {
      const items = await queryStops(nameFallback);
      const exactByName = items?.find(s => (s.name || "").toLowerCase() === nameFallback.toLowerCase());
      const pick = exactByName || items?.[0];
      if (pick && Number.isFinite(pick.lat) && Number.isFinite(pick.lon)) {
        putStopInCache(pick);
        return pick;
      }
    } catch {}
  }

  return null;
}

// Build straight-line segments and a unique list of stop nodes
async function legsToGeometry(legs = []) {
  const segments = []; // each: [[lat,lon],[lat,lon]]
  const nodes = [];    // each: {id,name,lat,lon}

  const pushNode = (s) => {
    if (!s) return;
    nodes.push({ id: s.id ?? s.name, name: s.name, lat: s.lat, lon: s.lon });
  };

  for (const leg of legs) {
    const from = await lookupStop(leg.fromId, leg.fromName);
    const to   = await lookupStop(leg.toId,   leg.toName);
    if (from && to) {
      segments.push([[from.lat, from.lon], [to.lat, to.lon]]);
      pushNode(from);
      pushNode(to);
    }
  }

  // de-dupe nodes by id
  const seen = new Set();
  const uniqueNodes = [];
  for (const n of nodes) {
    const k = String(n.id);
    if (seen.has(k)) continue;
    seen.add(k);
    uniqueNodes.push(n);
  }

  return { segments, nodes: uniqueNodes };
}

function addStopMarkers(nodes = []) {
  for (const n of nodes) {
    if (Number.isFinite(n.lat) && Number.isFinite(n.lon)) {
      const m = L.circleMarker([n.lat, n.lon], {
        radius: 5,
        weight: 2,
        fillOpacity: 0.9
      }).bindTooltip(n.name || "", { direction: "top", offset: [0, -6] });
      routeLayer.addLayer(m);
    }
  }
}

/* ============================
   Backend warmup (use /health)
   ============================ */
async function wakeBackend() {
  if (!bootOverlay) return;

  const phrases = ["Waking the back-end server...", "Almost there…", "It's worth the wait...", "Who's there?"];
  let i = 0;
  const ticker = setInterval(() => { bootMsg.textContent = phrases[i++ % phrases.length]; }, 2000);

  const attempts = 10;
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetchWithTimeout(`${API_BASE}/health`, { mode: "cors" }, 6000);
      if (res.ok) break;
    } catch {}
    const left = attempts - a - 1;
    if (left > 0) {
      bootMsg.textContent = `Waking the server… retrying (${left} left)`;
      await sleep(800 + a * 400);
    } else {
      clearInterval(ticker);
      bootMsg.textContent = "Server didn’t respond. Please refresh or try again shortly.";
      return;
    }
  }
  clearInterval(ticker);
  bootOverlay.classList.add("hide");
  setTimeout(() => bootOverlay.remove(), 350);
}

/* ==========================================
   Route action (POST /api/route; depart HH:mm)
   ========================================== */
async function findRoute() {
  if (!fromQ.value.trim() || !toQ.value.trim()) {
    setStatus("Pick both 'From' and 'To' stops.");
    return;
  }

  clearRoute();
  setStatus("Finding route…");

  // mini overlay
  const blocker = document.createElement("div");
  blocker.style.position = "fixed";
  blocker.style.inset = "0";
  blocker.style.background = "rgba(255,255,255,.6)";
  blocker.style.zIndex = "500";
  blocker.innerHTML = '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);"><div class="loader"></div></div>';
  document.body.appendChild(blocker);

  try {
    const chosen = depart.value?.trim() || nowHHMM(); // "HH:mm"
    const body = {
      depart: chosen,
      fromId:  fromSel?.id ?? null,
      toId:    toSel?.id   ?? null,
      fromName: fromSel?.name ?? fromQ.value.trim(),
      toName:   toSel?.name   ?? toQ.value.trim()
    };

    const res = await fetchWithTimeout(`${API_BASE}/api/route`, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    }, 25000);

    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}

    if (!res.ok) {
      throw new Error(`${res.status} ${text ? text.slice(0,160) : ""}`);
    }

    const { shapes, legs } = extractShapes(json);

    // 1) Prefer backend-provided shapes (future-proof)
    let drewAnything = false;
    if (Array.isArray(shapes) && shapes.length) {
      for (const shape of shapes) {
        if (shape && shape.length) { addPolyline(shape); drewAnything = true; }
      }
    }

    // 2) Next, prefer hops (each leg carries every station with lat/lon)
    if (!drewAnything) {
      let anyHops = false;
      for (const leg of legs) {
        if (Array.isArray(leg.hops) && leg.hops.length >= 2) {
          anyHops = true;
          const coords = leg.hops
            .filter(h => Number.isFinite(h.lat) && Number.isFinite(h.lon))
            .map(h => [h.lat, h.lon]);
          addPolyline(coords);

          // markers for each hop
          for (const h of leg.hops) {
            if (Number.isFinite(h.lat) && Number.isFinite(h.lon)) {
              const m = L.circleMarker([h.lat, h.lon], {
                radius: 5, weight: 2, fillOpacity: 0.9
              }).bindTooltip(h.name || "", { direction: "top", offset: [0, -6] });
              routeLayer.addLayer(m);
            }
          }
        }
      }

      // 3) Fallback: just connect leg endpoints via /api/stops lookups
      if (!anyHops) {
        const { segments, nodes } = await legsToGeometry(legs);
        for (const seg of segments) addPolyline(seg);
        addStopMarkers(nodes);
      }
    }

    const parts = [];
    if (Number.isFinite(json.total))      parts.push(`Total ${json.total} min`);
    if (Number.isFinite(json.transfers))  parts.push(`${json.transfers} transfer${json.transfers === 1 ? "" : "s"}`);
    const summary = parts.join(" · ");

    renderLegs(legs, summary);
    fitToContent();
    setStatus("Done.");
  } catch (e) {
    const likelyCORS = (e instanceof TypeError) || /NetworkError|TypeError/.test(String(e));
    if (likelyCORS) setStatus("Error finding route: network/CORS blocked. Check PROD_API and CORS_ORIGIN.");
    else setStatus(`Error finding route: ${e.message || "backend unreachable"}`);
    console.error(e);
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

// Default depart = now (HH:mm local)
(function initDepartNow(){
  depart.value = nowHHMM();
})();

// Autocomplete (backend-powered)
bindAutocomplete(fromQ, fromList, s => (fromSel = s), "from");
bindAutocomplete(toQ,   toList,   s => (toSel   = s), "to");

// Map + boot
initMap();
(async function boot() {
  await wakeBackend(); // wait for /health
  setStatus("Ready.");
})();
