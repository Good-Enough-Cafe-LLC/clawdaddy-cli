// ─── Connection ──────────────────────────────────────────────────────────────
//
// Manages the Socket.IO signaling connection, WebRTC peer lifecycle,
// reconnect back-off, and the secure send/receive layer (HMAC-signed packets).
import { io } from 'socket.io-client';
import Peer from 'simple-peer';
import wrtc from '@koush/wrtc';
import { randomUUID } from 'node:crypto';

import { deriveSharedKey, computeAuthHash, computeHMAC, verifyHMAC, ClawdaddyMessage, SecurePacket, reassemble, ChunkFrame, MAX_SERIALIZED_SIZE, CHUNK_SIZE } from '@clawdaddy/core';
import { savePairedHosts } from './storage';
import type {
    ConnectionState,
    PairedHost,
    PendingRequest,
} from './types';

// ─── Module-level state ───────────────────────────────────────────────────────

export let activePeer: InstanceType<typeof Peer> | null = null;
export let activeSocket: ReturnType<typeof io> | null = null;
export let currentSharedKey: Buffer | null = null;
export let currentAuthHash: string | null = null;
export let activeHostId: string | null = null;

export const pendingRequests = new Map<string, PendingRequest>();

export let connectionState: ConnectionState = {
    status: 'idle',
    activeHostId: null,
    switchboardConnected: false,
    error: null,
};

let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function updateConnectionState(updates: Partial<ConnectionState>): void {
    connectionState = { ...connectionState, ...updates };
}

// ─── Reconnect back-off ───────────────────────────────────────────────────────

function scheduleReconnect(start: () => void): void {
    reconnectAttempt++;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
    console.log(`🔁 Reconnecting in ${Math.round(delay / 1000)}s...`);
    reconnectTimer = setTimeout(start, delay);
}

function clearReconnect(): void {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnectAttempt = 0;
}

// ─── Secure messaging ─────────────────────────────────────────────────────────

/**
 * Sends a HMAC-signed packet over the active WebRTC data channel.
 * Automatically splits into chunks if the serialised packet exceeds CHUNK_SIZE.
 */
export function sendSecure(payload: any): void {
    if (!activePeer || activePeer.destroyed || !currentSharedKey) {
        throw new Error('No active P2P connection or missing shared key');
    }

    const sharedKeyHex = currentSharedKey.toString('hex');
    const signature = computeHMAC(sharedKeyHex, payload);
    const packet: SecurePacket = { payload, signature };
    const serialised = JSON.stringify(packet);

    // Validate size before sending
    if (serialised.length > MAX_SERIALIZED_SIZE) {
        console.error(`❌ Cannot send: message too large (${serialised.length} bytes > ${MAX_SERIALIZED_SIZE})`);
        return;
    }

    const id = randomUUID();
    const total = Math.ceil(serialised.length / CHUNK_SIZE);

    for (let i = 0; i < total; i++) {
        const frame: ChunkFrame = {
            id,
            index: i,
            total,
            data: serialised.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        };
        activePeer.send(JSON.stringify(frame));
    }

    if (total > 1) {
        console.log(`📤 Sent ${total} chunks (${serialised.length} bytes)`);
    }
}

/**
 * Called for every raw WebRTC data message. Reassembles chunks, then verifies
 * the HMAC and dispatches to the appropriate pending request handler.
 */
