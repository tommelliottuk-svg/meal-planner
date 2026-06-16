// Cloudflare Pages Function — POST /api/ingredients
//
// Builds a de-duped, aisle-ordered shopping list for a meal using Google Gemini.
// If the meal has a recipe URL, it reads that page server-side and uses the real
// ingredients; otherwise it estimates from the dish name.
//
// Set in Cloudflare (Settings → Variables and Secrets, as a SECRET):
//   GEMINI_API_KEY  — free key from https://aistudio.google.com/apikey
// Shares the plan password (APP_PASSWORD, default "serena").

const GEMINI_MODEL = 'gemini-2.5-flash';

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

/* ---------- recipe page reading ---------- */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
function matchMeta(html, key) {
  const pats = [
    new RegExp('<meta[^>]+(?:property|name)=["\']' + key + '["\'][^>]+content=["\']([^"\']*)["\']', 'i'),
    new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + key + '["\']', 'i'),
  ];
  for (const re of pats) { const m = html.match(re); if (m) return m[1]; }
  return '';
}
function collectIngredients(node, out) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => collectIngredients(n, out)); return; }
  if (typeof node === 'object') {
    if (Array.isArray(node.recipeIngredient)) node.recipeIngredient.forEach(i => { if (typeof i === 'string') out.push(i); });
    if (node['@graph']) collectIngredients(node['@graph'], out);
    if (node.mainEntity) collectIngredients(node.mainEntity, out);
  }
}
function extractJsonLdIngredients(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data; try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    collectIngredients(data, out);
  }
  return [...new Set(out.map(s => s.trim()).filter(Boolean))];
}
async function readRecipe(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!r.ok) return null;
    let html = await r.text();
    if (html.length > 500000) html = html.slice(0, 500000);
    const ings = extractJsonLdIngredients(html);
    if (ings.length) return { kind: 'ingredients', data: ings };
    const og = matchMeta(html, 'og:description') || matchMeta(html, 'description') || '';
    const text = (og + ' ' + htmlToText(html)).slice(0, 6000);
    if (text.trim().length > 40) return { kind: 'text', data: text };
    return null;
  } catch (e) { return null; }
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

  let meals = Array.isArray(body.meals) ? body.meals : (body.meal ? [body.meal] : []);
  meals = meals.map(m => (typeof m === 'string' ? { name: m } : m)).filter(m => m && m.name);
  if (meals.length === 0) return json({ error: 'no_meals' }, 400);
  const meal = meals[0];
  const people = Number(body.people) || 2;
  const aisles = Array.isArray(body.aisles) ? body.aisles.map(a => String(a).trim()).filter(Boolean) : [];

  // Try to read the recipe link.
  let via = 'name', basis = 'Estimate the typical ingredients needed for this dish.';
  if (meal.url) {
    const recipe = await readRecipe(meal.url);
    if (recipe && recipe.kind === 'ingredients') {
      via = 'recipe';
      basis = 'These are the exact ingredients from the recipe. Turn them into a clean shopping list (drop quantities and prep words like "chopped" unless a quantity genuinely helps):\n' + recipe.data.join('\n');
    } else if (recipe && recipe.kind === 'text') {
      via = 'page';
      basis = 'Extract the shopping ingredients from this recipe page text (ignore navigation/comments/ads):\n' + recipe.data;
    }
  }

  const aisleLine = aisles.length ? aisles.join('  →  ') : '(no aisle order provided — use sensible UK supermarket sections)';
  const prompt =
    'You are building a UK supermarket shopping list for ' + people + ' people for this meal: "' + meal.name + '"' + (meal.source ? ' (from ' + meal.source + ')' : '') + '.\n\n' +
    basis + '\n\n' +
    'Our supermarket aisles, in the order we walk them:\n' + aisleLine + '\n\n' +
    'Rules:\n' +
    '- Combine duplicates; skip basic staples (salt, pepper, cooking oil, water).\n' +
    '- Use short shopping-list names, e.g. "Chicken breast", "Coconut milk", "Basmati rice".\n' +
    '- Give each item an "aisle" using EXACTLY one of the aisle names listed above; if none fits, use "Other".\n' +
    '- Sort the items to follow the aisle order above.\n' +
    '- Return ONLY a JSON array of {item, aisle} objects.';

  let res;
  try {
    res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'ARRAY',
            items: { type: 'OBJECT', properties: { item: { type: 'STRING' }, aisle: { type: 'STRING' } }, required: ['item', 'aisle'] },
          },
        },
      }),
    });
  } catch (e) { return json({ error: 'upstream_unreachable', message: String(e) }, 502); }

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw; try { detail = JSON.parse(raw).error?.message || raw; } catch (e) {}
    return json({ error: 'api_error', status: res.status, message: detail }, 502);
  }

  let text = '';
  try {
    const data = JSON.parse(raw);
    text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  } catch (e) { return json({ error: 'bad_response' }, 502); }

  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let items = [];
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) items = parsed;
    else if (parsed && Array.isArray(parsed.items)) items = parsed.items;
  } catch (e) {
    items = cleaned.split('\n').map(s => s.replace(/^[-*•\d.\s]+/, '').trim()).filter(Boolean).map(s => ({ item: s, aisle: 'Other' }));
  }
  items = items
    .map(o => (typeof o === 'string' ? { item: o, aisle: 'Other' } : o))
    .map(o => ({ item: String(o.item || '').trim(), aisle: String(o.aisle || 'Other').trim() || 'Other' }))
    .filter(o => o.item)
    .slice(0, 80);

  return json({ items, via });
}
