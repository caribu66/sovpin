const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const archDocPath = path.join(repoRoot, 'docs', 'ARCHITECTURE_AND_API.md');
const rootReadmePath = path.join(repoRoot, 'README.md');
const envExamplePath = path.join(repoRoot, 'dashboard', '.env.example');
const dbSourcePath = path.join(repoRoot, 'dashboard', 'src', 'db.js');
const saasRoutesPath = path.join(repoRoot, 'dashboard', 'src', 'saas-routes.js');
const serverSourcePath = path.join(repoRoot, 'dashboard', 'server.js');

test('Documentation Reality Check 1: Every route in server.js and saas-routes.js is documented in docs/ARCHITECTURE_AND_API.md', () => {
  const archDoc = fs.readFileSync(archDocPath, 'utf8');
  const saasSource = fs.readFileSync(saasRoutesPath, 'utf8');
  const serverSource = fs.readFileSync(serverSourcePath, 'utf8');

  // Extract all router.<method>('/path', ...) routes in saas-routes.js (mounted at /v1)
  const routeRegex = /router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
  const codeRoutes = new Set();
  let match;
  while ((match = routeRegex.exec(saasSource)) !== null) {
    const method = match[1].toUpperCase();
    const fullPath = `/v1${match[2]}`;
    codeRoutes.add(`${method} ${fullPath}`);
  }

  // Extract top-level app.get('/api/...', ...) routes in server.js
  const serverRouteRegex = /app\.get\(\s*['"]([^'"]+)['"]/g;
  while ((match = serverRouteRegex.exec(serverSource)) !== null) {
    codeRoutes.add(`GET ${match[1]}`);
  }
  codeRoutes.add('GET /healthz');
  codeRoutes.add('GET /v1/healthz');

  // Extract documented table rows: | `METHOD` | `/path` |
  const docRouteRegex = /\|\s*`(GET|POST|PUT|PATCH|DELETE)`\s*\|\s*`([^`]+)`\s*\|/g;
  const documentedRoutes = new Set();
  while ((match = docRouteRegex.exec(archDoc)) !== null) {
    documentedRoutes.add(`${match[1]} ${match[2]}`);
  }

  for (const route of codeRoutes) {
    assert.ok(
      documentedRoutes.has(route),
      `Undocumented route in code: "${route}" is missing from docs/ARCHITECTURE_AND_API.md`
    );
  }

  for (const docRoute of documentedRoutes) {
    assert.ok(
      codeRoutes.has(docRoute),
      `Stale route in docs/ARCHITECTURE_AND_API.md: "${docRoute}" does not exist in server.js or saas-routes.js`
    );
  }
});

test('Documentation Reality Check 2: Every SQLite table in src/db.js is documented in docs/ARCHITECTURE_AND_API.md', () => {
  const archDoc = fs.readFileSync(archDocPath, 'utf8');
  const dbSource = fs.readFileSync(dbSourcePath, 'utf8');

  const tableRegex = /CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi;
  const codeTables = new Set();
  let match;
  while ((match = tableRegex.exec(dbSource)) !== null) {
    codeTables.add(match[1]);
  }
  assert.ok(codeTables.size >= 10, 'Expected at least 10 SQLite tables in src/db.js');

  for (const tableName of codeTables) {
    assert.ok(
      archDoc.includes(`| \`${tableName}\` |`),
      `Undocumented SQLite table "${tableName}" in src/db.js — add it to docs/ARCHITECTURE_AND_API.md`
    );
  }
});

test('Documentation Reality Check 3: Every variable in dashboard/.env.example is documented in docs/ARCHITECTURE_AND_API.md', () => {
  const archDoc = fs.readFileSync(archDocPath, 'utf8');
  const envExample = fs.readFileSync(envExamplePath, 'utf8');

  const envVars = envExample
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.split('=')[0].trim());

  assert.ok(envVars.length >= 20, 'Expected at least 20 env vars in dashboard/.env.example');

  for (const envVar of envVars) {
    assert.ok(
      archDoc.includes(`| \`${envVar}\` |`),
      `Undocumented environment variable "${envVar}" in dashboard/.env.example — add it to docs/ARCHITECTURE_AND_API.md`
    );
  }
});

test('Documentation Reality Check 4: Every repository file path listed in README.md exists on disk', () => {
  const readme = fs.readFileSync(rootReadmePath, 'utf8');
  const expectedPaths = [
    'README.md',
    'docker-compose.yml',
    'docs/ARCHITECTURE_AND_API.md',
    'docs/FOUNDATION.md',
    'scripts/sovpin.service',
    'scripts/deploy-kubo.sh',
    'scripts/configure-tunnel.sh',
    'scripts/configure-cache.sh',
    'web/src/App.tsx',
    'web/src/lib/api.ts',
    'dashboard/server.js',
    'dashboard/.env.example',
    'dashboard/src/config.js',
    'dashboard/src/db.js',
    'dashboard/src/verus-rpc.js',
    'dashboard/src/verus-storage.js',
    'dashboard/src/kubo-service.js',
    'dashboard/src/saas-routes.js',
    'dashboard/test/saas.test.js',
    'dashboard/test/verus-storage.test.js',
    'dashboard/test/docs-reality.test.js',
  ];

  for (const relPath of expectedPaths) {
    const absPath = path.join(repoRoot, relPath);
    assert.ok(fs.existsSync(absPath), `Missing repository file on disk: ${relPath}`);
    const basename = path.basename(relPath);
    assert.ok(
      readme.includes(basename),
      `README.md repository structure is missing ${relPath}`
    );
  }
});
