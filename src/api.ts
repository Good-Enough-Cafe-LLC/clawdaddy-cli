// ─── API Server ──────────────────────────────────────────────────────────────
//
// Starts the local HTTP server that exposes Anthropic- and OpenAI-compatible
// inference endpoints, plus pairing management routes.

import http from 'http';
import { URL } from 'url';
import { randomUUID } from 'node:crypto';

import {
    activePeer,
    currentSharedKey,
    activeHostId,
    connectionState,
    pendingRequests,
    sendSecure,
    startClient,
    stopClient,
    updateConnectionState,
} from './connection';
import { savePairedHosts } from './storage';
import { normalizeTarget, normalizeCode, isValidTarget, isValidCode } from './validation';
import type { PairedHost } from './types';

const API_PORT = 3001;

// ─── CORS ─────────────────────────────────────────────────────────────────────

function setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-api-key, anthropic-version, Accept, *, ' +
        'anthropic-beta, anthropic-dangerous-direct-browser-access, ' +
        'x-claude-code-session-id, x-stainless-*',
    );
    res.setHeader('Access-Control-Max-Age', '86400');
}

// ─── Body helper ──────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => resolve(body));
    });
}

function parseBody(body: string, res: http.ServerResponse): any | null {
    try {
        return JSON.parse(body);
    } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return null;
    }
}

// ─── Guard helper ─────────────────────────────────────────────────────────────

function requirePeer(res: http.ServerResponse): boolean {
    if (!activePeer || activePeer.destroyed || !currentSharedKey) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No peer connected — pair a host first with POST /v1/pair' }));
        return false;
    }
    return true;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

function handleStatus(
    res: http.ServerResponse,
    pairedHosts: Map<string, PairedHost>,
    INITIATOR_ID: string,
    SIGNAL_SERVER: string,
): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        connection: connectionState,
        pairedHosts: Array.from(pairedHosts.values()),
        initiatorId: INITIATOR_ID,
        signalServer: SIGNAL_SERVER,
    }));
}

function handleListHosts(res: http.ServerResponse, pairedHosts: Map<string, PairedHost>): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hosts: Array.from(pairedHosts.values()), count: pairedHosts.size }));
}

async function handlePair(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pairedHosts: Map<string, PairedHost>,
    mode: string,
    onConnected: () => void,
    SIGNAL_SERVER: string,
    INITIATOR_ID: string,
): Promise<void> {
    const body = await readBody(req);
    const parsed = parseBody(body, res);
    if (!parsed) return;

    const { hostId, pairingCode } = parsed;
    if (!hostId || !pairingCode) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'hostId and pairingCode are required' }));
        return;
    }

    const normalizedId = normalizeTarget(hostId);
    const normalizedCode = normalizeCode(pairingCode);

    if (!isValidTarget(normalizedId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid hostId format', expected: 'xxxx-xxxx (hex, e.g. ab12-34cd)' }));
        return;
    }

    if (!isValidCode(normalizedCode)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid pairingCode format', expected: 'XXXX-XXXX (e.g. AB12-CD34)' }));
        return;
    }

    pairedHosts.set(normalizedId, {
        id: normalizedId,
        pairingCode: normalizedCode,
        connected: false,
        lastConnected: null,
        connectedAt: null,
    });
    savePairedHosts(pairedHosts);

    if (activeHostId === normalizedId && connectionState.status === 'connected') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Already connected to this host', hostId: normalizedId }));
        return;
    }

    if (activePeer && activeHostId && activeHostId !== normalizedId) {
        console.log(`🔌 Disconnecting from ${activeHostId} to switch to ${normalizedId}`);
        stopClient(pairedHosts);
    }

    try {
        await startClient(normalizedId, normalizedCode, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Pairing initiated', hostId: normalizedId, status: 'connecting' }));
    } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

async function handleUnpair(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pairedHosts: Map<string, PairedHost>,
): Promise<void> {
    const body = await readBody(req);
    let parsed: any = {};
    if (body) {
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
    }

    const hostId = parsed.hostId || activeHostId;
    if (!hostId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No host specified and no active host' }));
        return;
    }

    const normalized = normalizeTarget(hostId);
    pairedHosts.delete(normalized);
    savePairedHosts(pairedHosts);

    if (activeHostId === normalized) stopClient(pairedHosts);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: `Unpaired from ${normalized}`, hostId: normalized }));
}

