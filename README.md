# TrailTrak

Live site: https://trail-trak.github.io/ · Repo: https://github.com/Trail-Trak/trail-trak.github.io

San Diego's run clubs on one map. TrailTrak shows every named trail, path and
running route in San Diego County, colored by terrain:

- **Off-road** (canyon brown): dirt, gravel, sand, singletrack, fire roads
- **On-road** (sky blue): paved paths, bikeways, boardwalks, promenades

Tap trails to highlight them. The **Trails** tab then lists which run clubs meet
on or near them this week, and when. **This week** lists every club run by day,
**Clubs** shows each club and how its last refresh went, and **Add a post** reads
a pasted caption or a screenshot (with OCR) and puts the runs on your map.

Each run shows its distance and run-type tags: 🌵 trail, ⏱️ workout, 💜 women,
🏳️‍🌈 LGBTQ+, 🍺 beer after, ☕ coffee after, 🐕 dogs welcome, 🚶 walkers welcome,
🛣️ long run and 🎉 social. Tags come from each club's profile in
`clubs.json` and from words in their posts.

On the map you can:
- star clubs (☆ on the Clubs tab) and turn on **★ My clubs** to see only
  those clubs; favorites are saved on the device, with no account needed;
- pick **☀️ AM / 🌙 PM** next to the day picker;
- open **Filters** to filter by distance (up to 5K, 3–6 mi, 6+ mi) and run
  type.

The map pins, day counts, Trails tab and This week list all use the same
filters.

It is a static site with no build step. Run it locally:

```bash
npm install
npm run serve      # then open http://localhost:8642
```

## How schedules stay fresh

`scripts/refresh.mjs` rebuilds `data/schedule.json` (every run in the next 7
days). A GitHub Action (`.github/workflows/refresh.yml`) runs it every day at
**12:00 AM and 12:00 PM Pacific**, adjusting for daylight time, and commits the
result. An open TrailTrak tab re-checks every 10 minutes and picks up the new
schedule on its own.

For each club in `data/clubs.json` the refresh:

1. reads the club's recent Instagram posts (last 10 days) through the official
   Instagram Graph API, if a token is set (see below);
2. runs **OCR** (tesseract.js) on the post images: flyers, weekly schedule
   graphics, carousel slides;
3. reads the club's website, if it lists one;
4. reads posts you pasted into `data/manual-posts.json`;
5. pulls out days, dates, times, meeting spots, trail names and cancellations
   (`parser.js`), then fills in any day without a fresh post from the club's
   usual schedule.

Each run in the app is labeled with where it came from: Instagram, club site,
added post, or usual schedule.

Run it yourself any time:

```bash
npm run refresh             # all clubs
ONLY=pb-run-club npm run refresh   # one club, prints what it found, writes nothing
NO_OCR=1 npm run refresh    # skip image reading
npm test                    # post-reader checks
```

## Turning on Instagram reading

Instagram doesn't allow scraping, so TrailTrak uses Meta's official
**Business Discovery** API. With your own Instagram professional account, it can
read the public posts of other Business or Creator accounts. Most run clubs use
one of those account types. Personal accounts can't be read; add those clubs'
posts by hand in **Add a post**.

1. Make your Instagram account a Business or Creator account and link it to a
   Facebook Page.
2. At developers.facebook.com, create an app (type Business) and add the
   Instagram product ("Instagram API with Facebook Login").
3. Create a user access token with `instagram_basic`, `pages_show_list`,
   `pages_read_engagement` and `business_management`, then exchange it for a
   long-lived token. Long-lived user tokens expire after about 60 days. A
   System User token from Meta Business Settings doesn't expire.
4. Find your Instagram user ID: `GET /me/accounts`, then
   `GET /{page-id}?fields=instagram_business_account`.
5. In the GitHub repo go to Settings → Secrets and variables → Actions and add
   `IG_ACCESS_TOKEN` and `IG_USER_ID`.

Until then the app still works from club websites, added posts and usual
schedules. The Clubs tab says Instagram is off.

## Data files

| File | What it is | Edit it? |
| --- | --- | --- |
| `data/clubs.json` | Clubs, Instagram handles, websites, usual weekly runs | Yes |
| `data/places.json` | Meeting spots the reader recognizes (names, aliases, coordinates) | Yes |
| `data/manual-posts.json` | Posts pasted by hand (the app's "Copy" button makes the entry) | Yes |
| `data/trails.geojson` | Trails (OSM + City + County) with terrain | Rebuild with `npm run trails` |
| `data/schedule.json` | This week's runs | Written by the refresh |
| `data/ocr-cache.json` | Text already read from images, so they aren't OCR'd twice | Written by the refresh |

Usual schedules come from club websites and public run-club lists (San Diego
Running Co, SD Ultra Running Friends, Sweatpals, In Motion Events,
LocallyWell). Instagram handles were checked against the links those pages use. The guides disagree on some times and
places; `note` in `clubs.json` flags those. Coordinates marked `approx` in
`places.json` are estimates. Check them on the map and fix any that are off.

## Trails and terrain

`npm run trails` builds `data/trails.geojson` from three sources:

1. **OpenStreetMap**: every *named* path, track, bridleway, footway and
   cycleway in San Diego County, plus the unnamed paths inside run-club
   hotspots that OSM leaves unnamed (Balboa Park, Mission Bay, Fiesta Island,
   Lake Murray, Sunset Cliffs, Silver Strand and others, listed in `PARKS`).
2. **City of San Diego Parks & Recreation "Official Park Trails"**: Mission
   Trails, Los Peñasquitos, Tecolote, Rose Canyon, Chollas Lake, Black Mountain
   and more.
3. **County of San Diego Parks & Recreation trails** (hosted by SANDAG):
   county preserves and parks, with a surface field.

Where an official trail repeats one already in OSM, it's added only once.
Walkways inside paid attractions (the Zoo, Safari Park, SeaWorld, LEGOLAND)
are left out.

**Terrain:**
- **OSM** uses the `surface` tag. With no surface tag, paths, tracks and
  bridleways count as off-road, and footways and cycleways count as on-road.
- **County trails** marked Asphalt, Concrete or Paved count as on-road. DG,
  Natural and Trail count as off-road.
- **City park trails** count as off-road.

The public Overpass server is often busy, so downloaded OSM tiles are cached
in `data/.trail-tiles/`. A run that stops partway picks up where it left off.

Trail data © OpenStreetMap contributors (ODbL), City of San Diego, County of
San Diego. Base map © Esri, HERE, Garmin, OpenStreetMap contributors.

## Hosting

GitHub Pages serves the site from the `main` branch of
`Trail-Trak/trail-trak.github.io`. The refresh Action commits the new
schedule to `main`, so each refresh goes live automatically. To refresh by hand,
open the repo's Actions tab, choose "Refresh club schedules", then "Run workflow".
