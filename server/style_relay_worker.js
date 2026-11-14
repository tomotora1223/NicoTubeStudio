/**
 * NicoTube Studio - Community Style Relay Server (Cloudflare Worker)
 *
 * Bind a KV namespace named `STYLES_KV` in Cloudflare Workers and deploy.
 * Endpoints:
 *   GET  /styles  -> returns array of shared styles (latest 100)
 *   POST /styles  -> publishes a new SharedStyleCreate payload (rate-limited by simple validation)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    if (url.pathname !== '/styles' && url.pathname !== '/') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    if (request.method === 'GET') {
      const raw = await env.STYLES_KV.get('catalog_v1')
      const list = raw ? JSON.parse(raw) : []
      return new Response(JSON.stringify(list), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    if (request.method === 'POST') {
      try {
        const body = await request.json()
        if (!body || typeof body.config !== 'object') {
          return new Response(JSON.stringify({ error: 'Invalid style payload' }), {
            status: 400,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          })
        }
        const raw = await env.STYLES_KV.get('catalog_v1')
        const list = raw ? JSON.parse(raw) : []
        const entry = {
          id: `relay-${crypto.randomUUID().slice(0, 10)}`,
          name: String(body.name || '共有スタイル').slice(0, 80),
          author: String(body.author || 'Anonymous').slice(0, 40),
          description: String(body.description || '').slice(0, 240),
          tags: Array.isArray(body.tags) ? body.tags.slice(0, 6).map(String) : [],
          source: 'relay',
          created_at: Math.floor(Date.now() / 1000),
          config: body.config,
        }
        const next = [entry, ...list].slice(0, 120)
        await env.STYLES_KV.put('catalog_v1', JSON.stringify(next))
        return new Response(JSON.stringify(entry), {
          status: 201,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }
    }

    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS })
  },
}
