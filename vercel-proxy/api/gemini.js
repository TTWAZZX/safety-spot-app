// Vercel serverless proxy — forwards Gemini requests from Render to Google AI
// Render's IP region is not supported by Gemini; Vercel (iad1/US East) is.
//
// Required env vars on Vercel:
//   GEMINI_API_KEY      — your Google AI Studio key
//   INTERNAL_AI_TOKEN   — shared secret with Render (must match Render env var)

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Validate shared secret
    const auth = req.headers['authorization'] || '';
    const expected = process.env.INTERNAL_AI_TOKEN;
    if (!expected || auth !== `Bearer ${expected}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { model, payload } = req.body || {};
    if (!model || !payload) {
        return res.status(400).json({ error: 'Missing model or payload' });
    }

    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        console.error('[gemini-proxy] GEMINI_API_KEY not configured');
        return res.status(500).json({ error: 'GEMINI_API_KEY not configured on proxy' });
    }

    // Forward to Google AI — payload is already fully assembled (thinking config applied on Render side)
    let upstream;
    try {
        upstream = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }
        );
    } catch (fetchErr) {
        console.error('[gemini-proxy] fetch error:', fetchErr.message);
        return res.status(502).json({ error: 'Upstream fetch failed', detail: fetchErr.message });
    }

    const responseText = await upstream.text();
    if (!upstream.ok) {
        console.error(`[gemini-proxy] Gemini ${upstream.status} for model=${model}`);
    }
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(responseText);
}
