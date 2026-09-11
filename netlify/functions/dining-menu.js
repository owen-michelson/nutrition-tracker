// dining-menu.js — the dining-hall lookup's server half, second version (2026-09-10).
//
// WHAT CHANGED AND WHY. The first version (dining-proxy.js, retired the same day) read menus
// from EatSmart / NetNutrition, Illinois's nutrition-label website. Owen noticed two or three
// times that the foods it listed for a day were not what the hall was actually serving. Checked
// on 10 Sep 2026 against every Ikenberry station: NetNutrition was missing 42 of the 142 items
// the hall served that day — a breaded pork tenderloin, a whole pizza, a chicken tikka masala —
// and it was not a bug in the app, the site itself simply did not have them. The Illinois app
// (the one people check in the hall) does not use that site. It reads a separate feed run by
// University Housing, and THAT feed had all 142.
//
// So this function reads the same feed the Illinois app reads:
//   https://web.housing.illinois.edu/MobileAppWS/api/Menu/<hall id>/<M-d-yyyy>  -> every item
//        the hall serves that day, with its station, meal and course, in one JSON list
//   https://web.housing.illinois.edu/MobileAppWS/api/Nutrition/<item id>       -> the label
// Both are plain GETs that answer any client (no cookies, no session, no browser fingerprint
// check — the thing that forced the old version to launch a real Chromium on every call).
// A call takes about 50 ms instead of 4-25 seconds, and the whole day's menu for a hall comes
// back at once instead of one station-and-meal at a time.
//
// WHY THERE IS STILL A FUNCTION AT ALL: the feed sends no Access-Control-Allow-Origin header,
// so the phone's browser refuses to call it directly (CORS — a browser rule, not a server one).
// This function makes the call server-to-server and passes the answer straight through.
// It adds nothing and hides nothing: the JSON the app gets is the JSON Housing sent.
//
// Hall ids are Housing's own DiningOptionIDs (from its LocationSchedules endpoint):
//   1 = Ikenberry, 2 = PAR, 3 = ISR, 5 = Lincoln/Allen, and the à-la-carte spots that take
//   Dining Dollars (added 11 Sep): 6 = Corner Cafe, 7 = 57 North, 9 = Caffeinator,
//   14 = Urbana South Market, 18 = TerraByte, 30 = InfiniTEA.
// Note these are NOT the ids the old NetNutrition version used (1/11/22/29).
const FEED = 'https://web.housing.illinois.edu/MobileAppWS/api/';
const HALLS = new Set(['1', '2', '3', '5', '6', '7', '9', '14', '18', '30']);
// The feed sits behind IIS and answers plain scripts, but a request with no User-Agent at all
// is the one shape worth not sending — some IIS front ends drop those on the floor.
const UA = 'Mozilla/5.0 (compatible; calorie-app dining lookup)';
const TIMEOUT_MS = 8000;

function reply(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Turns the app's YYYY-MM-DD into the feed's M-d-yyyy (no leading zeros: 9-10-2026, not
// 09-10-2026). Done here rather than in the app so the app only ever speaks one date format,
// and so a malformed date is rejected before it goes anywhere.
function feedDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return mo + '-' + d + '-' + y;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return reply(405, { ok: false, error: 'Use GET' });
  const q = event.queryStringParameters || {};

  let path;
  if (q.op === 'menu') {
    const day = feedDate(q.date);
    if (!HALLS.has(String(q.hall))) return reply(400, { ok: false, error: 'Unknown hall id' });
    if (!day) return reply(400, { ok: false, error: 'Date must be YYYY-MM-DD' });
    path = 'Menu/' + q.hall + '/' + day;
  } else if (q.op === 'nutrition') {
    if (!/^\d{1,9}$/.test(String(q.item || ''))) return reply(400, { ok: false, error: 'Bad item id' });
    path = 'Nutrition/' + q.item;
  } else {
    return reply(400, { ok: false, error: 'op must be menu or nutrition' });
  }

  // AbortController so a stalled upstream fails with a readable error inside the time Netlify
  // gives a function, instead of the platform killing the call and the app seeing a bare 502.
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  try {
    const r = await fetch(FEED + path, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: controller.signal });
    if (!r.ok) return reply(200, { ok: false, error: 'Housing feed answered ' + r.status });
    const text = await r.text();
    // The feed answers an unknown item with an empty body rather than a 404. Pass that through
    // as "no data" instead of letting the app choke on JSON.parse('').
    if (!text.trim()) return reply(200, { ok: true, data: null });
    return reply(200, { ok: true, data: JSON.parse(text) });
  } catch (e) {
    return reply(200, { ok: false, error: e.name === 'AbortError' ? 'Housing feed timed out' : e.message });
  } finally {
    clearTimeout(timer);
  }
};
