// TrailTrak app: trail map, highlights, and which clubs meet where this week.
import { buildMatchers, parsePost, pacificDate, weekWindow, dowOf, DOW, daysBetween, TAGS, distanceRange } from "./parser.js";

const CLUB_COLORS = ["#f25c05", "#6a4c93", "#d99a00", "#3e8e5e", "#d6336c", "#1b7f9e", "#b5541b", "#8e5cc4",
  "#c9184a", "#2a9d8f", "#e76f51", "#5e60ce", "#7a9e3e", "#c2410c", "#9d4edd", "#0f766e"];
const TERRAIN = {
  "off-road": { color: "#8c5a2b", light: "#f3e9df", label: "Off-road" },
  "on-road": { color: "#3a86ff", light: "#e6f0ff", label: "On-road" },
};
const NEAR_KM = 0.45;      // a meetup within this distance of a trail counts as "meeting there"
const LOCAL_KEY = "trailtrak.localRuns.v1";
const PREFS_KEY = "trailtrak.prefs.v1";
const DIST = {
  any: { label: "Any distance" },
  short: { label: "Up to 5K", test: ([lo]) => lo <= 3.5 },
  mid: { label: "3–6 mi", test: ([lo, hi]) => hi >= 3 && lo <= 6 },
  long: { label: "6+ mi", test: ([, hi]) => hi >= 6 },
};

const state = {
  trails: [], byId: new Map(), clubs: [], clubById: new Map(), places: [], schedule: null,
  events: [], selected: new Set(), terrain: { "off-road": true, "on-road": true }, busyOnly: false,
  day: "all", clubFilter: "", textFilter: "", tab: "trails", today: pacificDate(),
  // filters the runner sets; favorites and "my clubs" are remembered on this device
  favs: new Set(), myOnly: false, tod: "all", dist: "any", tags: new Set(),
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const getJSON = (u) => fetch(u, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });
const prefs = {
  load() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      state.favs = new Set(p.favs || []);
      state.myOnly = !!p.myOnly && state.favs.size > 0; // starred clubs are the default view
    } catch { /* storage blocked: start fresh */ }
  },
  save() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ favs: [...state.favs], myOnly: state.myOnly })); } catch { /* private mode */ }
  },
};
const store = {
  get() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]"); } catch { return []; } },
  set(v) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------- formatting ----------