export function handleSecureMessage(raw: string): void {

    // ── Step 1: parse the chunk frame ────────────────────────────────────────
    let frame: ChunkFrame;
    try {
        frame = JSON.parse(raw);
    } catch {
        console.error('❌ Malformed frame (not JSON)');
        console.error(`Raw data: ${raw.substring(0, 500)}`);
        return;
    }


    // Validate it looks like a chunk frame (not a legacy unwrapped packet)
    if (typeof frame.id !== 'string' || typeof frame.index !== 'number' || typeof frame.total !== 'number') {
        console.error('❌ Unexpected frame shape — possibly a legacy packet?', Object.keys(frame));
        return;
    }

    // ── Step 2: reassemble chunks with validation ─────────────────────────────
    const serialised = reassemble(frame);
    if (serialised === null) {
        // Still waiting for more chunks or rejected due to validation
        return;
    }

    // ── Step 3: parse the full packet ─────────────────────────────────────────
    let packet: SecurePacket;
    try {
        packet = JSON.parse(serialised);
    } catch {
        console.error('❌ Malformed packet after reassembly');
        return;
    }

    // ── Step 4: verify HMAC ───────────────────────────────────────────────────
    if (!currentSharedKey) {
        console.error('❌ No shared key — cannot verify message');
        return;
    }

    const sharedKeyHex = currentSharedKey.toString('hex');
    if (!verifyHMAC(sharedKeyHex, packet.payload, packet.signature)) {
        console.error('❌ HMAC verification failed — possible tampering or wrong key');
        return;
    }

    // ── Step 5: dispatch ──────────────────────────────────────────────────────
    const { payload } = packet;
    const handler = pendingRequests.get(payload.requestId);

    if (!handler) {
        console.log(`⚠️ No handler found for requestId: ${payload.requestId}`);
        console.log(`🔍 Available handlers: ${Array.from(pendingRequests.keys()).join(', ')}`);
        return;
    }

    switch (payload.type) {
        case 'token': handler.onToken?.(payload.token); break;
        case 'done': handler.onDone?.(payload.stats); break;
        case 'error': handler.onError?.(payload.error); break;
        case 'command_result': handler.onCommandResult?.(payload.result); break;
        case 'command_error': handler.onError?.(payload.error); break;
    }
}

// ─── High-level send helpers ──────────────────────────────────────────────────

/** Sends a command to the peer and resolves with the result. */
export function sendCommand(command: string, payload?: any): Promise<any> {
    if (!activePeer || activePeer.destroyed || !currentSharedKey) {
        return Promise.reject(new Error('No active P2P connection'));
    }

    return new Promise((resolve, reject) => {
        const requestId = randomUUID();

        pendingRequests.set(requestId, {
            onToken: () => { },
            onDone: () => { },
            onError: (err) => reject(new Error(err)),
            onCommandResult: (result: any) => {
                pendingRequests.delete(requestId);
                resolve(result);
            },
        });

        sendSecure({ type: 'command', requestId, command, payload });
    });
}

/**
 * Sends an inference request to the peer.
 * In interactive mode this streams tokens directly to stdout;
 * in API mode the caller registers its own handlers on pendingRequests.
 */
export function sendInference(
    messages: ClawdaddyMessage[],
    options?: { temperature?: number; max_tokens?: number; stream?: boolean },
): Promise<void> {
    if (!activePeer || activePeer.destroyed || !currentSharedKey) {
        return Promise.reject(new Error('No active P2P connection'));
    }

    return new Promise((resolve, reject) => {
        const requestId = randomUUID();

        const packet = {
            type: 'inference',
            requestId,
            messages,
            options: { temperature: 0.7, max_tokens: 256, stream: true, ...options },
        };

        const inputTokens = messages.reduce((sum, msg) => {
            const text = typeof msg.content === 'string'
                ? msg.content
                : Array.isArray(msg.content)
                    ? (msg.content as any[]).map((b) => b.text ?? b.content ?? '').join('')
                    : '';
            return sum + Math.ceil(text.length / 4);
        }, 0);

        pendingRequests.set(requestId, {
            onToken: (token) => process.stdout.write(token),
            onDone: (stats) => {
                console.log(`\n\n⚡ ${stats.tokens} tokens · ${stats.tps.toFixed(1)} tok/s · ${stats.ms}ms`);
                pendingRequests.delete(requestId);
                resolve();
            },
            onError: (err) => {
                console.error(`\n❌ ${err}`);
                pendingRequests.delete(requestId);
                reject(new Error(err));
            },
            inputTokens,
        });

        sendSecure(packet);
    });
}

// ─── WebRTC handshake ─────────────────────────────────────────────────────────

