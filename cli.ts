#!/usr/bin/env node
/**
 * Clawdaddy CLI — entry point
 *
 * Handles argument parsing, interactive REPL, and bootstrapping both modes.
 */

import readline from 'readline';

import { getOrCreateClientId, loadPairedHosts, savePairedHosts } from './src/storage';
import { startClient, stopClient } from './src/connection';
import { startApiMode } from './src/api';
import { startInteractiveMode } from './src/interactive';
import { normalizeTarget, normalizeCode, isValidTarget, isValidCode } from './src/validation';
import type { PairedHost } from './src/types';
import { getConfig } from './src/config';

const SIGNAL_SERVER = getConfig().signalServer;

// ─── Config ───────────────────────────────────────────────────────────────────
const INITIATOR_ID  = getOrCreateClientId();

// ─── Shared state ─────────────────────────────────────────────────────────────

const pairedHosts: Map<string, PairedHost> = new Map();

// ─── Arg parsing ──────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);

let TARGET_PHONE_ID: string | null = null;
let PAIRING_CODE: string | null    = null;
let MODE: 'interactive' | 'api'    = 'interactive';

function printHelp(): void {
  console.log(`
🦞 Clawdaddy CLI

Usage:
  npm run cli [mode] [target] [--code <code>]

Modes:
  interactive    Start REPL-style prompt (default)
  api            Start local API server (Claude Code / curl)
                 No host required at startup — pair dynamically via API

Options:
  --mode <mode>      Set mode (interactive | api)
  --target <id>      Target host ID (xxxx-xxxx format)
  --code <code>      Pairing code (XXXX-XXXX format)
  --help             Show this help message

Commands in interactive mode:
  /ping                    - Check if host is responsive
  /get_status              - Get host status and stats
  /get_memory_stats        - Show conversation memory usage
  /clear_memory            - Clear conversation history
  /set_system_prompt <text> - Change system prompt/personality
  /help                    - Show this help message

Examples:
  npm run cli zach-host-1 --code AB12-CD34
  npm run cli api
  npm run cli api --target zach-host-1 --code AB12-CD34
  npm run cli -- --mode api --target zach-host-1 --code AB12-CD34

API Endpoints (api mode):
  GET  /v1/status          Connection and paired hosts status
  GET  /v1/hosts          List paired hosts
  POST /v1/pair            Pair/connect to a host {hostId, pairingCode}
  POST /v1/unpair          Unpair/disconnect from a host {hostId}
  POST /v1/messages        Anthropic-style streaming inference
  POST /v1/chat/completions OpenAI-style streaming inference
  GET  /v1/models          List available models
`);
}

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  printHelp();
  process.exit(0);
}

const args = [...rawArgs];

if (args.length > 0 && (args[0] === 'api' || args[0] === 'interactive')) {
  MODE = args.shift() as typeof MODE;
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--target' && args[i + 1])       { TARGET_PHONE_ID = args[++i]; }
  else if (arg === '--code' && args[i + 1])     { PAIRING_CODE    = args[++i]; }
  else if (arg === '--mode' && args[i + 1])     { MODE            = args[++i] as typeof MODE; }
  else if (!arg.startsWith('--') && !TARGET_PHONE_ID) { TARGET_PHONE_ID = arg; }
  else if (!arg.startsWith('--') && !PAIRING_CODE)    { PAIRING_CODE    = arg; }
}

if (!['interactive', 'api'].includes(MODE)) {
  console.error(`❌ Invalid mode: ${MODE}`);
  printHelp();
  process.exit(1);
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

async function promptForTargetAndCode(): Promise<{ target: string; code: string }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    let target = '';

    const askTarget = () => {
      rl.question('📱 Enter host ID (xxxx-xxxx): ', (answer) => {
        const normalized = normalizeTarget(answer);
        if (!isValidTarget(normalized)) {
          console.log('❌ Invalid format. Expected: xxxx-xxxx (hex, e.g. ab12-34cd)');
          return askTarget();
        }
        target = normalized;
        askCode();
      });
    };

    const askCode = () => {
      rl.question('🔑 Enter pairing code (XXXX-XXXX): ', (answer) => {
        const normalized = normalizeCode(answer);
        if (!isValidCode(normalized)) {
          console.log('❌ Invalid format. Expected: XXXX-XXXX (e.g. AB12-CD34)');
          return askCode();
        }
        rl.close();
        resolve({ target, code: normalized });
      });
    };

    askTarget();
  });
}

// ─── Signal handling ──────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  stopClient(pairedHosts);
  process.exit(0);
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  loadPairedHosts(pairedHosts);

  if (MODE === 'api') {
    console.log('⚙️ Mode: API');
    startApiMode(pairedHosts, MODE, startInteractiveMode, INITIATOR_ID, SIGNAL_SERVER);

    if (TARGET_PHONE_ID && PAIRING_CODE) {
      const normalizedId   = normalizeTarget(TARGET_PHONE_ID);
      const normalizedCode = normalizeCode(PAIRING_CODE);

      if (isValidTarget(normalizedId) && isValidCode(normalizedCode)) {
        console.log(`🎯 Auto-connecting to: ${normalizedId}`);
        pairedHosts.set(normalizedId, {
          id: normalizedId,
          pairingCode: normalizedCode,
          connected: false,
          lastConnected: null,
          connectedAt: null,
        });
        savePairedHosts(pairedHosts);
        await startClient(normalizedId, normalizedCode, pairedHosts, MODE, startInteractiveMode, SIGNAL_SERVER, INITIATOR_ID);
      } else {
        console.error('❌ Invalid target or code format');
      }
    }
  } else {
    console.log('⚙️ Mode: Interactive');

    let target = TARGET_PHONE_ID;
    let code   = PAIRING_CODE;

    if (!target || !code) {
      const result = await promptForTargetAndCode();
      target = result.target;
      code   = result.code;
    } else {
      target = normalizeTarget(target);
      code   = normalizeCode(code);

      if (!isValidTarget(target) || !isValidCode(code)) {
        console.error('❌ Invalid target or code format');
        process.exit(1);
      }
    }

    console.log(`🎯 Target: ${target}`);
    console.log(`🔑 Code: ${code}`);

    await startClient(target, code, pairedHosts, MODE, startInteractiveMode, SIGNAL_SERVER, INITIATOR_ID);
  }
}

bootstrap();