function fmtTime(e) {
  if (e.time) {
    const [h, m] = e.time.split(":").map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
  return e.when ? e.when[0].toUpperCase() + e.when.slice(1) : "Time TBA";
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function fmtDay(iso, long = false) {
  const d = daysBetween(state.today, iso);
  const name = d === 0 ? "Today" : d === 1 ? "Tomorrow" : (long ? DAY_LONG : DOW)[dowOf(iso)];
  return name;
}
const fmtDate = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
const initials = (name) => name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter((w) => !/^(run|running|club|sd|the|of|san|diego|rc)$/i.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || name.slice(0, 2).toUpperCase();

function sourceBadge(e) {
  const s = e.source || {};
  if (e.cancelled) return `<span class="src cancel">✕ Cancelled${s.url ? ` · <a href="${esc(s.url)}" target="_blank" rel="noopener">post</a>` : ""}</span>`;
  const label = { instagram: "📸 From Instagram", website: "🌐 From club site", manual: "📝 Added post", local: "📝 Added by you", usual: "Usual schedule" }[s.type] || "Schedule";
  const ocr = s.ocr ? " · read from image" : "";
  return s.url
    ? `<a class="src ${s.type}" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.label || "")}">${label}${ocr} ↗</a>`
    : `<span class="src ${s.type || "usual"}" title="${esc(s.label || "")}">${label}${ocr}</span>`;
}

// ---------- geometry ----------
function km(lat1, lng1, lat2, lng2) {
  const kx = 111.32 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot((lng2 - lng1) * kx, (lat2 - lat1) * 110.54);
}
function distToTrail(t, lat, lng) {
  const pad = 0.006;
  const [s, w, n, e] = t.bbox;
  if (lat < s - pad || lat > n + pad || lng < w - pad || lng > e + pad) return Infinity;
  let best = Infinity;
  for (const line of t.f.geometry.coordinates) {
    for (let i = 0; i < line.length; i++) {
      const d = km(lat, lng, line[i][1], line[i][0]);
      if (d < best) best = d;
      if (i > 0) { // also check the middle of each segment
        const ml = (line[i][1] + line[i - 1][1]) / 2, mg = (line[i][0] + line[i - 1][0]) / 2;
        const dm = km(lat, lng, ml, mg);
        if (dm < best) best = dm;
      }
    }
  }
  return best;
}
// "near Pacific Beach": the closest known place, to tell same-named trails apart
function nearName(t) {
  if (t.near !== undefined) return t.near;
  let best = null, bd = 12;
  for (const p of state.places) {
    const d = km(t.center[0], t.center[1], p.lat, p.lng);
    if (d < bd) { bd = d; best = p.name; }
  }
  return (t.near = best);
}
// Which trails a run starts on or next to (named in the post, or within NEAR_KM of the meeting spot)
function attachTrails(e) {
  const ids = new Map((e.trailIds || []).map((id) => [id, 0]));
  if (e.place?.lat != null) {
    for (const t of state.trails) {
      const d = distToTrail(t, e.place.lat, e.place.lng);
      if (d < NEAR_KM && (!ids.has(t.id) || d < ids.get(t.id))) ids.set(t.id, d);
    }
  }
  e.nearTrails = [...ids.entries()].filter(([id]) => state.byId.has(id)).sort((a, b) => a[1] - b[1]).slice(0, 8).map(([id]) => id);
  e.terrain = e.nearTrails.length ? state.byId.get(e.nearTrails[0]).terrain : null;
  return e;
}
function linkEventsToTrails() {
  for (const t of state.trails) t.events = [];
  for (const e of state.events) {
    attachTrails(e);
    for (const id of e.nearTrails) state.byId.get(id).events.push(e);
  }
}

// ---------- data ----------
async function load() {
  const [trailsGJ, clubsJ, placesJ, schedule] = await Promise.all([
    getJSON("data/trails.geojson"), getJSON("data/clubs.json"), getJSON("data/places.json"),
    getJSON("data/schedule.json").catch(() => null),
  ]);
  state.trails = trailsGJ.features.map((f) => {
    let s = 90, w = 180, n = -90, e = -180;
    for (const line of f.geometry.coordinates) for (const [x, y] of line) { if (y < s) s = y; if (y > n) n = y; if (x < w) w = x; if (x > e) e = x; }
    return { id: f.properties.id, name: f.properties.name, terrain: f.properties.terrain, miles: f.properties.miles,
      surface: f.properties.surface, kind: f.properties.kind, center: f.properties.center, source: f.properties.source, park: f.properties.park,
      bbox: [s, w, n, e], f, events: [] };
  });
  state.byId = new Map(state.trails.map((t) => [t.id, t]));
  state.clubs = clubsJ.clubs.map((c, i) => ({ ...c, color: CLUB_COLORS[i % CLUB_COLORS.length] }));
  state.clubById = new Map(state.clubs.map((c) => [c.id, c]));
  state.places = placesJ.places;
  state.schedule = schedule;
  state.matchers = buildMatchers(state.places, state.trails.map((t) => ({ id: t.id, name: t.name, center: t.center })));
  collectEvents();
}
function collectEvents() {
  const window = new Set(weekWindow(state.today));
  const fromServer = (state.schedule?.events || []).filter((e) => window.has(e.date));
  const local = store.get().filter((e) => window.has(e.date));
  // A run you added on this device replaces the usual-schedule entry for that club and day
  const localKeys = new Set(local.map((e) => e.clubId + e.date));
  state.events = [...fromServer.filter((e) => !(e.source?.type === "usual" && localKeys.has(e.clubId + e.date))), ...local]
    .filter((e) => state.clubById.has(e.clubId))
    .sort((a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")));
  for (const e of state.events) {
    e.tags = [...new Set([...(state.clubById.get(e.clubId).tags || []), ...(e.tags || [])])];
    e.range = distanceRange(e.distance);
  }
  linkEventsToTrails();
}

// ---------- map ----------
let map, trailPane, haloRenderer, trailRenderer, trailLayers = {}, haloLayer, pinLayer;
function initMap() {
  map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 9, attributionControl: false }).setView([32.83, -117.12], 11);
  L.control.attribution({ prefix: false, position: "bottomright" }).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  // Esri Light Gray Canvas: a near-white base with labels on a separate layer above the trails
  const esri = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/";
  L.tileLayer(esri + "World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, maxNativeZoom: 16, className: "basemap",
    attribution: '&copy; Esri, HERE, Garmin · <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · City &amp; County of SD',
  }).addTo(map);
  map.createPane("labels").style.zIndex = 430;
  map.getPane("labels").style.pointerEvents = "none";
  L.tileLayer(esri + "World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, maxNativeZoom: 16, pane: "labels" }).addTo(map);
  map.createPane("halo").style.zIndex = 405;
  map.createPane("trails").style.zIndex = 410;
  map.createPane("top").style.zIndex = 420;
  trailRenderer = L.canvas({ pane: "trails", tolerance: 6 });
  haloRenderer = L.canvas({ pane: "halo", tolerance: 4 });
  haloLayer = L.layerGroup().addTo(map);
  pinLayer = L.layerGroup().addTo(map);

  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = () => {
    const d = L.DomUtil.create("div", "legend");
    d.innerHTML = `<div><i style="background:${TERRAIN["off-road"].color}"></i>Off-road: dirt, gravel, singletrack</div>
      <div><i style="background:${TERRAIN["on-road"].color}"></i>On-road: paved paths, bikeways, boardwalks</div>
      <div><i style="background:#f2b705;height:8px;opacity:.7"></i>Highlighted</div>`;
    return d;
  };
  legend.addTo(map);
  map.on("zoomend", () => restyleTrails());
}
const weightFor = (t) => {
  const z = map.getZoom();
  const base = z >= 15 ? 3.4 : z >= 13 ? 2.6 : z >= 11 ? 1.8 : 1.2;
  return t.events.length ? base + 1.2 : base;
};
const trailStyle = (t) => ({ color: TERRAIN[t.terrain].color, weight: weightFor(t), opacity: state.selected.size && !state.selected.has(t.id) ? 0.55 : 0.92, lineCap: "round", lineJoin: "round" });

function renderTrails() {
  for (const l of Object.values(trailLayers)) map.removeLayer(l);
  trailLayers = {};
  for (const terrain of Object.keys(TERRAIN)) {
    if (!state.terrain[terrain]) continue;
    const list = state.trails.filter((t) => t.terrain === terrain && (!state.busyOnly || dayEvents(t.events).length));
    const layer = L.layerGroup();
    for (const t of list) {
      const pl = L.polyline(t.f.geometry.coordinates.map((l) => l.map(([x, y]) => [y, x])), { ...trailStyle(t), renderer: trailRenderer, pane: "trails" });
      pl.bindTooltip(() => tipHtml(t), { sticky: true, className: "trail-tip", direction: "top", offset: [0, -6] });
      pl.on("click", (ev) => { L.DomEvent.stopPropagation(ev); toggleTrail(t.id, { openTab: true }); });
      t.layer = pl;
      layer.addLayer(pl);
    }
    layer.addTo(map);
    trailLayers[terrain] = layer;
  }
  $("#nOff").textContent = state.trails.filter((t) => t.terrain === "off-road").length.toLocaleString();
  $("#nOn").textContent = state.trails.filter((t) => t.terrain === "on-road").length.toLocaleString();
}
function restyleTrails() {
  for (const t of state.trails) if (t.layer) t.layer.setStyle(trailStyle(t));
  renderHalos();
}
function tipHtml(t) {
  const n = dayEvents(t.events).length;
  return `<b>${esc(t.name)}</b><br><span style="color:${TERRAIN[t.terrain].color};font-weight:600">${TERRAIN[t.terrain].label}</span> · ${t.miles} mi${n ? ` · <b style="color:#f25c05">${n} club run${n > 1 ? "s" : ""}</b>` : ""}`;
}
function renderHalos() {
  haloLayer.clearLayers();
  const z = map.getZoom();
  for (const id of state.selected) {
    const t = state.byId.get(id);
    const latlngs = t.f.geometry.coordinates.map((l) => l.map(([x, y]) => [y, x]));
    L.polyline(latlngs, { color: "#f2b705", weight: z >= 14 ? 16 : 12, opacity: 0.55, renderer: haloRenderer, pane: "halo", interactive: false }).addTo(haloLayer);
    const top = L.polyline(latlngs, { color: TERRAIN[t.terrain].color, weight: z >= 14 ? 5.5 : 4.5, opacity: 1, pane: "top", renderer: L.canvas({ pane: "top", tolerance: 6 }) });
    top.bindTooltip(() => tipHtml(t), { sticky: true, className: "trail-tip" });
    top.on("click", (ev) => { L.DomEvent.stopPropagation(ev); toggleTrail(id); });
    top.addTo(haloLayer);
  }
}
function toggleTrail(id, { openTab = false, only = false, fit = false } = {}) {
  if (only) state.selected = new Set([id]);
  else if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  if (fit) fitTrail(id);
  restyleTrails();
  renderTrailsTab();
  if (openTab) setTab("trails");
}
function fitTrail(id) {
  const [s, w, n, e] = state.byId.get(id).bbox;
  map.fitBounds([[s, w], [n, e]], { padding: [70, 70], maxZoom: 15 });
}

// Meetup pins, one per meeting spot
function renderPins() {
  pinLayer.clearLayers();
  const groups = new Map();
  for (const e of dayEvents(state.events)) {
    if (e.place?.lat == null) continue;
    const k = e.place.lat.toFixed(4) + "," + e.place.lng.toFixed(4);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  for (const evs of groups.values()) {
    const clubs = [...new Set(evs.map((e) => e.clubId))];
    const live = evs.filter((e) => !e.cancelled);
    const color = clubs.length === 1 ? state.clubById.get(clubs[0]).color : "#6a4c93";
    const label = clubs.length === 1 ? initials(state.clubById.get(clubs[0]).name) : String(clubs.length);
    const icon = L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28],
      html: `<div class="pin" style="background:${live.length ? color : "#aaa"}"><span>${esc(label)}</span></div>` });
    const m = L.marker([evs[0].place.lat, evs[0].place.lng], { icon, riseOnHover: true, title: evs[0].place.name });
    m.bindPopup(() => popupHtml(evs), { maxWidth: 300 });
    m.on("popupopen", (p) => {
      p.popup.getElement().querySelector("[data-near]")?.addEventListener("click", () => {
        const ids = [...new Set(evs.flatMap((e) => e.nearTrails))];
        state.selected = new Set(ids);
        restyleTrails(); renderTrailsTab(); setTab("trails"); map.closePopup();
      });
    });
    pinLayer.addLayer(m);
  }
}
function popupHtml(evs) {
  const near = [...new Set(evs.flatMap((e) => e.nearTrails))];
  return `<div class="pop"><h5>${esc(evs[0].place.name)}${evs[0].place.approx ? ' <small style="color:#999;font-weight:400">(approx. spot)</small>' : ""}</h5>
    <ul>${evs.map((e) => {
      const c = state.clubById.get(e.clubId);
      return `<li${e.cancelled ? ' style="opacity:.55;text-decoration:line-through"' : ""}><span class="t">${fmtDay(e.date)}<br>${fmtTime(e)}</span><span class="cdot" style="background:${c.color}"></span><span>${esc(c.name)}</span></li>`;
    }).join("")}</ul>
    ${near.length ? `<button class="btn purple" data-near style="padding:7px 12px;font-size:13px">Highlight ${near.length} nearby trail${near.length > 1 ? "s" : ""}</button>` : `<div class="hint" style="margin-top:6px">Street run: no mapped trail right here.</div>`}</div>`;
}

// ---------- filters ----------
const hourOf = (e) => (e.time ? +e.time.slice(0, 2) : e.when === "morning" || e.when === "sunrise" ? 8 : e.when ? 18 : null);
/** Every filter except the day: my clubs, time of day, distance, run type, terrain */
function passes(e) {
  if (state.myOnly && !state.favs.has(e.clubId)) return false;
  if (state.clubFilter && e.clubId !== state.clubFilter) return false;
  if (state.tod !== "all") {
    const h = hourOf(e);
    if (h == null || (state.tod === "am" ? h >= 12 : h < 12)) return false;
  }
  if (state.dist !== "any" && !(e.range && DIST[state.dist].test(e.range))) return false;
  if (state.tags.size && !e.tags.some((t) => state.tags.has(t))) return false;
  if (e.terrain && !state.terrain[e.terrain]) return false;
  return true;
}
function dayEvents(evs) { return evs.filter((e) => (state.day === "all" || e.date === state.day) && passes(e)); }
function filterCount() { return (state.tod !== "all") + (state.dist !== "any") + state.tags.size; }
function rerender() {
  renderDays(); renderPins(); renderWeekTab(); renderTrailsTab(); renderFilterBar();
  if (state.busyOnly) renderTrails(); else restyleTrails();
}
function renderFilterBar() {
  const fav = $("#fFav");
  fav.setAttribute("aria-pressed", state.myOnly);
  fav.querySelector(".n").textContent = state.favs.size ? state.favs.size : "";
  const n = filterCount();
  $("#fMore").setAttribute("aria-pressed", n > 0);
  $("#nFilt").textContent = n ? n : "";
  const pop = $("#filterpop");
  if (pop.hidden) return;
  const opt = (group, key, label, on) => `<button class="opt" data-${group}="${key}" aria-pressed="${on}">${label}</button>`;
  pop.innerHTML = `<div class="fp-head"><b>Filters</b><button class="icon-btn" id="fpClose" aria-label="Close filters">✕</button></div>
    <div class="fp-sec"><h5>Distance</h5><div class="opts">${Object.entries(DIST).map(([k, d]) => opt("dist", k, d.label, state.dist === k)).join("")}</div>
      ${state.dist !== "any" ? '<p class="hint">Runs that don\'t list a distance are hidden.</p>' : ""}</div>
    <div class="fp-sec"><h5>Run type <small class="hint">(any of)</small></h5><div class="opts">${Object.entries(TAGS).map(([k, t]) => opt("tag", k, `${t.icon} ${t.label}`, state.tags.has(k))).join("")}</div></div>
    <div class="btn-row"><button class="btn alt" id="fpReset">Reset filters</button><button class="btn purple" id="fpDone">${(() => { const n = state.events.filter((e) => passes(e) && (state.day === "all" || e.date === state.day) && !e.cancelled).length; return `Show ${n} run${n === 1 ? "" : "s"}`; })()}</button></div>`;
}
function toggleFilterPop(open = $("#filterpop").hidden) {
  $("#filterpop").hidden = !open;
  $("#fMore").setAttribute("aria-expanded", open);
  renderFilterBar();
}
function renderDays() {
  const days = weekWindow(state.today);
  const live = state.events.filter((e) => passes(e) && !e.cancelled);
  const count = (d) => live.filter((e) => e.date === d).length;
  const tod = (k, label, title) => `<button data-tod="${k}" aria-pressed="${state.tod === k}" title="${title}">${label}</button>`;
  $("#days").innerHTML = `<div class="tod" role="group" aria-label="Time of day">${tod("all", "Any", "Any time")}${tod("am", "☀️ AM", "Morning runs")}${tod("pm", "🌙 PM", "Afternoon and evening runs")}</div>` +
    `<button class="day" data-day="all" aria-pressed="${state.day === "all"}"><b>All week</b><small>${live.length} runs</small></button>` +
    days.map((d) => `<button class="day" data-day="${d}" aria-pressed="${state.day === d}" aria-label="${fmtDay(d, true)} ${fmtDate(d)}, ${count(d)} runs"><b>${fmtDay(d)}</b><small>${fmtDate(d)} · ${count(d)}</small></button>`).join("");
}
function setDay(d) {
  state.day = d;
  rerender();
}

// ---------- panel: tabs ----------
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === "v-" + tab));
  if (tab === "add") renderAddTab();
}