function startHandshake(
    socket: ReturnType<typeof io>,
    targetId: string,
    authHash: string,
    pairingCode: string,
    pairedHosts: Map<string, PairedHost>,
    mode: string,
    onConnected: () => void,
    SIGNAL_SERVER: string,
    INITIATOR_ID: string,
): void {
    console.log(`📡 Attempting to reach ${targetId}...`);
    updateConnectionState({ status: 'connecting', activeHostId: targetId, error: null });

    const peer = new Peer({
        initiator: true,
        trickle: true,
        wrtc,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ],
        },
    });

    peer.on('signal', (data: any) => {
        socket.emit('signal', { targetId, signalData: data, authHash });
    });

    socket.on('signal', ({ signalData }: { signalData: any }) => {
        try {
            peer.signal(signalData);
        } catch (e: any) {
            console.error('❌ Signal error:', e.message);
        }
    });

    peer.on('connect', () => {
        console.log('🚀 P2P connected (secure channel)\n');
        activePeer = peer;
        activeHostId = targetId;

        const now = new Date().toISOString();
        const host = pairedHosts.get(targetId);
        if (host) {
            host.connected = true;
            host.lastConnected = now;
            host.connectedAt = now;
            pairedHosts.set(targetId, host);
        }
        savePairedHosts(pairedHosts);

        updateConnectionState({ status: 'connected', activeHostId: targetId, error: null });
        clearReconnect();
        onConnected();
    });

    peer.on('data', (data: Buffer) => {
        handleSecureMessage(data.toString());
    });

    peer.on('error', (err: { message: any }) => {
        console.error('❌ Peer error:', err.message);
        updateConnectionState({ status: 'error', error: err.message });
        activePeer = null;
        currentSharedKey = null;
        currentAuthHash = null;
        peer.destroy();
        scheduleReconnect(() => startClient(targetId, pairingCode, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID));
    });

    peer.on('close', () => {
        console.log('🔌 P2P connection closed');
        activePeer = null;

        const host = pairedHosts.get(targetId);
        if (host) {
            host.connected = false;
            pairedHosts.set(targetId, host);
            savePairedHosts(pairedHosts);
        }

        if (activeHostId === targetId) {
            activeHostId = null;
            updateConnectionState({ status: 'idle', activeHostId: null });
        }

        scheduleReconnect(() => startClient(targetId, pairingCode, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID));
    });
}

// ─── Client lifecycle ─────────────────────────────────────────────────────────

export async function startClient(
    targetId: string,
    pairingCode: string,
    pairedHosts: Map<string, PairedHost>,
    mode: string,
    onConnected: () => void,
    SIGNAL_SERVER: string,
    INITIATOR_ID: string,
): Promise<void> {
    stopClient(pairedHosts);

    const sharedKey = deriveSharedKey(pairingCode, targetId);
    const authHash = computeAuthHash(sharedKey);

    console.log('🔐 CLIENT DEBUG:');
    console.log(`   Target ID:     ${targetId}`);
    console.log(`   Pairing Code:  ${pairingCode}`);

    currentSharedKey = Buffer.from(sharedKey, 'hex');
    currentAuthHash = authHash;

    console.log('🌐 Connecting to switchboard...');
    updateConnectionState({ status: 'connecting', switchboardConnected: false });

    const socket = io(SIGNAL_SERVER, { transports: ['websocket'], reconnection: false });
    activeSocket = socket;

    socket.on('connect', () => {
        reconnectAttempt = 0;
        console.log('✅ Connected to switchboard');
        updateConnectionState({ switchboardConnected: true });
        socket.emit('register', { deviceId: INITIATOR_ID, authHash });
        startHandshake(socket, targetId, authHash, pairingCode, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID);
    });

    socket.on('disconnect', () => {
        console.log('⚠️ Disconnected from switchboard');
        updateConnectionState({ switchboardConnected: false });
        activePeer?.destroy();
        activePeer = null;
        scheduleReconnect(() => startClient(targetId, pairingCode, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID));
    });

    socket.on('connect_error', (e: Error) => {
        console.error('❌ Switchboard error:', e.message);
        updateConnectionState({ status: 'error', error: e.message, switchboardConnected: false });
        socket.close();
        scheduleReconnect(() => startClient(targetId, pairingCode, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID));
    });
}

export function stopClient(pairedHosts?: Map<string, PairedHost>): void {
    clearReconnect();

    if (activePeer) {
        activePeer.destroy();
        activePeer = null;
    }

    if (activeSocket) {
        activeSocket.close();
        activeSocket = null;
    }

    currentSharedKey = null;
    currentAuthHash = null;

    if (activeHostId && pairedHosts) {
        const host = pairedHosts.get(activeHostId);
        if (host) {
            host.connected = false;
            pairedHosts.set(activeHostId, host);
            savePairedHosts(pairedHosts);
        }
        activeHostId = null;
    }

    updateConnectionState({ status: 'idle', activeHostId: null });
}