// Cloudflare Pages Function — POST /api/ingredients
//
// Turns one or more meal names into a de-duped shopping ingredient list using
// the Google Gemini API (free tier). Called by the "Add ingredients" button.
//
// Set once in the Cloudflare dashboard (Settings → Variables and Secrets):
//   GEMINI_API_KEY  — your key from https://aistudio.google.com/apikey  (add as a SECRET)
//
// Reuses the same shared password as /api/plan (APP_PASSWORD, default "serena"),
// so randoms can't burn through your free quota.

const GEMINI_MODEL = 'gemini-2.5-flash'; // stable free-tier alias; swap if you like

function authorized(env, request) {
  const required = env.APP_PASSWORD || 'serena';
  if (!required) return true;
  return request.headers.get('X-App-Password') === required;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!authorized(env, request)) return json({ error: 'unauthorized' }, 401);
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'no_key', message: 'The ingredients feature needs a GEMINI_API_KEY. Add it free in the Pages project settings (Variables and Secrets) as a Secret, then redeploy.' }, 500);
  }

  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }

  // Accept {meals:[...]} (strings or {name,source} objects) or a single {meal:"..."}
  let meals = [];
  if (Array.isArray(body.meals)) meals = body.meals;
  else if (body.meal) meals = [body.meal];
  meals = meals.map(m => (typeof m === 'string' ? { name: m } : m)).filter(m => m && m.name);
  if (meals.length === 0) return json({ error: 'no_meals' }, 400);
  const people = Number(body.people) || 2;

  const list = meals.map(m => '- ' + m.name + (m.source ? ' (recipe from ' + m.source + ')' : '')).join('\n');
  const prompt =
    'You are building a UK supermarket shopping list. For the following meal(s), list the ingredients someone would need to buy, for ' + people + ' people.\n\n' +
    list + '\n\n' +
    'Rules:\n' +
    '- Combine duplicates across meals into a single line.\n' +
    '- Assume basic staples (salt, pepper, cooking oil, water) are already owned — skip them.\n' +
    '- Keep each item short and shopping-list style, e.g. "Chicken breast", "Coconut milk", "Basmati rice". Add a rough quantity only when it genuinely helps.\n' +
    '- Return ONLY a JSON array of strings.';

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json',
          responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      }),
    });
  } catch (e) {
    return json({ error: 'upstream_unreachable', message: String(e) }, 502);
  }

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw;
    try { detail = JSON.parse(raw).error?.message || raw; } catch (e) {}
    return json({ error: 'api_error', status: res.status, message: detail }, 502);
  }

  let text = '';
  try {
    const data = JSON.parse(raw);
    const parts = data.candidates?.[0]?.content?.parts || [];
    text = parts.map(p => p.text || '').join('').trim();
  } catch (e) {
    return json({ error: 'bad_response' }, 502);
  }

  // With responseMimeType=json this is already a clean JSON array; parse defensively anyway.
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let ingredients = [];
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) ingredients = parsed;
    else if (parsed && Array.isArray(parsed.ingredients)) ingredients = parsed.ingredients;
  } catch (e) {
    ingredients = cleaned.split('\n').map(s => s.replace(/^[-*•\d.\s]+/, '').trim()).filter(Boolean);
  }
  ingredients = ingredients.map(s => String(s).trim()).filter(Boolean).slice(0, 60);
  return json({ ingredients });
}