async function handleCommand(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const parsed = parseBody(body, res);
    if (!parsed) return;

    const { command, payload } = parsed;
    if (!command) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'command is required' }));
        return;
    }

    if (!requirePeer(res)) return;

    try {
        const { sendCommand } = await import('./connection.js');
        const result = await sendCommand(command, payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result }));
    } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

// Add a map to track active requests by their content hash
const activeRequests = new Map<string, { requestId: string; subscribers: Set<http.ServerResponse> }>();

async function handleAnthropicMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const parsed = parseBody(body, res);
    if (!parsed) return;

    const stream = parsed.stream !== false;

    if (!stream) {
        // ... non-streaming response (unchanged)
        return;
    }

    if (!requirePeer(res)) return;

    // Create a hash of the request content to detect duplicates
    const contentHash = JSON.stringify({
        messages: parsed.messages,
        model: parsed.model,
        max_tokens: parsed.max_tokens,
        temperature: parsed.temperature
    });

    // Check if we're already processing this exact request
    const existing = activeRequests.get(contentHash);

    if (existing) {
        console.log(`🔄 Reusing existing stream for duplicate request`);

        // Subscribe this response to the existing stream
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        console.log(`📡 SSE response headers sent, writable=${res.writable}`);

        // Add this response to subscribers
        existing.subscribers.add(res);

        // Clean up when client disconnects
        req.on('close', () => {
            existing.subscribers.delete(res);
            if (existing.subscribers.size === 0) {
                // No more subscribers, clean up the pending request
                pendingRequests.delete(existing.requestId);
                activeRequests.delete(contentHash);
            }
        });

        return;
    }

    // New unique request - proceed normally
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    const requestId = randomUUID();
    const inputTokens = 0;

    // Store subscribers for this request
    const subscribers = new Set<http.ServerResponse>();
    subscribers.add(res);

    activeRequests.set(contentHash, { requestId, subscribers });

    // 1. Send message_start
    res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
            id: requestId, type: 'message', role: 'assistant',
            content: [], model: parsed.model || 'clawdaddy',
            stop_reason: null, stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
    })}\n\n`);

    // 2. CRITICAL: Send content_block_start (Claude Code needs this to open the stream parser)
    res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
    })}\n\n`);

    // 3. Flush the buffer (if you are using compression or certain proxies)
    if ((res as any).flush) (res as any).flush();

    let timeoutId: NodeJS.Timeout;

    pendingRequests.set(requestId, {
        inputTokens,
        onToken: (token) => {
            for (const subscriber of subscribers) {
                try {
                    subscriber.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: 'content_block_delta', index: 0,
                        delta: { type: 'text_delta', text: token },
                    })}\n\n`);
                } catch (err) {
                    console.error(`❌ Failed to write to subscriber: ${err}`);
                }
            }
        },
        onDone: (stats) => {
            for (const subscriber of subscribers) {
                subscriber.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
                subscriber.write(`event: message_delta\ndata: ${JSON.stringify({
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn', stop_sequence: null },
                    usage: { input_tokens: inputTokens, output_tokens: stats?.tokens || 0 },
                })}\n\n`);
                subscriber.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
                subscriber.end();
            }
            pendingRequests.delete(requestId);
            activeRequests.delete(contentHash);
            clearTimeout(timeoutId);
        },
        onError: (err) => {
            for (const subscriber of subscribers) {
                subscriber.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: err } })}\n\n`);
                subscriber.end();
            }
            pendingRequests.delete(requestId);
            activeRequests.delete(contentHash);
            clearTimeout(timeoutId);
        },
    });

    timeoutId = setTimeout(() => {
        const handler = pendingRequests.get(requestId);
        handler?.onError?.('Request timeout — node may be busy or offline');
    }, 120_000);

    const messages = (parsed.messages ?? []).map((m: any) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    sendSecure({ type: 'inference', requestId, messages, options: { max_tokens: parsed.max_tokens ?? 1024, temperature: parsed.temperature ?? 0.7 } });
}

