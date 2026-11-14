// Checks the post reader against realistic captions.  npm test
import { readFileSync } from "node:fs";
import { buildMatchers, parsePost, distanceIn, distanceRange, tagsIn } from "../parser.js";

const places = JSON.parse(readFileSync("data/places.json", "utf8")).places;
// A fixed sample, so the tests don't change when the trail data is rebuilt
const trails = [{ id: "t1", name: "Rose Canyon Trail", center: [32.84, -117.22] }];
const matchers = buildMatchers(places, trails);

// Saturday Nov 14 2026, posted at noon Pacific
const postedAt = "2026-11-14T20:00:00Z";
const today = "2026-11-14";
let pass = 0, fail = 0;
function check(label, text, expect) {
  const ev = parsePost({ text, postedAt, today, matchers });
  const got = ev.map((e) => `${e.date} ${e.time ?? e.when ?? "?"} ${e.place?.name ?? "?"}${e.cancelled ? " CANCELLED" : ""}`);
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `\n   expected ${JSON.stringify(expect)}\n   got      ${JSON.stringify(got)}`}`);
}

check("single run with emoji pin", "Sunday long run 🏃‍♀️ 8:30am\n📍 Fiesta Island\n10 miles, all paces welcome!",
  ["2026-11-15 08:30 Fiesta Island"]);
check("weekly flyer lines", "THIS WEEK\nMON 11/16 6PM BONITA COVE 5K\nWED 11/18 6:15PM Morley Field\nSAT 11/21 7AM Cowles Mountain",
  ["2026-11-16 18:00 Bonita Cove", "2026-11-18 18:15 Morley Field"]);
check("two days, one time and place", "Join us Tues & Thurs at 6pm at Balboa Park at 6th and Laurel!",
  ["2026-11-17 18:00 Balboa Park at 6th & Laurel", "2026-11-19 18:00 Balboa Park at 6th & Laurel"]);
check("tonight", "Tonight! 6-7pm we meet at the Waterfront Park fountains", ["2026-11-14 18:00 Waterfront Park"]);
check("cancellation", "Heads up: Tuesday's run is CANCELLED due to rain. See you Thursday 6pm at Thorn Brewing",
  ["2026-11-17 ? ? CANCELLED", "2026-11-19 18:00 Thorn Brewing North Park"]);
check("recap is not an invite", "What a run this morning at Mission Trails! Thanks everyone 🙌", []);
check("recurring plural", "We run Wednesdays 6pm from Seek Beer, 5K & 10K", ["2026-11-18 18:00 Seek Beer Co."]);
check("trail name", "Saturday trail day: 7am, Rose Canyon Trail out and back", ["2026-11-14 07:00 Rose Canyon Trail"]);
check("ordinary words are not days", "the sun was out and we sat down for coffee at 9am", []);
check("place earlier in the sentence wins over the next sentence", "Beginning March 10, we meet at 6th Avenue & Laurel Street at 6 pm on Tuesday and Thursdays. Free parking in Balboa Park begins at 6 pm.",
  ["2026-11-17 18:00 Balboa Park at 6th & Laurel", "2026-11-19 18:00 Balboa Park at 6th & Laurel"]);
check("old blog dates are ignored", "Sat, 31 Oct 2026 04:00 AM\nSDTC Metro - Fall 2026 Track", []);
check("short times like 10a", "Saturdays at 10a. Rain or shine. South O Brewing", ["2026-11-14 10:00 South O Brewing"]);
check("tomorrow morning", "See you tomorrow morning 6:30 at the Star of India", ["2026-11-15 06:30 Star of India"]);

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `\n   expected ${JSON.stringify(want)}\n   got      ${JSON.stringify(got)}`}`);
}
eq("distance range", distanceIn("easy 3-5 miles, all paces"), "3–5 mi");
eq("distance 5K/10K", distanceIn("choose the 5k or 10K"), "5K / 10K");
eq("distance six-mile", distanceIn("a 6-mile loop"), "6 mi");
eq("no distance in a time", distanceIn("meet at 6:30pm"), null);
eq("range of 5K/10K", distanceRange("5K / 10K").map((x) => +x.toFixed(1)), [3.1, 6.2]);
eq("range of 4 or 6 mi", distanceRange("4 or 6 mi along Sunset Cliffs"), [4, 6]);
eq("range of 3–5 mi", distanceRange("3–5 mi"), [3, 5]);
eq("tags", tagsIn("Trail run then beers at the taproom, dogs welcome! All paces"), ["trail", "beer", "dogs", "social"]);
eq("trailhead is not a trail tag", tagsIn("meet at the trailhead"), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
