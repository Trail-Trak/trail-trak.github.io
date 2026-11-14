// TrailTrak post reader.
// Turns the text of a run club post (an Instagram caption, a club web page, or
// the words OCR pulled off a flyer image) into dated runs:
//   { date: "2026-11-18", time: "18:00", place: {...}, trailIds: [...], cancelled, confidence }
// Shared by the twice-daily refresh (Node) and the "Add a post" tab (browser).

const TZ = "America/Los_Angeles";
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------- dates in Pacific time, as "YYYY-MM-DD" ----------
export function pacificDate(when = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(when)).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}
const toUTC = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
export const addDays = (iso, n) => new Date(toUTC(iso) + n * 864e5).toISOString().slice(0, 10);
export const dowOf = (iso) => new Date(toUTC(iso)).getUTCDay();
export const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 864e5);
/** The 7 dates TrailTrak shows: today and the next 6 days. */
export const weekWindow = (today) => Array.from({ length: 7 }, (_, i) => addDays(today, i));

// ---------- words ----------
const DAY_WORDS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, weds: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DAY_RE = new RegExp(`(?<![a-z])(${Object.keys(DAY_WORDS).sort((a, b) => b.length - a.length).join("|")})(s)?(?![a-z])\\.?`, "gi");
const MDY_RE = /(?<![\d/])(1[0-2]|0?[1-9])\/([12]\d|3[01]|0?[1-9])(?:\/(\d{2,4}))?(?![\d/])/g;
const MONTH_RE = new RegExp(`(?<![a-z])(${Object.keys(MONTHS).join("|")})[a-z]*\\.?\\s+([12]\\d|3[01]|0?[1-9])(?:st|nd|rd|th)?(?![\\d:])(?:,?\\s+(20\\d\\d))?`, "gi");
// "31 Oct 2026", "9 November"
const DMY_RE = new RegExp(`(?<![\\d])([12]\\d|3[01]|0?[1-9])(?:st|nd|rd|th)?\\s+(${Object.keys(MONTHS).join("|")})[a-z]*\\.?(?:,?\\s+(20\\d\\d))?(?![a-z])`, "gi");
const REL_RE = /(?<![a-z])(today|tonight|this morning|this evening|tomorrow(?: morning| night| evening)?)(?![a-z])/gi;
const RANGE_RE = /(?<![\d:])(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(?:-|–|—|to)\s*(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?\s?m\.?(?![a-z])/gi;
const TIME_RE = /(?<![\d:/])(1[0-2]|0?[1-9])(?::([0-5]\d))?(?:\s*([ap])\.?\s?m\.?|([ap]))(?![a-z])/gi;
const BARE_TIME_RE = /(?<![\d:/$])(1[0-2]|0?[1-9]):([0-5]\d)(?!\s*(?:\/|min|mi\b|pace|\d))/gi;
const NOON_RE = /(?<![a-z])(noon|sunrise|sunset)(?![a-z])/gi;
const CANCEL_RE = /cancel+ed|cancel+ing|\bno run\b|not running|postponed|rain(?:ed)? out|no club run/i;
const NOT_A_RUN_RE = /\b(yoga|strength (?:training|class)|conditioning|wellness walk|clinic|webinar|class|workshop|volunteer|packet pick-?up)\b/i;
const RECAP_RE = /\b(thank(s| you)|crushed|recap|what a (run|morning|night)|shout ?out|killed it|great turnout)\b/i;
const EXPLICIT_PLACE_RE = /(?:📍|📌|location\s*[:\-]|where\s*[:\-]|meet(?:ing)?(?: up)?\s+(?:at|@)|start(?:ing)?\s+(?:at|from)|meet\s*[:\-])\s*([^\n.!|•·]{3,70})/gi;

// Run-type tags, read from post text and set per club in clubs.json
export const TAGS = {
  trail: { label: "Trail", icon: "🌵", re: /\btrails?\b(?!\s*head)|singletrack|single track|\bdirt\b/i },
  workout: { label: "Workout", icon: "⏱️", re: /\btrack\b|interval|repeats|speed ?work|tempo|fartlek|\bworkout/i },
  women: { label: "Women", icon: "💜", re: /\b(women|womens|women's|ladies|girls|female|womxn|mujeres)\b/i },
  lgbtq: { label: "LGBTQ+", icon: "🏳️‍🌈", re: /lgbt|queer|\bpride\b|\blez\b|\bgay\b|\btrans\b/i },
  beer: { label: "Beer after", icon: "🍺", re: /\bbeers?\b|brewery|brewing|\bpints?\b|taproom|\bales\b/i },
  coffee: { label: "Coffee after", icon: "☕", re: /coffee|latte|espresso|matcha|\bcaf[eé]\b/i },
  dogs: { label: "Dogs welcome", icon: "🐕", re: /\bdogs?\b|\bpups?\b|pupp(y|ies)|doggo/i },
  walkers: { label: "Walkers welcome", icon: "🚶", re: /\bwalk(ers|ing)?\b|walk\/run/i },
  long: { label: "Long run", icon: "🛣️", re: /long run|half marathon|\bmarathon|\b(1\d|[2-9]\d)\s*(mi|miles)\b/i },
  social: { label: "Social", icon: "🎉", re: /\bsocial\b|all paces|all levels|beginners?|no one left behind|newbies/i },
};
export const tagsIn = (text) => Object.entries(TAGS).filter(([, t]) => t.re.test(text || "")).map(([k]) => k);

// "3-5 miles", "6 mi", "5K", "half marathon" -> a short label like "3–5 mi"
export function distanceIn(text) {
  text = text || "";
  let m = text.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(mi\b|miles?|mile|k\b|km)/i);
  if (m) return `${m[1]}–${m[2]} ${/k/i.test(m[3]) ? "K" : "mi"}`.replace(" K", "K");
  const ks = [...text.matchAll(/(?<![\d.])(\d{1,2}(?:\.\d)?)\s*k(?![a-z])/gi)].map((x) => x[1] + "K");
  m = text.match(/(?<![\d.])(\d{1,2}(?:\.\d+)?)[\s-]*(?:mi\b|miles?|mile)/i);
  if (m) return ks.length ? `${m[1]} mi / ${ks.join(" / ")}` : `${m[1]} mi`;
  if (ks.length) return [...new Set(ks)].join(" / ");
  if (/half marathon/i.test(text)) return "13.1 mi";
  return null;
}

/** "3–5 mi", "5K / 10K", "long run" -> [min, max] miles, or null when unknown */
export function distanceRange(label) {
  if (!label) return null;
  const nums = [...label.matchAll(/(\d+(?:\.\d+)?)\s*(k\b|km|mi\b|miles?|mile)?/gi)].map((m) => ({ n: +m[1], u: m[2] || "" }));
  for (let i = nums.length - 1; i >= 0; i--) if (!nums[i].u) nums[i].u = nums[i + 1]?.u || "mi";
  const miles = nums.map(({ n, u }) => (/k/i.test(u) ? n * 0.621 : n)).filter((n) => n > 0 && n < 120);
  if (miles.length) return [Math.min(...miles), Math.max(...miles)];
  if (/long/i.test(label)) return [8, 26.2];
  return null;
}

const GENERIC_TRAILS = new Set(["trail", "bike path", "main trail", "loop trail", "nature trail", "service road", "fire road",
  "the loop", "loop", "walking path", "access road", "connector trail", "canyon trail", "ridge trail", "creek trail", "river trail",
  "beach trail", "lake trail", "park trail", "perimeter trail", "multi-use trail", "bikeway", "boardwalk", "promenade", "fitness trail"]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Precompute what to look for. places: places.json list. trails: [{id, name, center:[lat,lng]}] */
export function buildMatchers(places = [], trails = []) {
  const aliases = [];
  for (const p of places) for (const a of new Set([p.name, ...(p.aliases || [])].map(norm))) {
    aliases.push({ re: new RegExp(`(?<![a-z0-9])${escapeRe(a)}(?![a-z0-9])`, "g"), place: p, len: a.length });
  }
  aliases.sort((a, b) => b.len - a.len);
  const trailNames = new Map();
  for (const t of trails) {
    const n = norm(t.name).trim();
    if (n.length < 8 || GENERIC_TRAILS.has(n)) continue;
    if (!trailNames.has(n)) trailNames.set(n, []);
    trailNames.get(n).push(t);
  }
  return { aliases, trailNames };
}

function km(a, b) {
  const kx = 111.32 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
  return Math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * 110.54);
}

function findMentions(text, postDate, matchers) {
  const low = norm(text);
  const days = [], times = [], places = [];

  for (const m of text.matchAll(DAY_RE)) {
    const word = m[1];
    const isAbbrev = word.length <= 4;
    // "sun", "sat", "wed" are also ordinary words; only trust short forms when capitalized
    if (isAbbrev && word[0] !== word[0].toUpperCase()) continue;
    if (/^sun$/i.test(word) && /^(sun)\s+(is|was|out|set|rise|shine|came)/i.test(text.slice(m.index, m.index + 12))) continue;
    days.push({ at: m.index, end: m.index + m[0].length, dow: DAY_WORDS[word.toLowerCase()], recurring: !!m[2] });
  }
  const year = Number(postDate.slice(0, 4));
  const pushDate = (at, end, mo, d, y) => {
    let yy = y ? (y < 100 ? 2000 + y : y) : year;
    let iso = `${yy}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!y && daysBetween(postDate, iso) < -60) iso = `${yy + 1}${iso.slice(4)}`; // Dec post about Jan
    days.push({ at, end, date: iso });
  };
  for (const m of text.matchAll(MDY_RE)) pushDate(m.index, m.index + m[0].length, +m[1], +m[2], m[3] ? +m[3] : 0);
  const monthNo = (w) => MONTHS[w.toLowerCase().slice(0, 3)];
  for (const m of text.matchAll(MONTH_RE)) pushDate(m.index, m.index + m[0].length, monthNo(m[1]), +m[2], m[3] ? +m[3] : 0);
  for (const m of text.matchAll(DMY_RE)) pushDate(m.index, m.index + m[0].length, monthNo(m[2]), +m[1], m[3] ? +m[3] : 0);
  for (const m of text.matchAll(REL_RE)) {
    const w = m[1].toLowerCase();
    days.push({ at: m.index, end: m.index + m[0].length, date: addDays(postDate, w.startsWith("tomorrow") ? 1 : 0), relative: true,
      when: /night|evening|tonight/.test(w) ? "evening" : /morning/.test(w) ? "morning" : null });
  }

  const taken = [];
  const hhmm = (h, mi, ap) => { h = +h % 12 + (ap.toLowerCase() === "p" ? 12 : 0); return `${String(h).padStart(2, "0")}:${mi || "00"}`; };
  for (const m of text.matchAll(RANGE_RE)) {
    // "6-7pm": the start takes the end's am/pm unless that would put the start after the end
    let ap = m[5];
    if (ap.toLowerCase() === "p" && +m[1] % 12 > +m[3] % 12) ap = "a";
    times.push({ at: m.index, time: hhmm(m[1], m[2], ap) });
    taken.push([m.index, m.index + m[0].length]);
  }
  const free = (i) => !taken.some(([a, b]) => i >= a && i < b);
  for (const m of text.matchAll(TIME_RE)) if (free(m.index)) { times.push({ at: m.index, time: hhmm(m[1], m[2], m[3] || m[4]) }); taken.push([m.index, m.index + m[0].length]); }
  const anyPm = /\d\s*p\.?\s?m/i.test(text), anyAm = /\d\s*a\.?\s?m/i.test(text);
  for (const m of text.matchAll(BARE_TIME_RE)) if (free(m.index)) {
    const h = +m[1];
    // No am/pm written: runs before 5 are afternoon; otherwise follow the rest of the post, else guess
    const ap = h === 12 || h <= 4 ? "p" : anyPm && !anyAm ? "p" : anyAm && !anyPm ? "a" : /morning|sunrise|coffee/i.test(text) ? "a" : "p";
    times.push({ at: m.index, time: hhmm(m[1], m[2], ap), guessed: true });
  }
  for (const m of text.matchAll(NOON_RE)) {
    const w = m[1].toLowerCase();
    times.push({ at: m.index, time: w === "noon" ? "12:00" : null, when: w === "noon" ? null : w });
  }

  // Collect every place and trail name, then keep the longest where two overlap
  // ("rose canyon trail" beats "rose canyon").
  const cands = [];
  for (const a of matchers.aliases) for (const m of low.matchAll(a.re)) cands.push({ at: m.index, end: m.index + a.len, place: a.place, kind: "place" });
  for (const [name, list] of matchers.trailNames) {
    for (let i = low.indexOf(name); i !== -1; i = low.indexOf(name, i + name.length)) {
      const before = low[i - 1], after = low[i + name.length];
      if (/[a-z0-9]/.test(before || "") || /[a-z0-9]/.test(after || "")) continue;
      cands.push({ at: i, end: i + name.length, trails: list, kind: "trail" });
    }
  }
  cands.sort((a, b) => (b.end - b.at) - (a.end - a.at));
  for (const c of cands) if (!places.some((p) => c.at < p.end && c.end > p.at)) places.push(c);
  if (!places.length) {
    for (const m of text.matchAll(EXPLICIT_PLACE_RE)) {
      const raw = m[1].replace(/\s+(at|@)\s+\d.*$/i, "").replace(/[\s,;:–-]+$/, "").trim();
      if (raw && (/\s/.test(raw) || !/^@?[a-z0-9_.]+$/i.test(raw))) places.push({ at: m.index, end: m.index + m[0].length, text: raw, kind: "text" });
    }
  }
  days.sort((a, b) => a.at - b.at);
  times.sort((a, b) => a.at - b.at);
  places.sort((a, b) => a.at - b.at);
  return { days, times, places };
}

function resolvePlace(p, home) {
  if (!p) return null;
  if (p.kind === "place") return { name: p.place.name, lat: p.place.lat, lng: p.place.lng, approx: !!p.place.approx, kind: "place" };
  if (p.kind === "trail") {
    const best = home ? [...p.trails].sort((a, b) => km(a.center, home) - km(b.center, home))[0] : p.trails[0];
    return { name: best.name, lat: best.center[0], lng: best.center[1], approx: true, kind: "trail", trailId: best.id };
  }
  return { name: p.text, lat: null, lng: null, kind: "text" };
}

/**
 * Read one post.
 * @param {object} o
 * @param {string} o.text        caption + OCR text
 * @param {string|Date} o.postedAt when it was posted (defaults to now)
 * @param {string} o.today       "YYYY-MM-DD" in Pacific time (defaults to today)
 * @param {object} o.matchers    from buildMatchers()
 * @param {[number,number]} [o.home] club's usual area, to pick between same-named trails
 */
export function parsePost({ text, postedAt = new Date(), today = pacificDate(), matchers, home = null, strict = false }) {
  // strict (for long web pages): a run needs its own time; nothing is borrowed from elsewhere on the page
  text = (text || "").replace(/\r/g, "");
  const postDate = pacificDate(postedAt);
  const window = new Set(weekWindow(today));
  const { days, times, places } = findMentions(text, postDate, matchers);
  if (!days.length) return [];
  const recap = RECAP_RE.test(text);

  // Group day words that sit right next to each other ("Tues & Thurs", "MON 11/17")
  const groups = [];
  for (const d of days) {
    const g = groups[groups.length - 1];
    if (g && /^[\s,&/+|·•-]*(and|or)?[\s,&/+|·•-]*$/i.test(text.slice(g.end, d.at))) { g.days.push(d); g.end = Math.max(g.end, d.end); }
    else groups.push({ at: d.at, end: d.end, days: [d] });
  }

  const distinct = (arr, key) => [...new Map(arr.map((x) => [key(x), x])).values()];
  const onlyTime = distinct(times, (t) => t.time + t.when);
  const onlyPlace = distinct(places, (p) => p.place?.name || p.text || p.trails?.[0].name);
  // Where the sentence holding a day word starts, so "Tuesday is cancelled. See you Thursday" stays two thoughts
  const sentenceStart = (i) => Math.max(...["\n", ". ", "! ", "? "].map((c) => { const k = text.lastIndexOf(c, i - 1); return k === -1 ? 0 : k + c.length; }));
  const longest = (list) => list.sort((a, b) => (b.end - b.at) - (a.end - a.at))[0];

  const events = [];
  groups.forEach((g, gi) => {
    const segEnd = gi + 1 < groups.length ? groups[gi + 1].at : text.length;
    const segStart = Math.max(sentenceStart(g.at), gi > 0 ? groups[gi - 1].end : 0);
    const inSeg = (x) => x.at >= g.end && x.at < segEnd;
    const before = (x) => x.at >= segStart && x.at < g.at;
    const segText = text.slice(segStart, segEnd);
    const cancelled = CANCEL_RE.test(segText) || (groups.length === 1 && CANCEL_RE.test(text));
    // A cancelled run keeps only what its own sentence says
    const t = times.find(inSeg) || [...times].reverse().find(before) || (!strict && !cancelled && onlyTime.length === 1 ? onlyTime[0] : null);
    if (strict && !t) return;
    if (NOT_A_RUN_RE.test(segText) && !/\brun\b/i.test(segText)) return;
    const segPlaces = places.filter(inSeg);
    // Prefer a spot right after the day, then one earlier in the same sentence, then anything later
    const sentenceEnd = Math.min(...["\n", ". ", "! ", "? "].map((c) => { const k = text.indexOf(c, g.end - 1); return k === -1 ? text.length : k; }));
    const nearAfter = segPlaces.filter((x) => x.at - g.end < 60 && x.at < sentenceEnd);
    const p = (nearAfter.length ? longest(nearAfter) : null)
      || [...places].reverse().find(before)
      || (segPlaces.length ? segPlaces[0] : null)
      || (!strict && !cancelled && onlyPlace.length === 1 ? onlyPlace[0] : null);

    // Which calendar dates this group means
    let dates = [];
    const explicit = g.days.filter((d) => d.date);
    if (explicit.length) dates = explicit.map((d) => d.date);
    else for (const d of g.days) {
      if (d.recurring || /\bevery\b|weekly/i.test(segText + text.slice(segStart, g.at))) {
        dates.push(...weekWindow(today).filter((iso) => dowOf(iso) === d.dow));
      } else {
        // next one on or after the post date
        let iso = postDate;
        while (dowOf(iso) !== d.dow) iso = addDays(iso, 1);
        dates.push(iso);
      }
    }
    const relativeOnly = g.days.every((d) => d.relative);
    if (relativeOnly && recap && !t) return; // "great run this morning!" is a recap, not an invite

    const place = resolvePlace(p, home);
    const trailIds = places.filter((x) => (x.at >= segStart && x.at < segEnd) && x.kind === "trail")
      .map((x) => resolvePlace(x, home).trailId);
    if (place?.trailId && !trailIds.includes(place.trailId)) trailIds.unshift(place.trailId);

    for (const date of new Set(dates)) {
      if (!window.has(date)) continue;
      if (!t && !p && !cancelled) continue; // a bare weekday mention is not a run
      events.push({
        date,
        time: t?.time || null,
        when: t?.when || g.days.find((d) => d.when)?.when || null,
        timeGuessed: !!t?.guessed,
        place,
        trailIds,
        cancelled,
        confidence: (t ? 1 : 0) + (p ? 1 : 0) + (explicit.length ? 1 : 0) >= 2 ? "high" : "medium",
        distance: distanceIn(segText),
        tags: tagsIn(segText),
        snippet: segText.trim().slice(0, 160),
      });
    }
  });
  return events;
}
