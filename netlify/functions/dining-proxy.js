// dining-proxy.js — the "heavier fix" version (2026-08-22).
//
// BACKGROUND: UIUC's dining nutrition site (eatsmart.housing.illinois.edu, a system called
// NetNutrition) doesn't allow the app to call it directly from the phone's browser (blocked by
// CORS — confirmed by testing). The normal fix is a small serverless function that calls it
// server-to-server instead. That was tried first (a plain fetch() proxy) and NetNutrition
// rejected it too — every plain HTTP request came back with the same generic "Start-up Error"
// page, including a bare unauthenticated homepage GET, while the exact same request succeeded
// instantly when run as real JavaScript inside an actual browser tab. That smells like
// bot/fingerprint detection sitting in front of the site, which a plain script can't get past no
// matter what headers or cookies it sends.
//
// THE FIX: this function launches a real (headless, meaning no visible window) Chromium browser
// on the server, has THAT browser visit the page and make the request via its own real
// JavaScript — the same trick as opening the site in a real tab — then hands the answer back to
// the app. Confirmed working locally against the real site (2026-08-22) for all four endpoints.
//
// COST OF THIS APPROACH, be upfront about it: launching a real browser takes real time — roughly
// 1-2 seconds locally, likely a bit more on a cold serverless start — and it happens on EVERY
// call, since each function invocation starts fresh with no memory of the last one. A full
// hall -> station -> menu -> item lookup makes four separate calls, so expect the whole lookup to
// take several seconds, not be instant. That's the real tradeoff for getting past the blocking.
//
// TWO WAYS TO RUN THE SAME CODE: locally (this machine, for testing) it uses the full `puppeteer`
// package, which downloads its own Chromium build. In production (a real Netlify deploy, running
// on Linux serverless infrastructure) it uses `puppeteer-core` (no bundled browser — much
// smaller) plus `@sparticuz/chromium-min`. Same handler code either way — only which
// browser-launching library gets loaded differs, decided automatically by which one is actually
// installed.
//
// A NOTE ON @sparticuz/chromium-min SPECIFICALLY: Netlify Functions cap a deployed function at
// 50MB. The full Chromium build (`@sparticuz/chromium`) alone is ~58MB compressed — over that cap
// on its own. `chromium-min` solves it by NOT bundling the browser at all; instead it downloads
// it from an external URL the first time the function runs cold, and reuses that download on
// warm starts. CHROMIUM_PACK_URL below points at that project's own GitHub release — a real,
// external dependency this feature now has. If that release ever moves or GitHub is unreachable,
// this feature breaks even though nothing in this app changed — worth remembering if it ever
// stops working for no visible reason.
const CHROMIUM_PACK_URL = 'https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar';

const BASE_ORIGIN = 'https://eatsmart.housing.illinois.edu';
const BASE_PATH = '/NetNutrition/46/';

const ALLOWED_PATHS = new Set([
  'Unit/SelectUnitFromUnitsList',
  'Unit/SelectUnitFromChildUnitsList',
  'Menu/SelectMenu',
  'NutritionDetail/ShowItemNutritionLabel'
]);

async function launchBrowser() {
  const puppeteerCore = require('puppeteer-core');
  const chromium = require('@sparticuz/chromium-min');
  // LOCAL_CHROMIUM_PATH lets this be tested on this machine against a real local Chromium
  // (pointed at whatever full `puppeteer` already downloaded for itself) without ever writing
  // `require('puppeteer')` in this file. That matters: Netlify's function bundler follows every
  // require() it can find in the source, even ones inside a branch that would never run in
  // production — if `puppeteer` (which bundles its own ~170MB desktop Chromium) were required
  // here at all, the bundler would likely try to ship it, blowing past the 50MB function limit
  // this whole chromium-min setup exists to stay under. An env var avoids that risk entirely.
  const localPath = process.env.LOCAL_CHROMIUM_PATH;
  return await puppeteerCore.launch({
    args: localPath ? [] : chromium.args,
    executablePath: localPath || await chromium.executablePath(CHROMIUM_PACK_URL),
    headless: true
  });
}

// IMPORTANT DISCOVERY WHILE TESTING THIS VERSION: NetNutrition's deeper steps (SelectMenu,
// ShowItemNutritionLabel) don't just need "a" valid session — they need a session that actually
// walked through the earlier steps first (hall, then station) in order. A fresh browser session
// that jumps straight to "give me this menu" fails, even with an otherwise-valid session cookie.
// Since each function call is its own fresh browser (nothing is kept between calls — serverless
// functions don't share memory that way), the fix is to replay the WHOLE path so far inside one
// browser session on every call: the app sends the entire sequence of picks made up to and
// including the one it actually wants (hall, then station, then menu, ...), this function walks
// through all of them in order in one page, and only the LAST step's answer is actually returned.
// The earlier replayed steps cost almost nothing extra (each fetch() is under 20ms once the
// browser is already open on the right page) — the real cost is the one browser launch per call,
// same as before.
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Use POST' };
  }

  let steps;
  try {
    const req = JSON.parse(event.body || '{}');
    steps = req.steps;
  } catch (e) {
    return { statusCode: 400, body: 'Bad request body' };
  }

  if (!Array.isArray(steps) || !steps.length || steps.length > 4) {
    return { statusCode: 400, body: 'Expected a "steps" array of 1 to 4 {path, params} entries' };
  }
  for (const s of steps) {
    if (!s || !ALLOWED_PATHS.has(s.path)) {
      return { statusCode: 400, body: 'Unknown endpoint: ' + (s && s.path) };
    }
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    // domcontentloaded is enough to pick up a valid session — waiting for the full page
    // (networkidle2) also works but is measurably slower for no extra benefit, since only the
    // fetch() calls after this matter, not anything visual on the page.
    await page.goto(BASE_ORIGIN + BASE_PATH, { waitUntil: 'domcontentloaded', timeout: 15000 });

    let text = '';
    for (const step of steps) {
      // Runs INSIDE the real browser page — same origin, so no CORS issue, and it carries the
      // real browser's fingerprint/cookies the way a person's tap would.
      text = await page.evaluate(async (base, path, params) => {
        const r = await fetch(base + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString()
        });
        return await r.text();
      }, BASE_PATH, step.path, step.params || {});
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, text: text })
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, text: '', error: e.message })
    };
  } finally {
    if (browser) await browser.close();
  }
};
