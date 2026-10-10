// Lets `node --test hub/test/` work: Node 24 treats a bare directory argument as a module to run,
// so this entry point loads every *.test.mjs in the folder. (`node --test hub/test/*.test.mjs` also works.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(path.join(dir, f));
}
