// Builds data/trails.geojson from OpenStreetMap: every named trail, path,
// bike path and walking/running route in San Diego County, each marked
// "off-road" (dirt, gravel, sand...) or "on-road" (paved).
//
//   node scripts/fetch-trails.mjs
//
// Run it again whenever you want fresh trail lines. It does not need to run
// on the twice-daily schedule; trails change slowly.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const BBOX = "32.53,-117.60,33.51,-116.08"; // San Diego County (south,west,north,east)
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// The county is asked for in tiles so each request stays small enough for the servers.
const TILES_X = 5, TILES_Y = 5;
const query = (b) => `[out:json][timeout:180];
(
  way["highway"~"^(path|track|bridleway|footway|cycleway)$"]["name"]
     ["access"!~"^(private|no)$"]["footway"!~"^(sidewalk|crossing)$"](${b});
  way["highway"="pedestrian"]["name"~"(Trail|Path|Promenade|Boardwalk|Walk|Bikeway|Loop)",i](${b});
);
out geom tags;`;
function tiles() {
  const [s, w, n, e] = BBOX.split(",").map(Number);
  const out = [];
  for (let i = 0; i < TILES_Y; i++) for (let j = 0; j < TILES_X; j++) {
    const s1 = s + ((n - s) * i) / TILES_Y, n1 = s + ((n - s) * (i + 1)) / TILES_Y;
    const w1 = w + ((e - w) * j) / TILES_X, e1 = w + ((e - w) * (j + 1)) / TILES_X;
    out.push([s1, w1, n1, e1].map((v) => v.toFixed(4)).join(","));
  }
  return out;
}

const PAVED = /^(paved|asphalt|concrete|concrete:plates|concrete:lanes|paving_stones|sett|cobblestone|metal|wood|bricks|chipseal)$/;
const UNPAVED = /^(unpaved|dirt|earth|ground|gravel|fine_gravel|compacted|sand|grass|mud|rock|pebblestone|woodchips|soil)$/;

function terrainOf(tags) {
  const s = (tags.surface || "").toLowerCase();
  if (PAVED.test(s)) return "on-road";
  if (UNPAVED.test(s)) return "off-road";
  if (["path", "track", "bridleway"].includes(tags.highway)) return "off-road";
  return "on-road"; // footway, cycleway, pedestrian, steps default to paved
}

// Douglas-Peucker simplification in degrees (~5 m tolerance)
function simplify(pts, tol = 0.00005) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x1, y1] = pts[a], [x2, y2] = pts[b];
    const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy || 1e-12;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i];
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len));
      const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const r5 = (n) => Math.round(n * 1e5) / 1e5;
const metersOf = (line) => {
  let m = 0;
  for (let i = 1; i < line.length; i++) {
    const [lon1, lat1] = line[i - 1], [lon2, lat2] = line[i];
    const kx = 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    m += Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110540);
  }
  return m;
};