function runRow(e, { showDay = true, showPlace = true } = {}) {
  const c = state.clubById.get(e.clubId);
  const terrain = e.terrain ? `<span class="terrain ${e.terrain}">${TERRAIN[e.terrain].label}</span>` : `<span class="terrain street">Streets</span>`;
  const where = e.place ? `${esc(e.place.name)}${e.place.fromUsual ? " (usual spot)" : ""}` : "Location in post";
  const tags = (e.tags || []).map((t) => TAGS[t] && `<span class="tag" title="${TAGS[t].label}">${TAGS[t].icon}<span> ${TAGS[t].label}</span></span>`).join("");
  return `<li class="${e.cancelled ? "cancelled" : ""}" data-ev="${esc(e.id)}">
    <div class="when-col">${showDay ? `<b>${fmtDay(e.date)}</b><small>${fmtDate(e.date)} · ${fmtTime(e)}</small>` : `<b>${fmtTime(e)}</b><small>${fmtDay(e.date)}</small>`}</div>
    <div><span class="club-name"><span class="cdot" style="background:${c.color}"></span>${esc(c.name)}${state.favs.has(c.id) ? '<span class="fav-mark" title="One of your clubs">★</span>' : ""}</span>
      ${showPlace ? `<div class="where">📍 ${where}${e.distance ? ` · ${esc(e.distance)}` : ""}</div>` : e.distance ? `<div class="where">${esc(e.distance)}</div>` : ""}
      <div class="pill-row">${showPlace ? terrain : ""}${sourceBadge(e)}${e.timeGuessed ? '<span class="src usual" title="The post gave no am/pm">am/pm guessed</span>' : ""}</div>
      ${tags ? `<div class="tag-row">${tags}</div>` : ""}
    </div></li>`;
}

