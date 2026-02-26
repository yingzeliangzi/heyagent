import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BOTFATHER_URL = 'https://t.me/BotFather';

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isLikelyToken(token) {
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(String(token || '').trim());
}

function readBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', reject);
  });
}

function waitForTryCloudflareUrl(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const urlPattern = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;
    let settled = false;
    let stderrTail = '';

    const finish = (error, url) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);

      if (error) {
        reject(error);
        return;
      }
      resolve(url);
    };

    const onData = chunk => {
      const text = chunk.toString();
      const combined = `${stderrTail}${text}`;
      stderrTail = combined.slice(-800);
      const match = combined.match(urlPattern);
      if (match) {
        finish(null, match[1]);
      }
    };

    const onError = error => {
      if (error && error.code === 'ENOENT') {
        finish(new Error('cloudflared binary was not found. Install cloudflared or use manual fallback setup.'));
        return;
      }
      finish(error instanceof Error ? error : new Error(String(error || 'Tunnel failed')));
    };

    const onExit = code => {
      finish(new Error(`cloudflared exited before URL was ready (code ${code ?? 'unknown'}). ${stderrTail.trim()}`));
    };

    const timeout = setTimeout(() => {
      finish(new Error('Timed out while waiting for Cloudflare tunnel URL.'));
    }, timeoutMs);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

function stopProcess(child) {
  if (!child || child.killed) {
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore kill failures.
  }
}

