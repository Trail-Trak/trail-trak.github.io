// TrailTrak refresh: builds data/schedule.json — every club run in the next 7 days.
//
//   npm run refresh            (GitHub Actions runs this at 12:00 AM and 12:00 PM Pacific)
//
// For each club in data/clubs.json it:
//   1. reads recent Instagram posts (captions) through the Instagram Graph API
//      "Business Discovery" endpoint, when IG_ACCESS_TOKEN and IG_USER_ID are set;
//   2. runs OCR on the post images (flyers, schedule graphics) with tesseract.js;
//   3. reads the club's website text, if it has one;
//   4. reads any posts you pasted into data/manual-posts.json;
//   5. pulls dates, times and meeting spots out of all that text (parser.js), and
//      falls back to the club's usual schedule for days with no fresh post.
//
// Environment:
//   IG_ACCESS_TOKEN   long-lived Meta user access token (instagram_basic + pages_show_list + business_management)
//   IG_USER_ID        the Instagram professional account ID that makes the Business Discovery calls
//   IG_GRAPH_VERSION  optional, default v23.0
//   NO_OCR=1          skip image OCR (faster local runs)
//   ONLY=club-id      refresh just one club (for testing)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildMatchers, parsePost, pacificDate, weekWindow, dowOf, DOW } from "../parser.js";

const IG_TOKEN = process.env.IG_ACCESS_TOKEN || "";
const IG_USER = process.env.IG_USER_ID || "";
const GRAPH = process.env.IG_GRAPH_VERSION || "v23.0";
const GRAPH_BASE = process.env.IG_GRAPH_BASE || "https://graph.facebook.com"; // tests point this at a local stand-in
const USE_OCR = process.env.NO_OCR !== "1";
const ONLY = process.env.ONLY || "";
const LOOKBACK_DAYS = 10;      // posts older than this are ignored
const MAX_IMAGES_PER_POST = 4;
const UA = "TrailTrak/0.1 (San Diego run club schedule)";

const readJSON = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const { clubs } = readJSON("data/clubs.json", { clubs: [] });
const { places } = readJSON("data/places.json", { places: [] });
const trails = readJSON("data/trails.geojson", { features: [] }).features
  .map((f) => ({ id: f.properties.id, name: f.properties.name, center: f.properties.center }));
const manual = readJSON("data/manual-posts.json", { posts: [] }).posts || [];
const ocrCache = readJSON("data/ocr-cache.json", {});

const today = pacificDate();
const window = weekWindow(today);
const matchers = buildMatchers(places, trails);
const placeByName = new Map(places.map((p) => [p.name.toLowerCase(), p]));
const now = new Date();
const fresh = (ts) => now - new Date(ts) < LOOKBACK_DAYS * 864e5;

// ---------- OCR ----------
let worker = null;
async function ocr(id, url) {
  if (!USE_OCR || !url) return "";
  if (ocrCache[id]) return ocrCache[id].text;
  try {
    if (!worker) {
      const { createWorker } = await import("tesseract.js");
      worker = await createWorker("eng");
    }
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { data } = await worker.recognize(buf);
    const text = data.text.replace(/[ \t]+/g, " ").trim();
    ocrCache[id] = { text, at: now.toISOString() };
    return text;
  } catch (e) {
    console.warn(`    OCR failed for ${id}: ${e.message}`);
    return "";
  }
}