const EMPTY_ART = `<svg viewBox="0 0 120 70" aria-hidden="true"><circle cx="92" cy="18" r="10" fill="#f2b705"/><path d="M4 62 38 24l18 20 12-12 46 30z" fill="#f6f1e7"/><path d="M14 66c18-14 40-6 58-24" stroke="#8c5a2b" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M60 66c14-8 30-10 52-22" stroke="#3a86ff" stroke-width="3.5" fill="none" stroke-linecap="round"/></svg>`;

function renderTrailsTab() {
  const el = $("#v-trails");
  const badge = $("#selCount");
  badge.hidden = !state.selected.size;
  badge.textContent = state.selected.size;
  const dayNote = state.day === "all" ? "this week" : `${fmtDay(state.day, true).toLowerCase() === "today" ? "today" : "on " + fmtDay(state.day, true)}`;

  if (!state.selected.size) {
    // Real trails first: skip short connector bits, rank by how many different clubs meet there
    const clubsAt = (t) => new Set(dayEvents(t.events).filter((e) => !e.cancelled).map((e) => e.clubId)).size;
    const busy = state.trails.filter((t) => t.miles >= 0.5 && clubsAt(t))
      .sort((a, b) => clubsAt(b) - clubsAt(a) || dayEvents(b.events).length - dayEvents(a.events).length || b.miles - a.miles).slice(0, 12);
    el.innerHTML = `<h2>Tap a trail to highlight it</h2>
      <p class="lede">Tap any line on the map, or search above. You can highlight several at once. This tab then lists which run clubs meet on them ${dayNote}.</p>
      <div class="empty">${EMPTY_ART}</div>
      <h3>Busiest trails ${dayNote}</h3>
      ${busy.length ? `<ul class="runs" style="border:1px solid var(--line);border-radius:14px">${busy.map((t) => {
        const n = dayEvents(t.events).filter((e) => !e.cancelled).length;
        return `<li data-trail="${t.id}" style="cursor:pointer;grid-template-columns:1fr auto"><div><span class="club-name"><span class="cdot" style="background:${TERRAIN[t.terrain].color};border-radius:3px"></span>${esc(t.name)}</span><div class="where">${TERRAIN[t.terrain].label} · ${t.miles} mi${nearName(t) ? ` · near ${esc(nearName(t))}` : ""}</div></div><b style="color:var(--poppy);align-self:center">${n} run${n > 1 ? "s" : ""}</b></li>`;
      }).join("")}</ul>` : `<p class="no-runs">No club runs are mapped to a trail ${dayNote}.</p>`}`;
    el.querySelectorAll("[data-trail]").forEach((li) => li.addEventListener("click", () => toggleTrail(li.dataset.trail, { fit: true })));
    return;
  }

  el.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><h2 style="flex:1">${state.selected.size} highlighted trail${state.selected.size > 1 ? "s" : ""}</h2>
    <button class="btn alt" id="clearSel" style="padding:7px 12px;font-size:13px">Clear</button></div>
    <p class="lede">Club runs ${dayNote} that start on or within about a quarter mile of each trail.</p>` +
    [...state.selected].map((id) => {
      const t = state.byId.get(id);
      const evs = dayEvents(t.events);
      const T = TERRAIN[t.terrain];
      return `<article class="trail-card" style="--tc:${T.color};--tcl:${T.light}">
        <header><h4><span>${esc(t.name)}</span>
          <button class="icon-btn" data-zoom="${id}" title="Zoom to trail">⤢</button>
          <button class="icon-btn" data-remove="${id}" title="Remove highlight">✕</button></h4>
          <div class="meta"><span class="terrain ${t.terrain}">${T.label}</span><span>${t.miles} mi mapped</span>${nearName(t) ? `<span>near ${esc(nearName(t))}</span>` : ""}${t.surface ? `<span>Surface: ${esc(t.surface)}</span>` : ""}<span>${{ city: "City of SD official trail", county: "County Parks trail", osm: "OpenStreetMap" }[t.source] || ""}${t.park && !t.name.includes(t.park) ? ` · ${esc(t.park)}` : ""}</span></div>
        </header>
        ${evs.length ? `<ul class="runs">${evs.map((e) => runRow(e, { showPlace: true })).join("")}</ul>`
          : `<div class="no-runs">No club runs here ${dayNote}. ${state.day !== "all" ? '<a href="#" data-allweek>See the whole week</a>' : ""}</div>`}
      </article>`;
    }).join("");
  $("#clearSel").addEventListener("click", () => { state.selected.clear(); restyleTrails(); renderTrailsTab(); });
  el.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => fitTrail(b.dataset.zoom)));
  el.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => toggleTrail(b.dataset.remove)));
  el.querySelectorAll("[data-allweek]").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); setDay("all"); }));
  bindRunClicks(el);
}

function bindRunClicks(el) {
  el.querySelectorAll("li[data-ev]").forEach((li) => li.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) return;
    const e = state.events.find((x) => x.id === li.dataset.ev);
    if (!e?.place?.lat) return;
    map.flyTo([e.place.lat, e.place.lng], Math.max(map.getZoom(), 15), { duration: 0.8 });
    pinLayer.eachLayer((m) => {
      const ll = m.getLatLng();
      if (Math.abs(ll.lat - e.place.lat) < 1e-4 && Math.abs(ll.lng - e.place.lng) < 1e-4) setTimeout(() => m.openPopup(), 850);
    });
  }));
}

function renderWeekTab() {
  const el = $("#v-week");
  const q = state.textFilter.toLowerCase();
  const evs = dayEvents(state.events).filter((e) => {
    if (q) {
      const c = state.clubById.get(e.clubId);
      if (!(c.name + " " + (e.place?.name || "") + " " + (c.area || "")).toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const byDay = new Map();
  for (const e of evs) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
  const fresh = state.events.filter((e) => e.source?.type !== "usual").length;
  el.innerHTML = `<h2>Club runs this week</h2>
    <p class="lede">${state.events.length} runs from ${state.clubs.length} clubs · ${fresh} confirmed by a recent post or club site. The rest are each club's usual schedule.</p>
    ${state.myOnly ? `<div class="notice" style="background:#f4effa;border-color:#d9cdea">Showing your ${state.favs.size} starred club${state.favs.size === 1 ? "" : "s"} only. <a href="#" id="showAll">Show all clubs</a></div>` : ""}
    ${filterCount() ? `<div class="notice" style="background:#fdfbf7;border-color:var(--line)">${filterCount()} filter${filterCount() > 1 ? "s" : ""} on. <a href="#" id="clearF">Clear filters</a></div>` : ""}
    <div class="filters">
      <input id="wq" type="search" placeholder="Filter by club or place" value="${esc(state.textFilter)}" />
      <select id="wclub"><option value="">All clubs</option>${state.clubs.map((c) => `<option value="${c.id}" ${state.clubFilter === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
    </div>
    ${byDay.size ? [...byDay.entries()].map(([d, list]) => `<section class="daygroup"><h3>${fmtDay(d, true)} <small>${fmtDate(d)} · ${list.length} run${list.length > 1 ? "s" : ""}</small></h3>
      <ul class="runs">${list.map((e) => runRow(e, { showDay: false })).join("")}</ul></section>`).join("")
      : `<div class="empty">${EMPTY_ART}<p>No runs match these filters.</p></div>`}`;
  const wq = $("#wq");
  wq.addEventListener("input", () => { state.textFilter = wq.value; const pos = wq.selectionStart; renderWeekTab(); const n = $("#wq"); n.focus(); n.setSelectionRange(pos, pos); });
  $("#wclub").addEventListener("change", (ev) => { state.clubFilter = ev.target.value; rerender(); });
  $("#showAll")?.addEventListener("click", (ev) => { ev.preventDefault(); setMyOnly(false); });
  $("#clearF")?.addEventListener("click", (ev) => { ev.preventDefault(); state.tod = "all"; state.dist = "any"; state.tags.clear(); rerender(); });
  bindRunClicks(el);
}

function renderClubsTab() {
  const el = $("#v-clubs");
  const st = new Map((state.schedule?.clubs || []).map((s) => [s.id, s]));
  const igOn = state.schedule?.instagram === "on";
  const usualText = (c) => (c.usual || []).map((u) => `${u.days.join("/")} ${u.time ? fmtTime(u) : u.when || ""}${u.place ? " · " + u.place : ""}`).join("; ") || "Rotating schedule: watch their posts";
  const clubs = [...state.clubs].sort((a, b) => state.favs.has(b.id) - state.favs.has(a.id));
  el.innerHTML = `<h2>${state.clubs.length} run clubs</h2>
    <p class="lede" style="margin-bottom:6px">Tap ☆ to star your clubs. With <b>★ My clubs</b> on, the map and schedule show only them.</p>
    <p class="lede">TrailTrak checks each club's Instagram and website at 12:00 AM and 12:00 PM Pacific and reads both captions and flyer images.</p>
    ${igOn ? "" : `<div class="notice"><b>Instagram reading is off.</b> Add an Instagram Graph API token to turn it on (see README). Until then, schedules come from club websites, posts added in "Add a post", and each club's usual schedule.</div>`}
    <div class="club-grid">${clubs.map((c) => {
      const s = st.get(c.id);
      const n = state.events.filter((e) => e.clubId === c.id && !e.cancelled).length;
      const igState = !s ? "" : s.instagram.startsWith("@") ? `<span class="ok">✓ Instagram read (${s.posts} recent post${s.posts === 1 ? "" : "s"})</span>`
        : s.instagram === "error" ? `<span class="warn">Instagram error</span>` : s.instagram === "no token" ? "Instagram: waiting for token" : "";
      const fav = state.favs.has(c.id);
      return `<article class="club-card${fav ? " fav" : ""}"><div class="av" style="background:${c.color}">${esc(initials(c.name))}</div>
        <div><h4 style="display:flex;gap:6px;align-items:start"><span style="flex:1">${esc(c.name)}</span>
          <button class="star" data-star="${c.id}" aria-pressed="${fav}" aria-label="${fav ? "Unstar" : "Star"} ${esc(c.name)}">${fav ? "★" : "☆"}</button></h4>
          ${(c.tags || []).length ? `<div class="tag-row">${c.tags.map((t) => TAGS[t] && `<span class="tag">${TAGS[t].icon}<span> ${TAGS[t].label}</span></span>`).join("")}</div>` : ""}<div class="usual">${esc(c.area || "")} · <b style="color:var(--text)">${n} run${n === 1 ? "" : "s"} this week</b></div>
          <div class="usual">Usually: ${esc(usualText(c))}</div>
          ${c.note ? `<div class="usual" style="color:#8a6400">⚠ ${esc(c.note)}</div>` : ""}
          <div class="links">${c.instagram ? `<a href="https://www.instagram.com/${esc(c.instagram)}/" target="_blank" rel="noopener">@${esc(c.instagram)}</a>` : ""}
            ${c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">Website</a>` : ""}
            <a href="#" data-club="${c.id}">Show runs</a></div>
          ${s ? `<div class="status">${igState}${s.website === "ok" ? ' · <span class="ok">✓ site read</span>' : s.website === "error" ? ' · <span class="warn">site error</span>' : ""}</div>` : ""}
        </div></article>`;
    }).join("")}</div>`;
  el.querySelectorAll("[data-star]").forEach((b) => b.addEventListener("click", () => toggleFav(b.dataset.star)));
  el.querySelectorAll("[data-club]").forEach((a) => a.addEventListener("click", (ev) => {
    ev.preventDefault(); state.clubFilter = a.dataset.club; state.textFilter = "";
    if (state.myOnly && !state.favs.has(a.dataset.club)) state.myOnly = false;
    rerender(); setTab("week");
    const pts = state.events.filter((e) => e.clubId === a.dataset.club && e.place?.lat != null).map((e) => [e.place.lat, e.place.lng]);
    if (pts.length) map.fitBounds(pts, { padding: [80, 80], maxZoom: 14 });
  }));
}

function toggleFav(id) {
  if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
  if (!state.favs.size) state.myOnly = false;
  prefs.save();
  renderClubsTab(); rerender();
}
function setMyOnly(on) {
  if (on && !state.favs.size) {
    setTab("clubs");
    $("#v-clubs").scrollTop = 0;
    flash("Star a few clubs first (tap ☆), then turn on My clubs.");
    return;
  }
  state.myOnly = on;
  prefs.save();
  rerender();
}
function flash(msg) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => t.classList.remove("on"), 3200);
}

// ---------- Add a post: paste a caption or drop a screenshot, OCR it, read it ----------
let addState = { file: null, ocrText: "", found: [] };
function renderAddTab() {
  const el = $("#v-add");
  if (el.dataset.ready) return;
  el.dataset.ready = "1";
  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  el.innerHTML = `<h2>Add a club post</h2>
    <p class="lede">Paste a caption or drop a screenshot of an Instagram post or flyer. TrailTrak reads the text (OCR for images), finds the day, time and meeting spot, and puts the runs on your map.</p>
    <div class="form">
      <label>Club<select id="aClub">${state.clubs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>
      <label>When was it posted?<input type="datetime-local" id="aWhen" value="${nowLocal}" /></label>
      <label>Caption or post text<textarea id="aText" placeholder="e.g. Tues & Thurs 6pm 📍 Balboa Park at 6th & Laurel. All paces!"></textarea></label>
      <label>Screenshot or flyer image <span class="hint">(optional; read with OCR on this device)</span>
        <div class="drop" id="aDrop" tabindex="0">Drop an image here or <u>choose a file</u><input type="file" id="aFile" accept="image/*" hidden /><div id="aPrev"></div></div></label>
      <div class="progress" id="aProg" hidden><i></i></div>
      <div class="btn-row"><button class="btn" id="aRead">Read post</button></div>
      <div id="aOut"></div>
    </div>`;
  const drop = $("#aDrop"), file = $("#aFile");
  drop.addEventListener("click", () => file.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") file.click(); });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); });
  file.addEventListener("change", () => file.files[0] && pickFile(file.files[0]));
  document.addEventListener("paste", (e) => {
    if (state.tab !== "add") return;
    const img = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
    if (img) pickFile(img);
  });
  $("#aRead").addEventListener("click", readPost);
}
function pickFile(f) {
  addState.file = f;
  addState.ocrText = "";
  $("#aPrev").innerHTML = `<img alt="Selected image" src="${URL.createObjectURL(f)}" />`;
}
let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  return tesseractLoading ||= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    s.onload = res; s.onerror = () => rej(new Error("Could not load the OCR library"));
    document.head.appendChild(s);
  });
}
async function readPost() {
  const btn = $("#aRead"), prog = $("#aProg"), out = $("#aOut");
  btn.disabled = true;
  try {
    if (addState.file && !addState.ocrText) {
      prog.hidden = false;
      btn.textContent = "Reading image…";
      await loadTesseract();
      const { data } = await window.Tesseract.recognize(addState.file, "eng", {
        logger: (m) => { if (m.status === "recognizing text") prog.firstElementChild.style.width = Math.round(m.progress * 100) + "%"; },
      });
      addState.ocrText = data.text;
      prog.hidden = true;
    }
    const clubId = $("#aClub").value;
    const club = state.clubById.get(clubId);
    const text = $("#aText").value + "\n" + addState.ocrText;
    const postedAt = new Date($("#aWhen").value || Date.now());
    const homeP = (club.usual || []).map((u) => state.places.find((p) => p.name === u.place)).find(Boolean);
    const found = parsePost({ text, postedAt, today: state.today, matchers: state.matchers, home: homeP ? [homeP.lat, homeP.lng] : null });
    // No place in the post? Use the club's usual spot for that weekday, like the refresh does.
    const usualPlace = (date) => {
      const u = (club.usual || []).find((x) => x.place && x.days.includes(DOW[dowOf(date)]));
      const p = u && state.places.find((x) => x.name === u.place);
      return p ? { name: p.name, lat: p.lat, lng: p.lng, approx: !!p.approx, kind: "place", fromUsual: true } : null;
    };
    addState.found = found.map((e, i) => attachTrails({ ...e, place: e.place || usualPlace(e.date), clubId, id: `local-${clubId}-${e.date}-${Date.now()}-${i}`,
      source: { type: "local", label: "Added by you on this device", postedAt: postedAt.toISOString(), ocr: !!addState.ocrText } }));
    const preview = addState.found;
    out.innerHTML = `${addState.ocrText ? `<details style="margin-bottom:10px"><summary class="hint">Text read from the image</summary><pre style="white-space:pre-wrap;font-size:12px;background:var(--sand);padding:8px;border-radius:8px">${esc(addState.ocrText.trim())}</pre></details>` : ""}
      ${preview.length ? `<h3>Found ${preview.length} run${preview.length > 1 ? "s" : ""} in the next 7 days</h3>
        <ul class="runs found">${preview.map((e) => runRow(e)).join("")}</ul>
        <div class="btn-row" style="margin-top:10px"><button class="btn purple" id="aSave">Add to my map</button><button class="btn alt" id="aCopy">Copy for manual-posts.json</button></div>
        <p class="hint">"Add to my map" saves on this device only. To share with everyone, paste the copied entry into <code>data/manual-posts.json</code>. The next refresh picks it up.</p>`
        : `<p class="no-runs">No dated runs found for the next 7 days. Check that the post names a day (or date), a time, and a place.</p>`}
      ${store.get().length ? `<h3>Runs you added</h3><ul class="runs found">${store.get().map((e) => runRow(attachTrails({ ...e }))).join("")}</ul><div class="btn-row" style="margin-top:8px"><button class="btn alt" id="aClear">Remove runs I added</button></div>` : ""}`;
    $("#aSave")?.addEventListener("click", () => {
      store.set([...store.get(), ...addState.found]);
      refreshAll();
      $("#aSave").textContent = "Added ✓"; $("#aSave").disabled = true;
    });
    $("#aCopy")?.addEventListener("click", async () => {
      const entry = { club: clubId, postedAt: postedAt.toISOString(), text: text.trim() };
      try { await navigator.clipboard.writeText(JSON.stringify(entry, null, 2) + ","); $("#aCopy").textContent = "Copied ✓"; }
      catch { prompt("Copy this entry:", JSON.stringify(entry)); }
    });
    $("#aClear")?.addEventListener("click", () => { store.set([]); refreshAll(); readPost(); });
  } catch (e) {
    out.innerHTML = `<p class="no-runs">Something went wrong: ${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = "Read post"; prog.hidden = true;
  }
}

// ---------- search ----------
function initSearch() {
  const input = $("#q"), box = $("#suggest");
  let items = [], active = -1;
  const show = () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { box.classList.remove("open"); return; }
    const seen = new Set();
    const trails = state.trails.filter((t) => t.name.toLowerCase().includes(q))
      .sort((a, b) => (b.events.length - a.events.length) || (a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q)) || b.miles - a.miles)
      .filter((t) => { const k = t.name + t.terrain; if (seen.has(k) && !t.events.length) return false; seen.add(k); return true; }).slice(0, 8);
    const clubs = state.clubs.filter((c) => (c.name + " " + (c.instagram || "")).toLowerCase().includes(q)).slice(0, 4);
    const places = state.places.filter((p) => [p.name, ...(p.aliases || [])].some((a) => a.toLowerCase().includes(q))).slice(0, 4);
    items = [
      ...clubs.map((c) => ({ type: "club", c, html: `<span class="cdot" style="background:${c.color}"></span>${esc(c.name)}<span class="kind">Club</span>` })),
      ...trails.map((t) => ({ type: "trail", t, html: `<span class="cdot" style="background:${TERRAIN[t.terrain].color};border-radius:3px"></span><span>${esc(t.name)}${nearName(t) ? `<small style="display:block;color:var(--muted);font-size:12px">near ${esc(nearName(t))}</small>` : ""}</span><span class="kind">${TERRAIN[t.terrain].label} · ${t.miles} mi${t.events.length ? ` · ${t.events.length} runs` : ""}</span>` })),
      ...places.map((p) => ({ type: "place", p, html: `📍 ${esc(p.name)}<span class="kind">Place</span>` })),
    ];
    active = -1;
    box.innerHTML = items.length ? items.map((it, i) => `<button role="option" data-i="${i}">${it.html}</button>`).join("") : `<div class="no-runs">No matches</div>`;
    box.classList.add("open");
  };
  const pick = (it) => {
    box.classList.remove("open");
    input.value = it.type === "trail" ? it.t.name : it.type === "club" ? it.c.name : it.p.name;
    if (it.type === "trail") {
      if (state.selected.has(it.t.id)) { fitTrail(it.t.id); setTab("trails"); }
      else toggleTrail(it.t.id, { fit: true, openTab: true });
    }
    if (it.type === "club") document.querySelector(`[data-club="${it.c.id}"]`)?.click();
    if (it.type === "place") map.flyTo([it.p.lat, it.p.lng], 15);
  };
  input.addEventListener("input", show);
  input.addEventListener("focus", show);
  input.addEventListener("keydown", (e) => {
    const btns = [...box.querySelectorAll("button")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length;
      btns.forEach((b, i) => b.classList.toggle("active", i === active));
    } else if (e.key === "Enter" && items.length) { pick(items[Math.max(active, 0)]); }
    else if (e.key === "Escape") box.classList.remove("open");
  });
  box.addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (b) pick(items[+b.dataset.i]); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) box.classList.remove("open"); });
}

// ---------- refresh status ----------
function nextRefresh(from = new Date()) {
  // next 12:00 AM or 12:00 PM in Pacific time
  for (let m = 1; m <= 13 * 60; m++) {
    const t = new Date(Math.ceil(from.getTime() / 6e4) * 6e4 + m * 6e4);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(t);
    if (p === "00:00" || p === "12:00") return t;
  }
  return null;
}
function renderRefresh() {
  const el = $("#refresh"), txt = $("#refreshText");
  const gen = state.schedule?.generatedAt ? new Date(state.schedule.generatedAt) : null;
  const fmt = (d, opts) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", ...opts }).format(d);
  const next = nextRefresh();
  if (!gen) { txt.innerHTML = "Schedule not built yet"; el.classList.add("stale"); return; }
  const ageH = (Date.now() - gen) / 36e5;
  el.classList.toggle("stale", ageH > 13);
  const sameDay = pacificDate(gen) === state.today;
  txt.innerHTML = `Updated <b>${sameDay ? "" : fmt(gen, { weekday: "short" }) + " "}${fmt(gen, { hour: "numeric", minute: "2-digit" })}</b><span class="long"> · next ${next ? fmt(next, { hour: "numeric", minute: "2-digit" }) : "soon"}</span>`;
}

// ---------- wire up ----------
function refreshAll() {
  collectEvents();
  renderDays(); renderTrails(); renderHalos(); renderPins(); renderFilterBar();
  renderTrailsTab(); renderWeekTab(); renderClubsTab(); renderRefresh();
}
function bindControls() {
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("#days").addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]");
    if (b) return setDay(b.dataset.day);
    const t = e.target.closest("[data-tod]");
    if (t) { state.tod = t.dataset.tod; rerender(); }
  });
  $("#fFav").addEventListener("click", () => setMyOnly(!state.myOnly));
  $("#fMore").addEventListener("click", () => toggleFilterPop());
  $("#filterpop").addEventListener("click", (e) => {
    const d = e.target.closest("[data-dist]"), t = e.target.closest("[data-tag]");
    if (d) state.dist = d.dataset.dist;
    else if (t) state.tags.has(t.dataset.tag) ? state.tags.delete(t.dataset.tag) : state.tags.add(t.dataset.tag);
    else if (e.target.closest("#fpReset")) { state.dist = "any"; state.tags.clear(); }
    else if (e.target.closest("#fpDone, #fpClose")) return toggleFilterPop(false);
    else return;
    rerender();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#filterpop").hidden) toggleFilterPop(false); });
  const tog = (id, key) => $(id).addEventListener("click", () => {
    state.terrain[key] = !state.terrain[key];
    $(id).setAttribute("aria-pressed", state.terrain[key]);
    renderTrails(); renderWeekTab();
  });
  tog("#fOff", "off-road");
  tog("#fOn", "on-road");
  $("#fBusy").addEventListener("click", () => {
    state.busyOnly = !state.busyOnly;
    $("#fBusy").setAttribute("aria-pressed", state.busyOnly);
    renderTrails();
  });
  // Re-check the date and the schedule every 10 minutes, so an open tab picks up the 12:00 refresh
  setInterval(async () => {
    state.today = pacificDate();
    try { state.schedule = await getJSON("data/schedule.json"); } catch { /* keep the old one */ }
    refreshAll();
  }, 10 * 60 * 1000);
}

(async function main() {
  initMap();
  try {
    await load();
  } catch (e) {
    $("#v-trails").innerHTML = `<div class="notice"><b>Could not load map data.</b> ${esc(e.message)}. Serve this folder over http (for example <code>npm run serve</code>) instead of opening the file directly.</div>`;
    return;
  }
  prefs.load();
  bindControls();
  initSearch();
  refreshAll();
})();