async function handleOpenAICompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const parsed = parseBody(body, res);
    if (!parsed) return;

    const stream = parsed.stream !== false;

    if (!stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // some openAI apis want this
        // res.write(`data: ${JSON.stringify({
        //     id: requestId,
        //     object: 'chat.completion.chunk',
        //     created: Math.floor(Date.now() / 1000),
        //     model: parsed.model || 'clawdaddy',
        //     choices: [{ delta: { role: 'assistant', content: '' }, index: 0, finish_reason: null }],
        // })}\n\n`);
        res.end(JSON.stringify({
            id: randomUUID(), object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: parsed.model || 'clawdaddy',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Model is ready.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
        return;
    }

    if (!requirePeer(res)) return;

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    const requestId = randomUUID();
    let firstToken = true;

    pendingRequests.set(requestId, {
        inputTokens: 0,

        // inside pendingRequests.set...
        onToken: (token) => {
            const delta: any = { content: token };
            if (firstToken) {
                delta.role = 'assistant';
                firstToken = false;
            }

            res.write(`data: ${JSON.stringify({
                id: requestId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: parsed.model || 'clawdaddy',
                choices: [{ delta, index: 0, finish_reason: null }],
            })}\n\n`);

            if ((res as any).flush) (res as any).flush(); // Keep those tokens moving!
        },
        onDone: () => {
            res.write(`data: ${JSON.stringify({
                id: requestId, object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: parsed.model || 'clawdaddy',
                choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
            })}\n\n`);
            res.write(`data: [DONE]\n\n`);
            res.end();
            pendingRequests.delete(requestId);
        },
        onError: (err) => {
            res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
            res.end();
            pendingRequests.delete(requestId);
        },
    });

    sendSecure({ type: 'inference', requestId, messages: parsed.messages, options: { max_tokens: parsed.max_tokens ?? 256, temperature: parsed.temperature ?? 0.7 } });
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function startApiMode(
    pairedHosts: Map<string, PairedHost>,
    mode: string,
    onConnected: () => void,
    INITIATOR_ID: string,
    SIGNAL_SERVER: string,
): void {
    const server = http.createServer(async (req, res) => {
        setCorsHeaders(res);
        console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.url}`);

        const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
        const pathname = parsedUrl.pathname;

        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (req.method === 'HEAD' && pathname === '/') { res.writeHead(200); res.end(); return; }

        if (req.method === 'GET' && pathname === '/v1/status') return handleStatus(res, pairedHosts, INITIATOR_ID, SIGNAL_SERVER);
        if (req.method === 'GET' && pathname === '/v1/hosts') return handleListHosts(res, pairedHosts);
        if (req.method === 'POST' && pathname === '/v1/pair') return handlePair(req, res, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID);
        if (req.method === 'POST' && pathname === '/v1/unpair') return handleUnpair(req, res, pairedHosts);
        if (req.method === 'POST' && pathname === '/v1/command') return handleCommand(req, res);
        if (req.method === 'POST' && pathname === '/v1/messages') return handleAnthropicMessages(req, res);
        if (req.method === 'POST' && pathname === '/v1/chat/completions') return handleOpenAICompletions(req, res);

        if (req.method === 'GET' && pathname === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'clawdaddy', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'clawdaddy' }] }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found', path: req.url }));
    });

    server.listen(API_PORT, () => {
        console.log(`🌐 Clawdaddy API server ready at http://localhost:${API_PORT}`);
        console.log('');
        console.log('🔐 Security enabled: PBKDF2 + HMAC-SHA256');
        console.log('');
        console.log('📡 Pairing endpoints:');
        console.log('   GET  /v1/status              Connection status');
        console.log('   GET  /v1/hosts              List paired hosts');
        console.log('   POST /v1/pair                Pair with a host {hostId, pairingCode}');
        console.log('   POST /v1/unpair              Unpair from a host {hostId?}');
        console.log('');
        console.log('🤖 Inference endpoints:');
        console.log('   POST /v1/messages            Anthropic-style streaming');
        console.log('   POST /v1/chat/completions    OpenAI-style fallback');
        console.log('   GET  /v1/models              List available models');
        console.log('');
        if (!INITIATOR_ID) {
            console.log('💡 No host paired yet. Use POST /v1/pair with {hostId, pairingCode} to connect.');
        }
    });
}