// ---------- Instagram (official Graph API, Business Discovery) ----------
async function instagramPosts(handle) {
  const fields = `business_discovery.username(${handle}){username,media.limit(15){id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{id,media_type,media_url,thumbnail_url}}}`;
  const url = `${GRAPH_BASE}/${GRAPH}/${IG_USER}?fields=${encodeURIComponent(fields)}&access_token=${IG_TOKEN}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return (body.business_discovery?.media?.data || []).filter((m) => fresh(m.timestamp));
}

async function postText(m) {
  const imgs = [];
  if (m.media_type === "CAROUSEL_ALBUM") for (const c of m.children?.data || []) imgs.push([c.id, c.media_type === "VIDEO" ? c.thumbnail_url : c.media_url]);
  else imgs.push([m.id, m.media_type === "VIDEO" ? m.thumbnail_url : m.media_url]);
  const ocrTexts = [];
  for (const [id, u] of imgs.slice(0, MAX_IMAGES_PER_POST)) {
    const t = await ocr(id, u);
    if (t) ocrTexts.push(t);
  }
  return { caption: m.caption || "", ocr: ocrTexts.join("\n") };
}

// ---------- club websites ----------
async function websiteText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text())
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim()
    .slice(0, 20000);
}

// ---------- usual schedule ----------
function placeOf(name) {
  if (!name) return null;
  const p = placeByName.get(name.toLowerCase());
  if (!p) { console.warn(`  ! "${name}" is not in places.json`); return { name, lat: null, lng: null, kind: "text" }; }
  return { name: p.name, lat: p.lat, lng: p.lng, approx: !!p.approx, kind: "place" };
}
function usualEvents(club) {
  const out = [];
  for (const u of club.usual || []) for (const date of window) {
    if (!u.days.includes(DOW[dowOf(date)])) continue;
    out.push({ date, time: u.time, when: u.when || null, place: placeOf(u.place), trailIds: [], distance: u.distance || null, tags: u.tags || [],
      cancelled: false, confidence: "usual", source: { type: "usual", label: "Usual schedule from run club guides" } });
  }
  return out;
}

// ---------- main ----------
const events = [];
const status = [];
for (const club of clubs) {
  if (ONLY && club.id !== ONLY) continue;
  console.log(`\n${club.name}`);
  const st = { id: club.id, checked: now.toISOString(), instagram: "skipped", website: "skipped", posts: 0, found: 0, errors: [] };
  const homePlace = (club.usual || []).map((u) => placeOf(u.place)).find((p) => p?.lat);
  const home = homePlace ? [homePlace.lat, homePlace.lng] : null;
  const found = [];
  const read = (text, postedAt, source, strict = false) => {
    const evs = parsePost({ text, postedAt, today, matchers, home, strict });
    for (const e of evs) found.push({ ...e, source });
    return evs.length;
  };

  if (club.instagram && IG_TOKEN && IG_USER) {
    for (const handle of [club.instagram, ...(club.alsoInstagram || [])]) {
      try {
        const posts = await instagramPosts(handle);
        st.instagram = `@${handle}`;
        st.posts += posts.length;
        for (const m of posts) {
          const { caption, ocr: ocrText } = await postText(m);
          const n = read(`${caption}\n${ocrText}`, m.timestamp,
            { type: "instagram", url: m.permalink, postedAt: m.timestamp, label: `Instagram post by @${handle}`, ocr: !!ocrText });
          console.log(`  post ${m.timestamp.slice(0, 10)}: ${n} run(s)${ocrText ? " (incl. image text)" : ""}`);
        }
        break; // main handle worked
      } catch (e) {
        st.errors.push(`@${handle}: ${e.message}`);
        st.instagram = "error";
        console.warn(`  Instagram @${handle}: ${e.message}`);
      }
    }
  } else if (club.instagram) {
    st.instagram = "no token";
  }

  if (club.website) {
    try {
      const n = read(await websiteText(club.website), now, { type: "website", url: club.website, label: "Club website" }, true);
      st.website = "ok";
      console.log(`  website: ${n} run(s)`);
    } catch (e) {
      st.website = "error";
      st.errors.push(`website: ${e.message}`);
    }
  }

  for (const p of manual.filter((p) => p.club === club.id && fresh(p.postedAt || now))) {
    read(p.text, p.postedAt || now, { type: "manual", url: p.url || null, postedAt: p.postedAt, label: "Post added by hand" });
  }

  // Fresh info wins for any date it covers; usual schedule fills the other days.
  const usual = usualEvents(club);
  const coveredDates = new Set(found.map((e) => e.date));
  const merged = [...usual.filter((u) => !coveredDates.has(u.date))];
  const seen = new Set();
  for (const e of found) {
    const key = `${e.date}|${e.time}|${e.place?.name}|${e.cancelled}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // No place in the post? Use the usual spot for that weekday.
    if (!e.place) {
      const u = usual.find((x) => x.date === e.date && (!e.time || x.time === e.time)) || usual.find((x) => x.date === e.date);
      if (u?.place) e.place = { ...u.place, fromUsual: true };
    }
    if (!e.distance) e.distance = usual.find((x) => x.date === e.date)?.distance || null;
    merged.push(e);
  }
  st.found = found.length;
  for (const e of merged) {
    const tags = [...new Set([...(club.tags || []), ...(e.tags || [])])];
    events.push({ ...e, tags, clubId: club.id, id: `${club.id}-${e.date}-${e.time || e.when || "x"}-${events.length}` });
  }
  status.push(st);
}

if (worker) await worker.terminate();

// Keep the OCR cache small: drop entries older than 30 days
for (const [k, v] of Object.entries(ocrCache)) if (now - new Date(v.at) > 30 * 864e5) delete ocrCache[k];

events.sort((a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")));
const out = {
  generatedAt: now.toISOString(),
  today,
  window,
  instagram: IG_TOKEN && IG_USER ? "on" : "off",
  ocr: USE_OCR,
  clubs: status,
  events,
};
if (!ONLY) {
  writeFileSync("data/schedule.json", JSON.stringify(out, null, 1));
  writeFileSync("data/ocr-cache.json", JSON.stringify(ocrCache));
}
const freshCount = events.filter((e) => e.source.type !== "usual").length;
console.log(`\n${events.length} runs in the next 7 days (${freshCount} from posts or websites, ${events.length - freshCount} from usual schedules).`);
if (!IG_TOKEN || !IG_USER) console.log("Instagram reading is off: set IG_ACCESS_TOKEN and IG_USER_ID to turn it on (see README).");
