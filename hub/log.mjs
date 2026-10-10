import fs from 'node:fs';

const MAX_LOG = 5 * 1024 * 1024;

export function createLogger(file, { tty = false } = {}) {
  if (file) {
    try {
      if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, file + '.1');
    } catch { /* no log yet */ }
  }
  const write = (level, msg, err) => {
    let line = `${new Date().toISOString()} ${level} ${msg}`;
    if (err) line += ` :: ${err && err.stack ? err.stack : String(err)}`;
    line += '\n';
    if (file) {
      try { fs.appendFileSync(file, line); } catch { /* ignore */ }
    }
    if (tty) (level === 'ERROR' ? process.stderr : process.stdout).write(line);
  };
  return {
    info: (m, e) => write('INFO', m, e),
    warn: (m, e) => write('WARN', m, e),
    error: (m, e) => write('ERROR', m, e),
  };
}
