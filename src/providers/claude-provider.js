import { runProcess } from '../process-runner.js';

function pickValue(candidate) {
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function extractTextFromContent(content) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    if (typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim());
      continue;
    }

    if (typeof block.content === 'string' && block.content.trim()) {
      parts.push(block.content.trim());
    }
  }

  return parts.join('\n').trim();
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    return null;
  }

  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }

    try {
      return JSON.parse(line);
    } catch {
      // Keep scanning older lines.
    }
  }

  return null;
}

function extractResponseText(result) {
  if (!result || typeof result !== 'object') {
    return '';
  }

  return (
    pickValue(result.result) ||
    pickValue(result.output) ||
    pickValue(result.text) ||
    pickValue(result.message) ||
    extractTextFromContent(result.content) ||
    extractTextFromContent(result.message?.content) ||
    extractTextFromContent(result.result?.content)
  );
}

export async function runClaudePrompt(prompt, options = {}) {
  const resume = Boolean(options.resume);
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
  const sessionId = String(options.sessionId || '').trim();
  const onSessionId = typeof options.onSessionId === 'function' ? options.onSessionId : null;
  const cwd = options.cwd || process.cwd();
  const abortSignal = options.abortSignal || null;

  const args = [...extraArgs, '-p', '--output-format', 'json'];
  if (resume) {
    if (sessionId) {
      args.push('--resume', sessionId);
    } else {
      args.push('--continue');
    }
  }
  args.push('--', prompt);

  const result = await runProcess('claude', args, {
    cwd,
    timeoutMs: 20 * 60 * 1000,
    signal: abortSignal,
  });

  const output = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const parsed = parseJsonOutput(output);
  const parsedSessionId =
    pickValue(parsed?.session_id) || pickValue(parsed?.sessionId) || pickValue(parsed?.result?.session_id) || pickValue(parsed?.result?.sessionId);
  if (parsedSessionId && onSessionId) {
    onSessionId(parsedSessionId);
  }
  const parsedText = extractResponseText(parsed);

  if (result.code !== 0 && !output && !parsedText) {
    throw new Error(stderr || `Claude exited with code ${result.code}`);
  }

  return parsedText || output || stderr || 'No response from Claude.';
}
