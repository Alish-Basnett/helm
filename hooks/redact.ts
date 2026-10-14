// v0.26: secret redaction. Everything the mod sends to the hub or writes to disk goes through redact() first, so a key typed into
// a shell command, an Agent prompt or a report never lands in the event log. A match is replaced by [redacted]; the surrounding
// text (the name, the flag, the URL host) stays, so the line still reads. Plain code, paths and prose are left alone: after a
// secret-looking name only a type word (`password: string`), a call (`token = getToken()`), a dotted path or a placeholder is
// kept; any other value is redacted, plain words (`password=admin`) included.

const R = '[redacted]'

const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g
const AWS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
const AWS_SECRET = /((?:aws[_-]?)?secret[_-]?(?:access[_-]?)?key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi
const GITHUB = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g
const SLACK = /\bxox[abpr]-[A-Za-z0-9-]{10,}/g
const SK = /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g
const AUTH_HEADER = /(\bAuthorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s"',;]+/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g
const FLAG = /(--(?:[a-z]+-)*(?:password|passwd|pwd|token|secret|api-key|access-key|client-secret)(?:=|\s+)["']?)(?!-)[^\s"']+/gi
const CURL_USER = /(\bcurl\b[^\n|;&]*?\s(?:-u|--user)(?:\s+|=)?)(["']?)[^\s"':]+:[^\s"']+\2/g
const MYSQL_P = /(\b[mM]ysql(?:dump|admin|import)?\b[^\n|;&]*?\s-p)(?!\s)[^\s"']+/g
const SSHPASS = /(\bsshpass\s+-p\s*)\S+/gi
const IDENTIFIED = /(\bIDENTIFIED\s+BY\s+)(['"])[^'"]*\2/gi
// name = value, name: value, "name":"value". The name is judged in isSecretName(), the value in looksLikeSecret().
const PAIR = /(["']?)([A-Za-z][A-Za-z0-9_.-]{1,60})\1(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&(){}\]]+)(\()?/g

const WORDS = new Set(['password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'accesskey', 'privatekey', 'secretkey', 'clientsecret', 'passphrase'])
const TAILS = ['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'accesskey', 'privatekey', 'secretkey', 'clientsecret']

function isSecretName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.-]+/).filter(Boolean)
  const last = words.at(-1) ?? ''
  if (WORDS.has(last)) return true
  const two = words.slice(-2).join('')
  if (WORDS.has(two)) return true
  return TAILS.some(t => last.endsWith(t) && last.length > t.length) // PGPASSWORD, csrftoken
}

const TYPEISH = /^(?:string|number|boolean|null|undefined|true|false|none|nil|required|optional|str|int|bytes|any|object|void|never|unknown)$/i

function looksLikeSecret(raw: string, name: string, call: boolean): boolean {
  const quoted = /^["']/.test(raw)
  const v = quoted ? raw.slice(1, -1) : raw
  if (!v || v.includes('redacted')) return false
  if (/^[<${%*(\[=]/.test(v) || /^x+$/i.test(v) || /^(?:process|os|env|config|req|this|self|ctx|import)\./i.test(v)) return false // placeholder, operator or code
  if (quoted) return !TYPEISH.test(v)
  if (call || TYPEISH.test(v) || v.toLowerCase() === name.toLowerCase()) return false // getToken(), a type, the name itself
  if (v.length < 4) return false
  if (/^(?:\/|\.{1,2}\/|~\/)/.test(v)) return false // a path
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(v)) return false // a.b.c
  if (/^\d+$/.test(v) && /tokens?$/i.test(name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_.-]+/).at(-1) ?? '')) return false // input_token: 12345 is a count
  return true
}

/** Replace secrets in a string with [redacted]. Idempotent. */
export function redact(text: string): string {
  if (typeof text !== 'string' || text.length < 6) return text
  let s = text
  if (s.includes('-----BEGIN')) s = s.replace(PEM, R)
  s = s.replace(URL_CREDS, `$1:${R}@`)
  s = s.replace(JWT, R).replace(AWS_KEY_ID, R).replace(GITHUB, R).replace(SLACK, R)
  s = s.replace(SK, m => (/\d/.test(m) ? R : m))
  s = s.replace(AWS_SECRET, `$1${R}`)
  s = s.replace(AUTH_HEADER, (m, pre) => (m.includes('redacted') || /^[A-Za-z]+$/.test(m.slice(pre.length)) ? m : `${pre}${R}`))
  s = s.replace(BEARER, m => (/\d/.test(m) || m.length > 30 ? `Bearer ${R}` : m))
  s = s.replace(CURL_USER, `$1$2${R}$2`).replace(FLAG, `$1${R}`).replace(MYSQL_P, `$1${R}`).replace(SSHPASS, `$1${R}`).replace(IDENTIFIED, `$1$2${R}$2`)
  s = s.replace(PAIR, (m, q, name, sep, value, call) => (isSecretName(name) && looksLikeSecret(value, name, !!call) ? `${q}${name}${q}${sep}${/^["']/.test(value) ? `${value[0]}${R}${value[0]}` : R}` : m))
  return s
}

/** redact() over every string of a JSON-like value (a copy; the input is untouched). */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redact(value) as T
  if (!value || typeof value !== 'object') return value
  if (depth > 8) return R as T // too deep to walk: never let an unchecked branch through
  if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1)) as T
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1)
  return out as T
}
