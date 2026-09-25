// Chequeo portable para Windows/Linux; evita depender de find/xargs POSIX.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

function archivosJs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return archivosJs(path);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

const files = ['server.js', ...['routes', 'services', 'middleware', 'scripts'].flatMap(archivosJs)];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
