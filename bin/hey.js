#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm } from '@inquirer/prompts';
import Config from '../src/config.js';
import Logger from '../src/logger.js';
import { applyDefaultBypassArgs } from '../src/args.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0];
const logger = new Logger('hey');

function showHelp() {
  console.log(`
HeyAgent: Telegram bridge for Claude Code and Codex.

Usage:
  hey claude [provider-args...] [--new] [--session <session-id>]
  hey codex [provider-args...] [--new] [--session <session-id>]
  hey status
  hey reset              Reset Telegram setup (bot token + chat pairing)
  hey --version          Show version number

Examples:
  hey claude                           (resumes latest session)
  hey codex                            (resumes latest session)
  hey claude --new                     (creates new session)
  hey codex --new                      (creates new session)
  hey claude --session <session-id>    (resumes given session)
  hey claude --model sonnet
  hey codex --model gpt-5-codex

See more: https://heyagent.dev
`);
}

function parseModelShorthand(provider, providerArgs) {
  const args = Array.isArray(providerArgs) ? [...providerArgs] : [];
  if (args.length !== 1) {
    return args;
  }

  const token = String(args[0] || '').trim();
  if (!token || token.startsWith('-')) {
    return args;
  }

  if (provider === 'claude' || provider === 'codex') {
    return ['--model', token];
  }

  return args;
}

function extractRuntimeOptions(providerArgs) {
  const args = Array.isArray(providerArgs) ? [...providerArgs] : [];
  const cleaned = [];
  let sessionId = '';
  let startMode = 'auto';

  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || '').trim();
    if (!value) {
      continue;
    }

    if (value === '--new') {
      if (startMode !== 'auto' && startMode !== 'new') {
        throw new Error('Use only one startup mode: --new OR --resume/--continue');
      }
      startMode = 'new';
      continue;
    }

    if (value === '--resume' || value === '--continue') {
      if (startMode !== 'auto' && startMode !== 'resume') {
        throw new Error('Use only one startup mode: --new OR --resume/--continue');
      }
      startMode = 'resume';
      continue;
    }

    if (value === '--session') {
      const next = String(args[index + 1] || '').trim();
      if (!next) {
        throw new Error(`Missing value for ${value}`);
      }
      sessionId = next;
      index += 1;
      continue;
    }

    if (value.startsWith('--session=')) {
      const parsed = value.slice('--session='.length).trim();
      if (!parsed) {
        throw new Error('Missing value for --session');
      }
      sessionId = parsed;
      continue;
    }

    if (value === '--keep-awake' || value === '--no-keep-awake') {
      throw new Error(`${value} is not a valid HeyAgent option. Sleep prevention is always on while HeyAgent is running.`);
    }

    cleaned.push(value);
  }

  return {
    providerArgs: cleaned,
    sessionId: sessionId || null,
    startMode,
  };
}

function maskToken(token) {
  const value = String(token || '').trim();
  if (!value) {
    return 'not set';
  }

  const colonIndex = value.indexOf(':');
  if (colonIndex <= 0) {
    if (value.length <= 10) {
      return `${value.slice(0, 2)}...`;
    }
    return `${value.slice(0, 4)}...${value.slice(-2)}`;
  }

  const prefix = value.slice(0, colonIndex);
  const suffix = value.slice(colonIndex + 1);
  const suffixMasked = suffix.length <= 6 ? `${suffix.slice(0, 2)}...` : `${suffix.slice(0, 3)}...${suffix.slice(-3)}`;
  return `${prefix}:${suffixMasked}`;
}

function showStatus(config) {
  const paired = config.isPaired();
  const provider = config.provider;
  const providerArgs = provider === 'codex' ? config.codexArgs : provider === 'claude' ? config.claudeArgs : [];
  const currentSession =
    provider === 'codex'
      ? config.codexLastSessionId
      : provider === 'claude'
        ? config.claudeLastSessionId
        : config.codexLastSessionId || config.claudeLastSessionId;

  console.log(`Provider: ${provider || 'not set'}`);
  console.log(`Telegram bot: ${config.telegramBotUsername ? `@${config.telegramBotUsername}` : 'not set'}`);
  console.log(`Telegram token: ${maskToken(config.telegramBotToken)}`);
  console.log(`Paired chat: ${paired ? config.telegramChatId : 'not paired'}`);
  console.log(`Paired user: ${paired ? config.telegramChatUserId || 'unknown' : 'not paired'}`);
  console.log(`Args: ${providerArgs.length > 0 ? providerArgs.join(' ') : '(none)'}`);
  console.log('Sleep prevention: always on while HeyAgent is running (availability checked at bridge startup)');
  console.log(`Session: ${currentSession || '-'}`);
}

async function main() {
  if (!command) {
    showHelp();
    return;
  }

  if (command === '--version' || command === '-v') {
    const packageJsonPath = path.join(__dirname, '../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    console.log(packageJson.version);
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    showHelp();
    return;
  }

  if (command === 'status') {
    const config = new Config();
    showStatus(config);
    return;
  }

  if (command === 'reset' || command === 'unpair') {
    const config = new Config();
    const force = args.includes('--yes') || args.includes('-y');

    const details = [
      `bot: ${config.telegramBotUsername ? `@${config.telegramBotUsername}` : 'not set'}`,
      `token: ${maskToken(config.telegramBotToken)}`,
      `chat: ${config.telegramChatId || 'not paired'}`,
    ].join(', ');

    let accepted = force;
    if (!accepted) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        accepted = await confirm({
          message: `Reset Telegram setup (${details})?`,
          default: false,
        });
      } else {
        console.log('Reset needs confirmation. Re-run with --yes in non-interactive mode.');
        return;
      }
    }

    if (!accepted) {
      console.log('Reset cancelled.');
      return;
    }

    config.clearPairing({ keepBotToken: false });
    config.set('provider', null);
    console.log('Telegram setup reset. Bot token and chat pairing removed.');
    return;
  }

  if (command === 'claude' || command === 'codex') {
    const config = new Config();
    const cliProviderArgs = args.slice(1);
    const extracted = extractRuntimeOptions(cliProviderArgs);
    if (extracted.startMode === 'new' && extracted.sessionId) {
      throw new Error('Cannot combine --new with --session');
    }
    const savedProviderArgs = command === 'claude' ? config.claudeArgs : config.codexArgs;
    const providerArgs = extracted.providerArgs.length > 0 ? extracted.providerArgs : savedProviderArgs;
    const normalizedProviderArgs = parseModelShorthand(command, providerArgs);
    const effectiveArgs = applyDefaultBypassArgs(command, normalizedProviderArgs);
    config.setMany({
      provider: command,
      claudeArgs: command === 'claude' ? effectiveArgs.providerArgs : config.claudeArgs,
      codexArgs: command === 'codex' ? effectiveArgs.providerArgs : config.codexArgs,
    });

    if (effectiveArgs.defaultBypassApplied) {
      console.log(`[warning] ${command}: default bypass mode enabled for non-interactive execution.`);
    }

    const { default: Bridge } = await import('../src/bridge.js');
    const bridge = new Bridge(config, command, effectiveArgs.providerArgs, {
      initialSessionId: extracted.sessionId,
      startMode: extracted.startMode,
    });
    await bridge.start();
    return;
  }

  console.log(`Unknown command: ${command}`);
  showHelp();
}

main().catch(error => {
  logger.error(error.message || String(error));
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
