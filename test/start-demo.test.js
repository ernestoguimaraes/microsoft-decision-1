import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const available = process.platform === 'win32' &&
  spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0;
const options = { skip: !available };
const subscription = '11111111-1111-1111-1111-111111111111';

function runDemo(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'decision-demo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyFileSync(new URL('../start-demo.ps1', import.meta.url), join(root, 'start-demo.ps1'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'server.js'), `export { readConfig } from ${JSON.stringify(new URL('../server.js', import.meta.url).href)};`);
  const originalEnv = [
    '# Preserve this comment and the existing login.',
    'AZURE_ENDPOINT=https://existing.cognitiveservices.azure.com',
    'DEPLOYMENT_NAME=decision-1',
    `AZURE_SUBSCRIPTION_ID=${subscription}`,
    'PORT=3210',
    'APP_AUTH_USERNAME=demo',
    `APP_AUTH_PASSWORD_HASH=${'a'.repeat(64)}`,
    '',
  ].join('\n');
  writeFileSync(join(root, '.env'), originalEnv);
  writeFileSync(join(root, 'harness.ps1'), `
function npm.cmd {
    Add-Content -LiteralPath $env:DEMO_CALLS -Value ('npm ' + ($args -join ' '))
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'ls') { $global:LASTEXITCODE = [int]$env:DEMO_DEPENDENCIES }
    if ($args[0] -eq 'ci') { $global:LASTEXITCODE = [int]$env:DEMO_INSTALL }
}
function az.cmd {
    Add-Content -LiteralPath $env:DEMO_CALLS -Value ('az ' + ($args -join ' '))
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'login') { $global:LASTEXITCODE = [int]$env:DEMO_LOGIN }
    if ($args[1] -eq 'get-access-token' -and $env:DEMO_EXPIRED -eq '1') {
        $env:DEMO_EXPIRED = '0'
        $global:LASTEXITCODE = 1
    }
}
$parameters = @{}
if ($env:DEMO_ENDPOINT) { $parameters.Endpoint = $env:DEMO_ENDPOINT }
& (Join-Path $PSScriptRoot 'start-demo.ps1') @parameters
`);
  const callsPath = join(root, 'calls.txt');
const env = {
  ...process.env,
  DEMO_CALLS: callsPath,
  DEMO_DEPENDENCIES: '0',
  DEMO_INSTALL: '0',
  DEMO_EXPIRED: '0',
  DEMO_LOGIN: '0',
  ...overrides,
};
for (const key of ['AZURE_ENDPOINT', 'DEPLOYMENT_NAME', 'AZURE_SUBSCRIPTION_ID', 'APP_AUTH_USERNAME',
  'APP_AUTH_PASSWORD_HASH', 'WEBSITE_HOSTNAME', 'PORT', 'REQUEST_INTERVAL_MS']) delete env[key];
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(root, 'harness.ps1')], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env,
  });
  let calls = '';
  try {
    calls = readFileSync(callsPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...result, calls, envText: readFileSync(join(root, '.env'), 'utf8'), originalEnv };
}

test('demo startup preserves login and settings without restoring healthy dependencies', options, (t) => {
  const result = runDemo(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.envText, /# Preserve this comment/);
  assert.match(result.envText, /APP_AUTH_USERNAME=demo/);
  assert.match(result.envText, new RegExp(`APP_AUTH_PASSWORD_HASH=${'a'.repeat(64)}`));
  assert.match(result.envText, /AZURE_ENDPOINT="https:\/\/existing.cognitiveservices.azure.com"/);
  assert.match(result.stdout, /http:\/\/localhost:3210/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp('a'.repeat(64)));
  assert.doesNotMatch(result.calls, /npm ci|az login|account set/);
  assert.match(result.calls, /get-access-token --subscription 11111111-1111-1111-1111-111111111111/);
  assert.match(result.calls, /npm start/);
});

test('demo startup uses the configured proxy and stops when dependency restoration fails', options, (t) => {
  const result = runDemo(t, { DEMO_DEPENDENCIES: '1', DEMO_INSTALL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.calls, /npm ci --registry=https:\/\/packagefeedproxy.microsoft.io\/npm/);
  assert.doesNotMatch(result.calls, /az |npm start/);
  assert.match(result.stderr, /Falha ao instalar dependencias/);
});

test('demo startup restores missing dependencies before starting', options, (t) => {
  const result = runDemo(t, { DEMO_DEPENDENCIES: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /npm ci --registry=https:\/\/packagefeedproxy.microsoft.io\/npm/);
  assert.match(result.calls, /npm start/);
});

test('demo startup renews an expired Azure token before starting', options, (t) => {
  const result = runDemo(t, { DEMO_EXPIRED: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /az login --scope https:\/\/cognitiveservices.azure.com\/.default/);
  assert.equal((result.calls.match(/get-access-token/g) ?? []).length, 2);
  assert.match(result.calls, /npm start/);
});

test('demo startup stops when Azure sign-in fails', options, (t) => {
  const result = runDemo(t, { DEMO_EXPIRED: '1', DEMO_LOGIN: '1' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /npm start/);
  assert.match(result.stderr, /Falha ao renovar o login Azure/);
});

test('demo startup rejects project endpoints before writing configuration or calling Azure', options, (t) => {
  const result = runDemo(t, { DEMO_ENDPOINT: 'https://existing.services.ai.azure.com/api/projects/demo' });
  assert.notEqual(result.status, 0);
  assert.equal(result.envText, result.originalEnv);
  assert.equal(result.calls, '');
  assert.match(result.stderr, /endpoint raiz HTTPS/);
});
