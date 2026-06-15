const KEY = 'plan';

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
  if (!env.PLAN_KV) {
    return json({ error: 'KV namespace "PLAN_KV" is not bound. Add it in the Pages project settings.' }, 500);
  }
  if (!authorized(env, request)) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (request.method === 'GET') {
    const data = await env.PLAN_KV.get(KEY);
    return new Response(data || 'null', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.text();
    if (body.length > 2000000) return json({ error: 'plan too large' }, 413);
    try { JSON.parse(body); } catch (e) { return json({ error: 'invalid json' }, 400); }
    await env.PLAN_KV.put(KEY, body);
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
}
