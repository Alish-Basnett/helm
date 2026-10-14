import { describe, expect, test } from 'claude-code/testing'
import { redact, redactDeep } from './redact'

// v0.26: every pattern redacts, and ordinary code, paths and prose are left exactly as they were.

const R = '[redacted]'

describe('redact: secrets', () => {
  const cases: [string, string, string][] = [
    ['AWS access key id', 'key AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE', `key ${R} and ${R}`],
    ['AWS secret key', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', `aws_secret_access_key = ${R}`],
    ['AWS secret key (JSON)', '{"SecretAccessKey":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}', `{"SecretAccessKey":"${R}"}`],
    ['Authorization header', 'curl -H "Authorization: Bearer abc123def456"', `curl -H "Authorization: ${R}"`],
    ['Authorization Basic', 'Authorization: Basic dXNlcjpwYXNz', `Authorization: ${R}`],
    ['bare Bearer token', 'send Bearer abc123def456ghi', `send Bearer ${R}`],
    ['JWT', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbU', `jwt ${R}`],
    ['PEM block', 'k\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----\nafter', `k\n${R}\nafter`],
    ['PEM block cut off by a clip', 'x -----BEGIN PRIVATE KEY-----\nMIIabc', `x ${R}`],
    ['GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789 gho_abcdefghijklmnopqrstuvwxyz0123456789', `${R} ${R}`],
    ['GitHub fine-grained token', 'github_pat_11ABCDEFG0abcdefghijklmnop', R],
    ['GitHub server/user tokens', 'ghs_abcdefghijklmnopqrstuvwxyz0123456789 ghu_abcdefghijklmnopqrstuvwxyz0123456789', `${R} ${R}`],
    ['Slack token', 'xoxb-123456789012-abcdefghij xoxp-123456789012-abcdefghij', `${R} ${R}`],
    ['OpenAI key', 'OPENAI sk-proj-abc123def456ghi789jkl012', `OPENAI ${R}`],
    ['Anthropic key', 'sk-ant-api03-abcDEF123456789012345678', R],
    ['mysql -p<pw>', 'mysql -u root -pS3cretPw mydb', `mysql -u root -p${R} mydb`],
    ['mysqldump -p<pw>', 'mysqldump -h db -u app -pS3cretPw > out.sql', `mysqldump -h db -u app -p${R} > out.sql`],
    ['--password=', 'psql --password=hunter2 x', `psql --password=${R} x`],
    ['--password value', 'tool --password hunter x', `tool --password ${R} x`],
    ['--token=', 'gh --token=abc --verbose', `gh --token=${R} --verbose`],
    ['sshpass', 'sshpass -p hunter ssh host', `sshpass -p ${R} ssh host`],
    ['IDENTIFIED BY', "CREATE USER a IDENTIFIED BY 'pw1'", `CREATE USER a IDENTIFIED BY '${R}'`],
    ['name=value (env)', 'DB_PASSWORD=Sup3r!pw npm start', `DB_PASSWORD=${R} npm start`],
    ['name=value (export)', 'export PGPASSWORD=pw1234', `export PGPASSWORD=${R}`],
    ['name: value (yaml)', 'api_key: abc123xyz', `api_key: ${R}`],
    ['header-style name', 'X-Api-Key: k9f8d7s6a5', `X-Api-Key: ${R}`],
    ['camelCase name', 'accessToken = "abc.def.ghi"', `accessToken = "${R}"`],
    ['"name":"value" (JSON)', '{"client_secret":"abcd1234","name":"x"}', `{"client_secret":"${R}","name":"x"}`],
    ['single-quoted value', "password: 'p@ss w0rd'", `password: '${R}'`],
    ['plain-word values after a secret name', 'PGPASSWORD=postgres DB_PASSWORD=supersecret password=admin token=abcdefgh', `PGPASSWORD=${R} DB_PASSWORD=${R} password=${R} token=${R}`],
    ['export of a word value', 'export API_TOKEN=mytokenvalue', `export API_TOKEN=${R}`],
    ['all-digit value after password', 'password=12345678', `password=${R}`],
    ['curl -u user:pass', 'curl -u admin:hunter2 https://x/y', `curl -u ${R} https://x/y`],
    ['curl --user "user:pass"', 'curl --user "bob:s3cret" https://x', `curl --user "${R}" https://x`],
    ['wget --http-password', 'wget --http-password=hunter x', `wget --http-password=${R} x`],
    ['URL with user:pass@', 'git clone https://bob:ghs3cr3t@github.com/o/r.git', `git clone https://bob:${R}@github.com/o/r.git`],
    ['postgres URL', 'DATABASE_URL=postgres://app:p4ss@db:5432/x', `DATABASE_URL=postgres://app:${R}@db:5432/x`],
  ]
  for (const [name, input, out] of cases) {
    test(name, async () => {
      expect(redact(input)).toBe(out)
    })
  }

  test('is idempotent', async () => {
    for (const [, input] of cases) {
      const once = redact(input)
      expect(redact(once)).toBe(once)
    }
  })
})

describe('redact: ordinary text is left alone', () => {
  const same = [
    'password: string',
    'const token = getToken()',
    'const { password } = req.body',
    'if (password === confirm) {',
    'token: tokens.access',
    'password = process.env.PW',
    'token: <your token>',
    'password: ${PASSWORD}',
    'passwordHash: hash',
    'tokenizer=bert-base-uncased',
    'bypass=true compass: north',
    'timeout=30000 retries=3 key=value',
    '/Users/me/secrets/file.txt',
    'secret_file=/etc/s/x',
    'pwd=/Users/me/proj',
    'git commit -m "fix password reset flow"',
    'Bearer authentication is used here',
    'Authorization: required',
    'risk-assessment-for-new-things-in-the-pipeline',
    'sk-learn is a library',
    'git@github.com:org/repo.git',
    'ssh://git@github.com/org/repo',
    'npm i foo@1.2.3 http://localhost:3000/a',
    'mysql -u root -p mydb',
    'AKIA is a prefix, not a key',
    'src/hooks/register.ts:1271',
    'cd /w/proj && node --test hub/test/',
    'The token budget is 8000 tokens per request.',
    'pass: 1234 fail: 0',
    'input_token: 12345 output_token: 678',
    'tokens: 99999',
    'password: string',
    'token: String',
    'user: boolean',
    'password: Optional',
    'const token = getToken()',
    'docker run -u 1000:1000 img',
    'curl -u 1000 https://x',
  ]
  for (const t of same) {
    test(`unchanged: ${t.slice(0, 50)}`, async () => {
      expect(redact(t)).toBe(t)
    })
  }
})

describe('redactDeep', () => {
  test('redacts every string in nested data and leaves other values and the input alone', async () => {
    const input = { a: 'AKIAIOSFODNN7EXAMPLE', n: 3, ok: true, none: null, list: ['fine', 'DB_PASSWORD=Sup3r!pw'], deep: { url: 'https://u:pw99@h/x' } }
    const out = redactDeep(input)
    expect(out).toEqual({ a: R, n: 3, ok: true, none: null, list: ['fine', `DB_PASSWORD=${R}`], deep: { url: `https://u:${R}@h/x` } })
    expect(input.a).toBe('AKIAIOSFODNN7EXAMPLE')
  })

  test('a branch nested deeper than the walk is replaced, never passed through', async () => {
    let o: any = { s: 'AKIAIOSFODNN7EXAMPLE' }
    for (let i = 0; i < 12; i++) o = { a: o }
    expect(JSON.stringify(redactDeep(o))).not.toContain('AKIA')
    expect(JSON.stringify(redactDeep(o))).toContain(R)
  })
})
