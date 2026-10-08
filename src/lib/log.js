// Structured logging. JSON lines in production (LOG_FORMAT=json, the default when NODE_ENV=production),
// readable text locally. Secrets (passwords in URLs, tokens, cookies) are redacted before anything is written.
const JSON_LOGS = (process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'text')) === 'json';

export function redact(s) {
  return String(s)
    .replace(/(\w+:\/\/[^:\s/]+:)[^@\s]+@/g, '$1***@')                      // user:password@ in URLs
    .replace(/((?:password|secret|token|authorization|cookie)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, '$1***')
    .replace(/(AWS4-HMAC-SHA256\s+Credential=)[^,\s]+/g, '$1***');
}

function write(level, args) {
  const [first, ...rest] = args;
  const fields = rest.length && typeof rest[rest.length - 1] === 'object' && !(rest[rest.length - 1] instanceof Error) ? rest.pop() : {};
  const err = rest.find((x) => x instanceof Error) || (first instanceof Error ? first : null);
  const msg = redact([first, ...rest].filter((x) => !(x instanceof Error)).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (JSON_LOGS) {
    const line = { t: new Date().toISOString(), level, msg, ...fields };
    if (err) line.err = redact(err.stack || err.message);
    out.write(JSON.stringify(line) + '\n');
  } else {
    const extra = Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
    out.write(`${level === 'info' ? '' : level.toUpperCase() + ' '}${msg}${extra}${err ? '\n' + redact(err.stack || err.message) : ''}\n`);
  }
}

export const log = {
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
};
export const silent = { info() {}, warn() {}, error() {} };