function stopServer(server) {
  return new Promise(resolve => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function resolveCloudflaredCommand() {
  const envOverride = String(process.env.HEYAGENT_CLOUDFLARED_BIN || '').trim();
  if (envOverride) {
    return { command: envOverride, useNode: false };
  }

  try {
    const packageJsonPath = require.resolve('cloudflared/package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const packageDir = path.dirname(packageJsonPath);
    const binField = packageJson.bin;
    const relativeBin =
      typeof binField === 'string' ? binField : binField && typeof binField === 'object' ? binField.cloudflared || Object.values(binField)[0] : null;

    if (relativeBin) {
      const absoluteBin = path.resolve(packageDir, relativeBin);
      return { command: absoluteBin, useNode: absoluteBin.endsWith('.js') };
    }
  } catch {
    // Fall through to PATH lookup.
  }

  return { command: 'cloudflared', useNode: false };
}

function renderOnboardingPage(basePath) {
  const basePathJson = JSON.stringify(basePath);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HeyAgent Setup</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --line: #e2e8f0;
      --accent: #111827;
      --ok-bg: #ecfdf3;
      --ok-text: #166534;
      --err-bg: #fee2e2;
      --err-text: #991b1b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .wrap {
      max-width: 540px;
      margin: 0 auto;
      min-height: 100dvh;
      padding: 28px 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .head { text-align: center; }
    .title { margin: 0; font-size: 24px; }
    .sub { margin: 6px 0 0; color: var(--muted); font-size: 14px; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 18px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
    }
    .dots { display: flex; justify-content: center; gap: 8px; margin-top: 4px; }
    .dot {
      width: 8px; height: 8px; border-radius: 999px;
      background: #cbd5e1; transition: all .2s ease;
    }
    .dot.active { width: 22px; background: var(--accent); }
    .step { display: none; }
    .step.active { display: block; }
    h2 { margin: 0 0 8px; font-size: 19px; }
    p { margin: 0 0 10px; line-height: 1.45; color: var(--muted); }
    .btn {
      display: inline-block;
      width: 100%;
      margin-top: 8px;
      text-decoration: none;
      border: 0;
      border-radius: 10px;
      background: var(--accent);
      color: white;
      padding: 12px 14px;
      text-align: center;
      font-size: 15px;
      cursor: pointer;
    }
    .btn.secondary {
      background: #e2e8f0;
      color: #0f172a;
    }
    .btn[disabled] {
      opacity: .45;
      pointer-events: none;
    }
    input[type=text] {
      width: 100%;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      font-size: 15px;
      padding: 12px;
      margin-top: 8px;
    }
    .msg {
      margin-top: 10px;
      border-radius: 10px;
      padding: 10px;
      font-size: 14px;
      display: none;
    }
    .msg.show { display: block; }
    .msg.ok { background: var(--ok-bg); color: var(--ok-text); }
    .msg.err { background: var(--err-bg); color: var(--err-text); }
    .nav {
      margin-top: auto;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .done {
      text-align: center;
    }
    .done strong { display: block; font-size: 18px; margin-bottom: 6px; }
    .small { font-size: 12px; color: var(--muted); }
  </style>
</head>
<body>
  <main class="wrap">
    <header class="head">
      <h1 class="title">HeyAgent Setup</h1>
      <p class="sub">One-time onboarding on this device</p>
      <div class="dots">
        <div id="dot0" class="dot active"></div>
        <div id="dot1" class="dot"></div>
        <div id="dot2" class="dot"></div>
      </div>
    </header>

    <section class="card">
      <article id="step0" class="step active">
        <h2>Step 1: Create your bot</h2>
        <p>Open BotFather and create a bot with <code>/newbot</code>, or fetch token for an existing bot with <code>/token</code>.</p>
        <a class="btn" href="${escapeHtml(BOTFATHER_URL)}" target="_blank" rel="noopener">Open BotFather</a>
      </article>

      <article id="step1" class="step">
        <h2>Step 2: Submit bot token</h2>
        <p>Paste the HTTP API token from BotFather.</p>
        <form id="tokenForm">
          <input id="tokenInput" type="text" autocomplete="off" spellcheck="false" placeholder="123456789:AA..." required>
          <button class="btn" type="submit">Submit Token</button>
        </form>
        <div id="tokenMsg" class="msg"></div>
      </article>

      <article id="step2" class="step">
        <h2>Step 3: Connect chat</h2>
        <p>Open your bot and press <strong>START</strong> to pair this CLI session.</p>
        <a id="pairBtn" class="btn" href="#" target="_blank" rel="noopener" disabled>Open Bot Chat</a>
        <p class="small">If deep link fails, open your bot manually in Telegram and press START.</p>
        <div id="pairMsg" class="msg"></div>
      </article>

      <article id="done" class="step done">
        <strong>Setup complete</strong>
        <p>You can return to terminal now.</p>
      </article>
    </section>

    <nav id="nav" class="nav">
      <button id="backBtn" class="btn secondary" type="button">Back</button>
      <button id="nextBtn" class="btn" type="button">Next</button>
    </nav>
  </main>

  <script>
    const BASE = ${basePathJson};
    const state = {
      tokenStatus: 'waiting',
      tokenMessage: '',
      pairLink: null,
      pairingStatus: '',
      paired: false,
      error: null,
      chatId: null
    };
    let step = 0;
    let polling = null;

    function byId(id) { return document.getElementById(id); }

    function setMessage(el, text, kind) {
      if (!text) {
        el.className = 'msg';
        el.textContent = '';
        return;
      }
      el.className = 'msg show ' + (kind || '');
      el.textContent = text;
    }

    function applyStep() {
      const total = 3;
      for (let i = 0; i < total; i += 1) {
        byId('step' + i).classList.toggle('active', i === step);
        byId('dot' + i).classList.toggle('active', i === step);
      }

      const done = state.paired;
      byId('done').classList.toggle('active', done);
      byId('nav').style.display = done ? 'none' : 'grid';

      const backBtn = byId('backBtn');
      const nextBtn = byId('nextBtn');
      backBtn.disabled = step === 0;
      nextBtn.textContent = step >= total - 1 ? 'Stay' : 'Next';
    }

    function updateFromState(next) {
      Object.assign(state, next || {});

      if (state.error) {
        setMessage(byId('tokenMsg'), state.error, 'err');
        setMessage(byId('pairMsg'), state.error, 'err');
      } else {
        if (state.tokenStatus === 'invalid') {
          setMessage(byId('tokenMsg'), state.tokenMessage || 'Token rejected. Try again.', 'err');
        } else if (state.tokenMessage) {
          setMessage(byId('tokenMsg'), state.tokenMessage, 'ok');
        } else {
          setMessage(byId('tokenMsg'), '', '');
        }

        if (state.pairingStatus) {
          const kind = state.paired ? 'ok' : '';
          setMessage(byId('pairMsg'), state.pairingStatus, kind);
        } else {
          setMessage(byId('pairMsg'), '', '');
        }
      }

      const pairBtn = byId('pairBtn');
      if (state.pairLink) {
        pairBtn.href = state.pairLink;
        pairBtn.removeAttribute('disabled');
      } else {
        pairBtn.setAttribute('disabled', 'true');
        pairBtn.href = '#';
      }

      if (state.tokenStatus === 'valid' && step < 2) {
        step = 2;
      }

      if (state.paired) {
        step = 2;
      }

      applyStep();
    }

    async function pollState() {
      try {
        const res = await fetch(BASE + '/api/state', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        updateFromState(data);
      } catch {
        // Ignore transient polling failures.
      }
    }

    byId('backBtn').addEventListener('click', () => {
      if (step > 0) {
        step -= 1;
        applyStep();
      }
    });

    byId('nextBtn').addEventListener('click', () => {
      if (step === 1 && state.tokenStatus !== 'valid') {
        setMessage(byId('tokenMsg'), 'Submit a valid token first.', 'err');
        return;
      }
      if (step < 2) {
        step += 1;
        applyStep();
      }
    });

    byId('tokenForm').addEventListener('submit', async event => {
      event.preventDefault();
      const tokenValue = byId('tokenInput').value.trim();
      if (!tokenValue) {
        setMessage(byId('tokenMsg'), 'Token is required.', 'err');
        return;
      }

      setMessage(byId('tokenMsg'), 'Submitting token...', '');

      try {
        const res = await fetch(BASE + '/api/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tokenValue }),
        });

        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = payload.error || 'Failed to submit token.';
          setMessage(byId('tokenMsg'), err, 'err');
          return;
        }

        byId('tokenInput').value = '';
        const info = payload.message || 'Token submitted. Waiting for validation...';
        setMessage(byId('tokenMsg'), info, '');
      } catch {
        setMessage(byId('tokenMsg'), 'Network error while sending token.', 'err');
      }
    });

    applyStep();
    pollState();
    polling = setInterval(pollState, 1500);

    window.addEventListener('beforeunload', () => {
      if (polling) clearInterval(polling);
    });
  </script>
</body>
</html>`;
}

async function createOnboardingSession(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20 * 60 * 1000;
  const onReady = typeof options.onReady === 'function' ? options.onReady : null;

  const sessionId = crypto.randomBytes(18).toString('hex');
  const basePath = `/${sessionId}`;
  const state = {
    tokenStatus: 'waiting',
    tokenMessage: '',
    pairLink: null,
    pairingStatus: '',
    paired: false,
    chatId: null,
    error: null,
  };

  let closed = false;
  let cloudflared = null;
  let server = null;
  let tunnelUrl = null;
  const tokenQueue = [];
  const tokenWaiters = [];

  const popToken = () => {
    if (tokenQueue.length > 0) {
      return Promise.resolve(tokenQueue.shift());
    }

    return new Promise((resolve, reject) => {
      tokenWaiters.push({ resolve, reject });
    });
  };

  const pushToken = token => {
    if (tokenWaiters.length > 0) {
      const waiter = tokenWaiters.shift();
      waiter.resolve(token);
      return;
    }
    tokenQueue.push(token);
  };

  const rejectWaiters = error => {
    while (tokenWaiters.length > 0) {
      const waiter = tokenWaiters.shift();
      waiter.reject(error);
    }
  };

  const setState = patch => {
    Object.assign(state, patch);
  };

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const htmlPath = url.pathname === basePath || url.pathname === `${basePath}/`;
    const statePath = url.pathname === `${basePath}/api/state`;
    const tokenPath = url.pathname === `${basePath}/api/token`;

    if (req.method === 'GET' && htmlPath) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(renderOnboardingPage(basePath));
      return;
    }

    if (req.method === 'GET' && statePath) {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(state));
      return;
    }

    if (req.method === 'POST' && tokenPath) {
      if (closed) {
        res.writeHead(410, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Session is closed.' }));
        return;
      }

      try {
        const rawBody = await readBody(req);
        const formBody = new URLSearchParams(rawBody);
        const token = String(formBody.get('token') || '').trim();

        if (!isLikelyToken(token)) {
          setState({
            tokenStatus: 'invalid',
            tokenMessage: 'Token format looks invalid.',
          });
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Token format looks invalid.' }));
          return;
        }

        setState({
          tokenStatus: 'received',
          tokenMessage: 'Token received. Validating...',
          error: null,
        });
        pushToken(token);

        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, message: 'Token submitted. Waiting for validation...' }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to read request.';
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    const localUrl = `http://127.0.0.1:${server.address()?.port}`;
    const tunnelArgs = ['tunnel', '--url', localUrl, '--no-autoupdate'];
    const tunnelBinary = resolveCloudflaredCommand();
    cloudflared = tunnelBinary.useNode
      ? spawn(process.execPath, [tunnelBinary.command, ...tunnelArgs], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(tunnelBinary.command, tunnelArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

    const baseTunnelUrl = await waitForTryCloudflareUrl(cloudflared, timeoutMs);
    tunnelUrl = `${baseTunnelUrl}${basePath}`;

    if (onReady) {
      onReady(tunnelUrl);
    }
  } catch (error) {
    closed = true;
    stopProcess(cloudflared);
    await stopServer(server);
    rejectWaiters(error instanceof Error ? error : new Error('Onboarding tunnel failed.'));
    throw error;
  }

  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    stopProcess(cloudflared);
    await stopServer(server);
    rejectWaiters(new Error('Onboarding session closed.'));
  };

  return {
    url: tunnelUrl,
    waitForToken: popToken,
    setTokenValidated(options2 = {}) {
      const bot = options2.botUsername ? `@${options2.botUsername}` : null;
      const message = options2.preconfigured ? `Token already configured${bot ? ` (${bot})` : ''}.` : `Token validated${bot ? ` (${bot})` : ''}.`;
      setState({
        tokenStatus: 'valid',
        tokenMessage: message,
        error: null,
      });
    },
    setTokenInvalid(message) {
      setState({
        tokenStatus: 'invalid',
        tokenMessage: message || 'Token was rejected. Try again.',
      });
    },
    setPairLink(link) {
      setState({
        pairLink: link || null,
        pairingStatus: link ? 'Open bot chat and press START to pair.' : state.pairingStatus,
      });
    },
    setPairingStatus(message) {
      setState({
        pairingStatus: String(message || ''),
      });
    },
    markPaired(details = {}) {
      setState({
        paired: true,
        chatId: details.chatId || null,
        pairingStatus: details.chatId ? `Paired successfully (chat ${details.chatId}).` : 'Paired successfully.',
        error: null,
      });
    },
    setError(message) {
      setState({
        error: String(message || 'Unexpected setup error'),
      });
    },
    close,
  };
}

export { createOnboardingSession };
