import test from 'node:test';
import assert from 'node:assert/strict';
import { createFoundryCatalog } from '../foundry.js';
import { createApp, readConfig } from '../server.js';

const subscriptionId = '00000000-0000-0000-0000-000000000000';
const accountId = `/subscriptions/${subscriptionId}/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/lab`;
const projectId = `${accountId}/projects/project`;
const endpoint = 'https://lab.services.ai.azure.com';
const project = { id: projectId, name: 'project', account: 'lab', endpoint, subscriptionId };

function fixture(overrides = {}) {
  const calls = [];
  const credential = { getToken: async (scope) => {
    assert.equal(scope, 'https://management.azure.com/.default');
    return { token: 'test-token' };
  } };
  const catalog = createFoundryCatalog(credential, {
    getSubscription: async () => subscriptionId,
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      let value;
      if (url.includes('/deployments?')) value = [
        { name: 'decision-a', properties: { model: { name: 'Microsoft-Decision-1', version: '1' }, provisioningState: 'Succeeded' } },
        { name: 'decision-b', properties: { model: { name: 'Microsoft-Decision-1' }, provisioningState: 'Failed' } },
        { name: 'chat', properties: { model: { name: 'gpt-4o' }, provisioningState: 'Succeeded' } },
      ];
      else if (url.includes('/projects?')) value = [{ id: projectId, name: 'lab/project' }];
      else value = [{ id: accountId, name: 'lab', kind: 'AIServices', properties: { endpoint } }];
      return { ok: true, json: async () => ({ value }) };
    },
    ...overrides,
  });
  return { catalog, calls };
}

test('discovers CLI-context projects and only successful Decision deployments', async () => {
  const { catalog } = fixture();
  const result = await catalog.projects();
  assert.equal(result.subscriptionId, subscriptionId);
  assert.equal(result.projects[0].id, projectId);
  assert.equal(result.projects[0].name, 'project');
  assert.deepEqual(await catalog.models(projectId), [{ id: 'decision-a', model: 'Microsoft-Decision-1', version: '1' }]);
  assert.deepEqual(await catalog.resolve(projectId, 'decision-a'), { endpoint, deployment: 'decision-a', subscriptionId });
  await assert.rejects(catalog.models('https://untrusted.example'), /Select a project/);
  await assert.rejects(catalog.resolve(projectId, 'chat'), /successful Microsoft Decision/);
  await assert.rejects(catalog.resolve(projectId, null), /Select a Foundry/);
});

test('uses configured subscription without querying the CLI active subscription', async () => {
  const { catalog, calls } = fixture({
    subscriptionId,
    getSubscription: () => { throw new Error('must not run'); },
  });
  await catalog.projects();
  assert.match(calls[0], new RegExp(`/subscriptions/${subscriptionId}/`));
});

test('handles ARM pagination and rejects untrusted pagination destinations', async () => {
  let page = 0;
  const { catalog } = fixture({ fetchImpl: async () => ({
    ok: true, json: async () => ++page === 1
      ? { value: [], nextLink: 'https://management.azure.com/next' } : { value: [] },
  }) });
  assert.deepEqual((await catalog.projects()).projects, []);
  assert.equal(page, 2);
  const bad = fixture({ fetchImpl: async () => ({
    ok: true, json: async () => ({ value: [], nextLink: 'https://untrusted.example/' }),
  }) });
  await assert.rejects(bad.catalog.projects(), /invalid pagination URL/);
});

test('surfaces discovery authorization and connectivity errors instead of empty lists', async () => {
  for (const status of [401, 403, 429]) {
    const { catalog } = fixture({ fetchImpl: async () => ({ ok: false, status }) });
    await assert.rejects(catalog.projects(), new RegExp(`HTTP ${status}`));
  }
  const { catalog } = fixture({ fetchImpl: async () => { throw new Error('network'); } });
  await assert.rejects(catalog.projects(), /Could not reach Azure/);
});

test('allows an unconfigured local app but rejects partial and unconfigured hosted settings', () => {
  assert.equal(readConfig({}).endpoint, undefined);
  assert.throws(() => readConfig({ AZURE_ENDPOINT: endpoint }), /together/);
  assert.throws(() => readConfig({ DEPLOYMENT_NAME: 'decision-a' }), /together/);
  assert.throws(() => readConfig({ WEBSITE_HOSTNAME: 'test.azurewebsites.net' }), /together/);
});

test('routes each inference to its validated selection without mutating server defaults', async (t) => {
  const config = { endpoint, deployment: 'default', port: 0 };
  const targets = [];
  const { catalog } = fixture();
  const app = createApp(config, async (input, signal, target) => {
    targets.push(target);
    return { request: { model: target.deployment } };
  }, { foundry: catalog });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  config.port = app.address().port;
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${config.port}`;
  assert.equal((await fetch(`${base}/api/foundry/projects`)).status, 200);
  assert.equal((await fetch(`${base}/api/foundry/models?projectId=${encodeURIComponent(projectId)}`)).status, 200);
  const decide = (body) => fetch(`${base}/api/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'synthetic', ...body }),
  });
  assert.equal((await decide({ projectId, deployment: 'decision-a' })).status, 200);
  assert.equal((await decide({ projectId, deployment: 'chat', endpoint: 'https://untrusted.example' })).status, 400);
  assert.equal((await decide({ projectId: 'unknown', deployment: 'decision-a' })).status, 400);
  assert.equal((await decide({})).status, 200);
  assert.equal(targets[0].deployment, 'decision-a');
  assert.equal(targets[1].deployment, 'default');
  assert.equal(config.deployment, 'default');
});