const UA_OSM = "TrailTrak/0.1 (San Diego run club trail map)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function overpass(query) {
  for (let attempt = 0; attempt < 3; attempt++) for (const url of ENDPOINTS) {
    try {
      console.log("Asking", url, "...");
      const res = await fetch(url, {
        method: "POST",
        headers: { "User-Agent": UA_OSM, "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.remark && /timed out|runtime error/i.test(json.remark)) throw new Error(json.remark);
      console.log(`  ${json.elements.length} ways`);
      return json;
    } catch (e) {
      console.warn("  failed:", e.message);
      await sleep(8000 * (attempt + 1));
    }
  }
  throw new Error("Every Overpass server failed. Try again in a few minutes.");
}

const seen = new Map();
const tileList = tiles();
// Each tile is saved as it arrives, so a failed run picks up where it stopped.
const CACHE = "data/.trail-tiles";
mkdirSync(CACHE, { recursive: true });
for (const [i, b] of tileList.entries()) {
  const file = `${CACHE}/${b}.json`;
  let part;
  if (existsSync(file)) part = JSON.parse(readFileSync(file, "utf8"));
  else {
    console.log(`Tile ${i + 1}/${tileList.length} (${b})`);
    part = await overpass(query(b));
    writeFileSync(file, JSON.stringify(part));
    await sleep(2000); // be gentle with the shared servers
  }
  for (const el of part.elements) seen.set(el.id, el);
}
const data = { elements: [...seen.values()] };
console.log("Got", data.elements.length, "ways");

// ---------- run-club hotspots whose paths have no names in OSM ----------
// Paths inside these parks are fetched and labeled "<park> paths".
const PARKS = [
  ["Balboa Park", "32.72,-117.165,32.75,-117.135"],
  ["Fiesta Island", "32.765,-117.23,32.785,-117.205"],   // before Mission Bay Park: the more specific name wins
  ["Mission Bay Park", "32.755,-117.26,32.81,-117.19"],
  ["Lake Murray", "32.77,-117.06,32.80,-117.03"],
  ["Sunset Cliffs Natural Park", "32.71,-117.26,32.73,-117.245"],
  ["Silver Strand State Beach", "32.60,-117.15,32.68,-117.11"],
  ["Double Peak Park", "33.10,-117.20,33.12,-117.17"],
  ["Kate Sessions Park", "32.80,-117.25,32.815,-117.235"],
  ["Lake Poway Recreation Area", "32.995,-117.025,33.015,-117.0"],
  ["Shelter Island", "32.70,-117.24,32.72,-117.22"],
  ["Liberty Station", "32.73,-117.225,32.745,-117.205"],
  ["Lake Miramar", "32.90,-117.11,32.925,-117.08"],
];
const parkQuery = (name, b) => `[out:json][timeout:90];
wr["name"~"^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",i](${b});
map_to_area->.a;
(
  way(area.a)["highway"~"^(path|track|footway|cycleway|bridleway|pedestrian)$"]["footway"!~"^(sidewalk|crossing)$"]["access"!~"^(private|no)$"];
  way["name"~"${name.split(" ").slice(0, 2).join(" ")}",i]["highway"~"^(path|track|footway|cycleway|bridleway)$"](${b});
);
out geom tags;`;
const parkWays = [];
for (const [name, b] of PARKS) {
  const file = `${CACHE}/park-${name.replace(/\W+/g, "-")}.json`;
  let part;
  if (existsSync(file)) part = JSON.parse(readFileSync(file, "utf8"));
  else {
    console.log(`Park: ${name}`);
    try { part = await overpass(parkQuery(name, b)); writeFileSync(file, JSON.stringify(part)); await sleep(2000); }
    catch (e) { console.warn(`  skipped ${name}: ${e.message}`); continue; }
  }
  for (const el of part.elements) if (el.type === "way" && el.geometry && !seen.has(el.id)) { seen.set(el.id, el); parkWays.push({ park: name, el }); }
}

// ---------- official trail layers (fill the gaps where OSM paths have no name) ----------
const UA = "TrailTrak/0.1 (San Diego run club trail map)";
const OFFICIAL = [
  {
    id: "city", label: "City of San Diego Parks & Recreation, Official Park Trails",
    url: "https://webmaps.sandiego.gov/arcgis/rest/services/SDPR/SDPR_Public/MapServer/1",
    where: "Status IS NULL OR Status <> 'Proposed'", fields: "OBJECTID,Trail_Name,USE_TYPE,Status",
    map: (a) => {
      const name = (a.Trail_Name || "").replace(/\s+/g, " ").trim();
      if (!name || /private|service road/i.test(name)) return null;
      return { name, terrain: /bike path|paved|promenade|boardwalk/i.test(name) ? "on-road" : "off-road", surface: null, kind: (a.USE_TYPE || "trail").toLowerCase() };
    },
  },
  {
    id: "county", label: "County of San Diego Parks & Recreation trails (via SANDAG)",
    url: "https://geo.sandag.org/server/rest/services/Hosted/DPR_Trail/FeatureServer/0",
    where: "1=1", fields: "objectid,trail_name,park_name,trail_surface,category",
    map: (a) => {
      const name = (a.trail_name || "").trim() || (a.park_name ? `${a.park_name.trim()} trails` : "");
      if (!name) return null;
      const paved = /asphalt|concrete|paved/i.test(a.trail_surface || "") || /paved/i.test(a.category || "");
      return { name, terrain: paved ? "on-road" : "off-road", surface: a.trail_surface || null, kind: "county park trail", park: a.park_name || null };
    },
  },
];
async function arcgis(src) {
  const get = async (params) => {
    const res = await fetch(`${src.url}/query?${new URLSearchParams({ f: "json", ...params })}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
    const j = await res.json();
    if (j.error) throw new Error(`${src.id}: ${j.error.message}`);
    return j;
  };
  const { objectIds = [] } = await get({ where: src.where, returnIdsOnly: "true" });
  const feats = [];
  for (let i = 0; i < objectIds.length; i += 400) {
    const j = await get({ objectIds: objectIds.slice(i, i + 400).join(","), outFields: src.fields, returnGeometry: "true", outSR: "4326" });
    feats.push(...j.features);
  }
  console.log(`${src.id}: ${feats.length} official trail segments`);
  return feats;
}

// Densified grid of OSM trail points, to spot official segments that repeat an OSM trail
const CELL_LAT = 0.0003, CELL_LON = 0.00036; // about 33 m
const cellKey = (lon, lat) => `${Math.floor(lat / CELL_LAT)},${Math.floor(lon / CELL_LON)}`;
function densify(line, stepM = 20) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [x1, y1] = line[i - 1], [x2, y2] = line[i];
    const m = metersOf([line[i - 1], line[i]]);
    const n = Math.max(1, Math.ceil(m / stepM));
    for (let k = 1; k <= n; k++) out.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
  }
  return out;
}

// Group ways that share a name and terrain into one trail.
const groups = new Map();
const addLine = (source, name, terrain, line, extra = {}) => {
  const key = source + "|" + name.toLowerCase() + "|" + terrain;
  if (!groups.has(key)) groups.set(key, { source, name, terrain, lines: [], surfaces: new Set(), kinds: new Set(), park: extra.park || null });
  const g = groups.get(key);
  g.lines.push(line);
  if (extra.surface) g.surfaces.add(extra.surface);
  if (extra.kind) g.kinds.add(extra.kind);
};
const osmCells = new Set();
for (const el of data.elements) {
  if (el.type !== "way" || !el.geometry) continue;
  const raw = el.geometry.map((p) => [p.lon, p.lat]);
  for (const [x, y] of densify(raw)) osmCells.add(cellKey(x, y));
  addLine("osm", el.tags.name.trim(), terrainOf(el.tags), simplify(raw.map(([x, y]) => [r5(x), r5(y)])), { surface: el.tags.surface, kind: el.tags.highway });
}
// Unnamed paths in hotspot parks: one trail network per park and terrain
for (const { park, el } of parkWays) {
  const raw = el.geometry.map((p) => [p.lon, p.lat]);
  for (const [x, y] of densify(raw)) osmCells.add(cellKey(x, y));
  const name = el.tags.name?.trim() || `${park} paths`;
  addLine("osm", name, terrainOf(el.tags), simplify(raw.map(([x, y]) => [r5(x), r5(y)])), { surface: el.tags.surface, kind: el.tags.highway, park });
}
const sourcesUsed = ["OpenStreetMap contributors (ODbL), via Overpass API"];
for (const src of OFFICIAL) {
  let feats;
  try { feats = await arcgis(src); } catch (e) { console.warn(`  skipped ${src.id}: ${e.message}`); continue; }
  sourcesUsed.push(src.label);
  let kept = 0, dupes = 0;
  for (const f of feats) {
    const m = src.map(f.attributes);
    if (!m || !f.geometry?.paths) continue;
    for (const path of f.geometry.paths) {
      if (path.length < 2) continue;
      const dense = densify(path);
      const near = (x, y) => {
        const [r, c] = cellKey(x, y).split(",").map(Number);
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (osmCells.has(`${r + dr},${c + dc}`)) return true;
        return false;
      };
      const covered = dense.filter(([x, y]) => near(x, y)).length / dense.length;
      if (covered > 0.6) { dupes++; continue; } // already on the map from OSM
      addLine(src.id, m.name, m.terrain, simplify(path.map(([x, y]) => [r5(x), r5(y)])), m);
      kept++;
    }
  }
  console.log(`  ${src.id}: kept ${kept} segments, skipped ${dupes} already mapped by OSM`);
}

// Split far-apart same-name groups (e.g. two different "Canyon Trail"s) by clustering on ~3 km.
function clusters(lines) {
  const out = [];
  for (const line of lines) {
    const c = line[Math.floor(line.length / 2)];
    let hit = out.find((cl) => cl.pts.some((p) => Math.hypot(p[0] - c[0], (p[1] - c[1])) < 0.03));
    if (!hit) out.push((hit = { pts: [], lines: [] }));
    hit.pts.push(c);
    hit.lines.push(line);
  }
  return out;
}

// Paid attractions whose walkways aren't public trails
const EXCLUDE = [
  ["San Diego Zoo", 32.7325, -117.1575, 32.7410, -117.1460],
  ["Safari Park", 33.0930, -117.0060, 33.1040, -116.9880],
  ["SeaWorld", 32.7610, -117.2320, 32.7700, -117.2180],
  ["LEGOLAND", 33.1210, -117.3170, 33.1300, -117.3050],
];
const excluded = (line) => {
  const [x, y] = line[Math.floor(line.length / 2)];
  return EXCLUDE.some(([, s, w, n, e]) => y >= s && y <= n && x >= w && x <= e);
};
for (const g of groups.values()) g.lines = g.lines.filter((l) => !excluded(l));

const features = [];
let n = 0;
for (const g of groups.values()) {
  for (const cl of clusters(g.lines)) {
    const meters = cl.lines.reduce((s, l) => s + metersOf(l), 0);
    if (meters < 150) continue; // skip tiny connector bits
    const all = cl.lines.flat();
    const lon = all.reduce((s, p) => s + p[0], 0) / all.length;
    const lat = all.reduce((s, p) => s + p[1], 0) / all.length;
    features.push({
      type: "Feature",
      id: "t" + (++n),
      properties: {
        id: "t" + n,
        name: g.name,
        terrain: g.terrain,
        miles: Math.round((meters / 1609.34) * 10) / 10,
        surface: [...g.surfaces].join(", ") || null,
        kind: [...g.kinds].join(", "),
        source: g.source,
        park: g.park,
        center: [r5(lat), r5(lon)],
      },
      geometry: { type: "MultiLineString", coordinates: cl.lines },
    });
  }
}

features.sort((a, b) => b.properties.miles - a.properties.miles);
mkdirSync("data", { recursive: true });
const out = {
  type: "FeatureCollection",
  sources: sourcesUsed,
  fetched: new Date().toISOString(),
  features,
};
writeFileSync("data/trails.geojson", JSON.stringify(out));
const off = features.filter((f) => f.properties.terrain === "off-road").length;
const bySrc = Object.entries(features.reduce((a, f) => ((a[f.properties.source] = (a[f.properties.source] || 0) + 1), a), {})).map(([k, v]) => `${v} ${k}`).join(", ");
console.log(`Wrote ${features.length} trails (${off} off-road, ${features.length - off} on-road; ${bySrc}) to data/trails.geojson`);
