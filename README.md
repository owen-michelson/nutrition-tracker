# Nutrition and training tracker

A single-page web app for logging food and workouts, built to run from an iPhone home screen.
Photograph a meal and it fills in the macros. Log a lift and it tracks progression against your
last session.

I built it because I was tracking calories to fix stalled gym progress, and every app that scans a
photo puts that behind a subscription — MyFitnessPal at $79.99/yr, Lose It at $39.99/yr, Cronometer
doesn't do photos at all.

**Live:** https://cheerful-twilight-9a3756.netlify.app/

---

## The idea worth stealing

Asking a model "how many calories are in this photo?" is a bad question. It has to guess the food,
the portion, the oil, the preparation — and the published error on that is roughly 20–30%. Stacked
across a day, that's the whole deficit you were trying to measure.

So the app asks a different question. You save a meal once with its real macros, entered by hand or
read off the packet. From then on, the model is only asked **"which of these saved meals is this
photo?"** — a recognition problem, not an estimation problem. Recognition is something these models
are genuinely reliable at, and once it has the answer the numbers come from your own saved figures,
not from a guess.

Implementation is unglamorous: the saved meal names get passed into the prompt alongside the image.
No embeddings, no image-similarity work. Two modes fall out of it — a known meal returns exact saved
macros, and an unrecognised one returns a rough estimate you can correct and then save, which makes
it exact every time after.

The same reasoning drives the recipe feature: hand it a recipe and it computes macros per ingredient
and per serving, which is what made home-cooked food trackable at all.

---

## What else is in it

**Eating.** Daily targets with a calculator that derives them from height, weight, age, activity and
goal. Food database search against USDA and Nutritionix. A UIUC dining-hall lookup. Photo logging,
saved meals, recipes, streaks and badges.

**Training.** Routines with target sets and rep ranges, a live workout timer, a rest timer, set-by-set
logging that shows what you did last time, one-rep-max estimation (Epley) for ranking lifts against
strength standards, streaks, and a body map of what you've trained.

**Offline-tolerant.** State lives in `localStorage`, so it works with no signal and survives being
backgrounded by iOS.

---

## How it's built

One `index.html` file. Plain JavaScript, no framework, no build step, no bundler. That was a
deliberate constraint: I wanted to be able to read the whole thing, and I was learning as I went.

The only server-side piece is `netlify/functions/dining-proxy.js`. UIUC's dining nutrition site
blocks browser calls with CORS, and a plain server-to-server proxy got blocked too — every plain HTTP
request came back with a generic error page, while the identical request from a real browser tab
worked instantly. That's bot detection, and no combination of headers gets past it. The function
launches a real headless Chromium, has that browser make the request, and hands back the answer. It
costs 1–2 seconds per call and the tradeoff is written up in the file's header comment.

**No API keys in this repository, and none in the deployed file.** Gemini, USDA and Nutritionix keys
are typed into the app once on the phone and kept in `localStorage` on that device.

---

## Running it

Open `index.html` in a browser. That's the whole setup — it's a static file.

For the photo recognition and food search you need your own free API keys, entered in the app's
settings screen:

- **Google Gemini** (photo recognition) — free tier, no card required
- **USDA FoodData Central** and **Nutritionix** (food search) — both free

For the dining-hall lookup you'd need to deploy to Netlify so the serverless function runs.

---

## Honest notes

**This was built with Claude as a coding partner**, over about 25 sessions, with Claude explaining
each piece as we went — the point was to end up able to read and change it, not just to have it.
The meal-matching idea above is mine, and it's the design decision I'd defend hardest.

**Known limits.** A true page reload mid-workout loses set data typed but not yet saved; only the
routine and the clock are persisted. The rest timer can't fire a precise lock-screen alert without a
push server, so it catches up when you return to the app. The per-dumbbell weight flag is keyed by
exercise name across all routines, so reusing one name with different equipment will confuse it.

An automated multi-agent debugging pass over the source found 6 real defects — including saves
failing silently once browser storage filled, and bodyweight sets being discarded on finish. Each was
reproduced by hand before being fixed.
