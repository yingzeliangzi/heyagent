import { spawn } from 'node:child_process';

const STOP_TIMEOUT_MS = 1500;

function notifyWarn(logger, message) {
  if (logger && typeof logger.warn === 'function') {
    logger.warn(message);
  }
}

function buildInactiveState({ enabled, backend, reason }) {
  return {
    enabled,
    active: false,
    backend,
    reason,
    async stop() {
      // No-op for unavailable or disabled backends.
    },
  };
}

function describeExit(code, signal) {
  if (signal) {
    return `signal ${signal}`;
  }
  if (Number.isInteger(code)) {
    return `code ${code}`;
  }
  return 'unknown';
}

function startChildBackend(command, args, backend, logger) {
  let child = null;

  try {
    child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (error) {
    const reason = `${command} unavailable: ${error.message}`;
    notifyWarn(logger, `Sleep prevention disabled (${reason}).`);
    return buildInactiveState({
      enabled: true,
      backend,
      reason,
    });
  }

  let stopping = false;
  const state = {
    enabled: true,
    active: true,
    backend,
    reason: null,
    async stop() {
      if (!child || stopping) {
        return;
      }

      if (child.exitCode !== null || child.killed) {
        state.active = false;
        state.reason = 'stopped';
        child = null;
        return;
      }

      stopping = true;

      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore kill failures.
          }
          resolve();
        }, STOP_TIMEOUT_MS);

        const finalize = () => {
          clearTimeout(timeout);
          resolve();
        };

        child.once('exit', finalize);
        child.once('error', finalize);

        try {
          child.kill('SIGTERM');
        } catch {
          finalize();
        }
      });

      state.active = false;
      state.reason = 'stopped';
      child = null;
    },
  };

  if (!child.pid) {
    state.active = false;
    state.reason = `${command} failed to start`;
    notifyWarn(logger, `Sleep prevention disabled (${state.reason}).`);
  }

  child.on('error', error => {
    if (stopping) {
      return;
    }
    state.active = false;
    state.reason = `${backend} failed: ${error.message}`;
    notifyWarn(logger, `Sleep prevention backend error (${state.reason}).`);
  });

  child.on('exit', (code, signal) => {
    if (stopping) {
      return;
    }
    state.active = false;
    state.reason = `${backend} exited (${describeExit(code, signal)})`;
    notifyWarn(logger, `Sleep prevention backend stopped unexpectedly (${state.reason}).`);
  });

  return state;
}

function startWindowsBackend(logger) {
  const script = [
    '$signature = \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);\';',
    'Add-Type -MemberDefinition $signature -Name NativeSleep -Namespace HeyAgent;',
    '$ES_CONTINUOUS = 0x80000000;',
    '$ES_SYSTEM_REQUIRED = 0x00000001;',
    'while ($true) {',
    '  [HeyAgent.NativeSleep]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null;',
    '  Start-Sleep -Seconds 30;',
    '}',
  ].join(' ');

  return startChildBackend(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    'powershell',
    logger
  );
}

export function startSleepInhibitor(options = {}) {
  const enabled = options.enabled !== false;
  const logger = options.logger || null;

  if (!enabled) {
    return buildInactiveState({
      enabled: false,
      backend: 'disabled',
      reason: 'disabled by configuration',
    });
  }

  if (process.platform === 'darwin') {
    return startChildBackend('caffeinate', ['-i', '-w', String(process.pid)], 'caffeinate', logger);
  }

  if (process.platform === 'linux') {
    return startChildBackend(
      'systemd-inhibit',
      ['--what=idle:sleep', '--mode=block', '--who=heyagent', '--why=Keep HeyAgent bridge running', 'sleep', 'infinity'],
      'systemd-inhibit',
      logger
    );
  }

  if (process.platform === 'win32') {
    return startWindowsBackend(logger);
  }

  const reason = `unsupported platform: ${process.platform}`;
  notifyWarn(logger, `Sleep prevention disabled (${reason}).`);
  return buildInactiveState({
    enabled: true,
    backend: process.platform,
    reason,
  });
}

export function formatSleepInhibitorStatus(state) {
  if (!state || state.enabled === false) {
    return 'disabled';
  }

  if (state.active) {
    return `active (${state.backend})`;
  }

  return state.reason ? `unavailable (${state.reason})` : 'unavailable';
}
