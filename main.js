// --- API base detection ---
const PROD_API = "https://sl-backend-zbny.onrender.com"; // <-- change if your prod URL differs
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
let fromSel = null;      // { id,name,lat?,lon? }
let toSel   = null;      // { id,name,lat?,lon? }
let map, fromMarker, toMarker, routeLayer;

// Will be filled after discovery
let ROUTE_CALL = null; // async (query) => json

// --- Utilities ---
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
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function takeSnippet(text, n = 180) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

// --- Stops API (autocomplete) ---
async function queryStops(q, { signal } = {}) {
  const endpoints = [
    `${API_BASE}/api/stops?q=${encodeURIComponent(q)}`,
    `${API_BASE}/api/stops/search?q=${encodeURIComponent(q)}`,
    `${API_BASE}/api/suggest?q=${encodeURIComponent(q)}`
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.results || data.stops || []);
      return list.map(it => ({
        id: it.id ?? it.stop_id ?? it.siteId ?? it.site_id ?? it.number ?? it.Name ?? it.name,
        name: it.name ?? it.stop_name ?? it.DisplayName ?? it.displayName ?? it.Name ?? it.description,
        lat: it.lat ?? it.stop_lat ?? it.y ?? it.Latitude ?? it.latitude,
        lon: it.lon ?? it.stop_lon ?? it.x ?? it.Longitude ?? it.longitude
      })).filter(s => s.id && s.name);
    } catch (_) {}
  }
  return [];
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
    } catch (_) {
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
  try {
    const line = L.polyline(latlngs, { weight: 5, opacity: 0.9 });
    routeLayer.addLayer(line);
    return line;
  } catch {}
  return null;
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

// --- Backend warmup (Overlay blocker) ---
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
  const timeouts = [8000, 10000, 12000, 15000, 15000, 15000, 15000, 15000, 15000, 15000];

  const nudge = () => fetch(`${API_BASE}/`, { mode: "no-cors" }).catch(() => {});

  for (let i = 0; i < attempts; i++) {
    try {
      nudge();
      const res = await fetchWithTimeout(`${API_BASE}/api/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Warmup": "1" },
        body: JSON.stringify({ warmup: true })
      }, timeouts[i]);
      break; // any response means container is up
    } catch (_) {
      const triesLeft = attempts - i - 1;
      if (triesLeft > 0) {
        bootMsg.textContent = `Waking the server… retrying (${triesLeft} left)`;
        await sleep(1000 + i * 1000);
        continue;
      } else {
        clearInterval(ticker);
        bootMsg.textContent = "Server didn’t respond. Please refresh or try again shortly.";
        return;
      }
    }
  }

  clearInterval(ticker);
  bootOverlay.classList.add("hide");
  setTimeout(() => bootOverlay.remove(), 350);
}

// --- Route endpoint discovery ---
async function discoverRouteEndpoint() {
  // candidates: [method, urlBuilder]
  const PATHS = ["/api/route", "/route", "/api/v1/route", "/v1/route", "/routes"];
  const candidates = [];

  for (const p of PATHS) {
    // POST JSON
    candidates.push({
      name: `POST ${p} (ids)`,
      call: async (q) => {
        const bodyA = {
          from: { id: q.fromId ?? null, name: q.fromName ?? null, lat: q.fromLat ?? null, lon: q.fromLon ?? null },
          to:   { id: q.toId ?? null,   name: q.toName ?? null,   lat: q.toLat ?? null,   lon: q.toLon ?? null   },
          departIso: q.departIso
        };
        const res = await fetchWithTimeout(`${API_BASE}${p}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyA)
        }, 25000);
        return res;
      }
    });
    // POST minimal ids
    candidates.push({
      name: `POST ${p} (fromId/toId)`,
      call: async (q) => {
        const bodyB = { fromId: q.fromId, toId: q.toId, departIso: q.departIso };
        const res = await fetchWithTimeout(`${API_BASE}${p}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyB)
        }, 25000);
        return res;
      }
    });
    // GET ids
    candidates.push({
      name: `GET ${p} (ids)`,
      call: async (q) => {
        const url = new URL(`${API_BASE}${p}`);
        if (q.fromId) url.searchParams.set("fromId", q.fromId);
        if (q.toId)   url.searchParams.set("toId",   q.toId);
        url.searchParams.set("departIso", q.departIso);
        const res = await fetchWithTimeout(url.toString(), {}, 25000);
        return res;
      }
    });
    // GET coords
    candidates.push({
      name: `GET ${p} (coords)`,
      call: async (q) => {
        const url = new URL(`${API_BASE}${p}`);
        if (q.fromLat != null && q.fromLon != null) {
          url.searchParams.set("fromLat", q.fromLat);
          url.searchParams.set("fromLon", q.fromLon);
        }
        if (q.toLat != null && q.toLon != null) {
          url.searchParams.set("toLat", q.toLat);
          url.searchParams.set("toLon", q.toLon);
        }
        url.searchParams.set("departIso", q.departIso);
        const res = await fetchWithTimeout(url.toString(), {}, 25000);
        return res;
      }
    });
  }

  // Build a sample query from current selections (fallback to rough center if not set)
  const sample = {
    fromId: fromSel?.id ?? null,
    toId:   toSel?.id   ?? null,
    fromName: (fromSel?.name ?? fromQ.value.trim()) || "T-Centralen",
    toName:   (toSel?.name   ?? toQ.value.trim())   || "Slussen",
    fromLat: fromSel?.lat ?? 59.330,
    fromLon: fromSel?.lon ?? 18.060,
    toLat:   toSel?.lat   ?? 59.319,
    toLon:   toSel?.lon   ?? 18.073,
    departIso: (new Date()).toISOString()
  };

  // We just need to know which one returns a 2xx with JSON.
  for (const c of candidates) {
    try {
      const res = await c.call(sample);
      const text = await res.text();
      // If the endpoint exists but we sent wrong shape, it might return 4xx with JSON. Try to parse anyway.
      let json = {};
      try { json = JSON.parse(text); } catch {}
      // Heuristic: success if 2xx and it's an object that looks like a route (has legs or geometry)
      const looksRoute = json && (Array.isArray(json.legs) || (json.geometry && json.geometry.type));
      if (res.ok && looksRoute) {
        ROUTE_CALL = async (query) => {
          const good = await c.call(query);
          const t = await good.text();
          try { return JSON.parse(t); } catch { throw new Error("Route endpoint returned non-JSON"); }
        };
        console.log("Route endpoint selected:", c.name);
        return;
      }
      // If 405/404, move on quickly. If 400 with JSON that looks like validation, still move on.
    } catch (e) {
      // Continue trying
    }
  }

  // Final fallback: keep the original POST /api/route signature
  ROUTE_CALL = async (q) => {
    const res = await fetchWithTimeout(`${API_BASE}/api/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: { id: q.fromId ?? null, name: q.fromName ?? null, lat: q.fromLat ?? null, lon: q.fromLon ?? null },
        to:   { id: q.toId ?? null,   name: q.toName ?? null,   lat: q.toLat ?? null,   lon: q.toLon ?? null   },
        departIso: q.departIso
      })
    }, 25000);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Fallback POST /api/route failed: ${res.status} ${takeSnippet(text)}`);
    }
    try { return JSON.parse(text); } catch { throw new Error("Route endpoint returned non-JSON"); }
  };
  console.warn("Using fallback route call (POST /api/route).");
}

// --- Route action ---
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
    const when = depart.value ? new Date(depart.value) : new Date();
    const query = {
      fromId: fromSel?.id ?? null,
      toId:   toSel?.id   ?? null,
      fromName: fromSel?.name ?? fromQ.value.trim(),
      toName:   toSel?.name   ?? toQ.value.trim(),
      fromLat: fromSel?.lat ?? null,
      fromLon: fromSel?.lon ?? null,
      toLat:   toSel?.lat   ?? null,
      toLon:   toSel?.lon   ?? null,
      departIso: when.toISOString()
    };

    let json, lastErr;
    for (let i = 0; i < 2; i++) {
      try {
        json = await ROUTE_CALL(query);
        break;
      } catch (e) {
        lastErr = e;
        await sleep(600);
      }
    }
    if (!json && lastErr) throw lastErr;

    const { shapes, legs } = extractShapes(json);
    for (const shape of shapes) addPolyline(shape);
    renderLegs(legs, json.summary || "");
    fitToContent();
    setStatus("Done.");
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
  await wakeBackend();     // block until container is warm
  await discoverRouteEndpoint(); // auto-select a working route path+method
  setStatus("Ready.");
})();
