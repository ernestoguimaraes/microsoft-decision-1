import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './decision.js';

const exec = promisify(execFile);
const management = 'https://management.azure.com';
const apiVersion = '2025-06-01';

export function resourceEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.port || !['', '/'].includes(url.pathname) ||
      !/\.(cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/.test(url.hostname)) {
    throw new Error('AZURE_ENDPOINT must be a public Azure Foundry resource root HTTPS URL.');
  }
  return url.origin;
}

async function cliSubscription() {
  try {
    const command = 'az account show --output json --only-show-errors';
    const { stdout } = process.platform === 'win32'
      ? await exec('cmd.exe', ['/d', '/s', '/c', command], { timeout: 15000, windowsHide: true })
      : await exec('az', ['account', 'show', '--output', 'json', '--only-show-errors'], { timeout: 15000 });
    return JSON.parse(stdout).id;
  } catch (error) {
    throw new AppError('Azure CLI context unavailable. Run az login, select a subscription, and reload projects.', 401, { cause: error });
  }
}

export function createFoundryCatalog(credential, { subscriptionId, fetchImpl = fetch, getSubscription = cliSubscription } = {}) {
  let projects = [];
  let context;

  async function list(path) {
    let token;
    try {
      token = (await credential.getToken('https://management.azure.com/.default')).token;
    } catch (error) {
      throw new AppError('Azure authentication failed. Run az login and reload projects.', 401, { cause: error });
    }
    const items = [];
    let next = `${management}${path}?api-version=${apiVersion}`;
    while (next) {
      const url = new URL(next);
      if (url.origin !== management) throw new AppError('Azure returned an invalid pagination URL.');
      let response;
      try {
        response = await fetchImpl(url.href, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30000),
          redirect: 'error',
        });
      } catch (error) {
        throw new AppError('Could not reach Azure Resource Manager. Check your connection and retry.', 502, { cause: error });
      }
      if (!response.ok) {
        throw new AppError(`Foundry discovery returned HTTP ${response.status}. Check az login and Reader access to the subscription, accounts and projects.`, response.status === 401 ? 401 : 502);
      }
      const body = await response.json();
      if (!Array.isArray(body.value)) throw new AppError('Azure returned an invalid resource list.');
      items.push(...body.value);
      next = body.nextLink;
    }
    return items;
  }

  return {
    async projects() {
      const subscription = subscriptionId || await getSubscription();
      if (!/^[a-f0-9-]{36}$/i.test(subscription)) throw new AppError('Azure CLI returned an invalid subscription ID.');
      const accounts = await list(`/subscriptions/${subscription}/providers/Microsoft.CognitiveServices/accounts`);
      const discovered = [];
      for (const account of accounts.filter((item) => item.kind === 'AIServices')) {
        const children = await list(`${account.id}/projects`);
        if (!children.length) continue;
        const endpoint = resourceEndpoint(account.properties?.endpoints?.['Azure AI Model Inference API'] ||
          account.properties?.endpoint);
        for (const project of children) {
          discovered.push({
            id: project.id, name: project.name.split('/').at(-1),
            account: account.name, accountId: account.id, endpoint, subscriptionId: subscription,
          });
        }
      }
      projects = discovered.sort((a, b) => a.name.localeCompare(b.name) || a.account.localeCompare(b.account));
      context = subscription;
      return { projects, subscriptionId: context };
    },
    async models(projectId) {
      const project = projects.find((item) => item.id === projectId);
      if (!project) throw new AppError('Select a project from the discovered Foundry projects.', 400);
      const deployments = await list(`${project.accountId}/deployments`);
      return deployments.filter((item) =>
        /^microsoft-decision-/i.test(item.properties?.model?.name ?? '') &&
        item.properties?.provisioningState === 'Succeeded'
      ).map((item) => ({
        id: item.name, model: item.properties.model.name, version: item.properties.model.version,
      })).sort((a, b) => a.id.localeCompare(b.id));
    },
    async resolve(projectId, deployment) {
      if (typeof projectId !== 'string' || typeof deployment !== 'string') {
        throw new AppError('Select a Foundry project and Decision model deployment.', 400);
      }
      const project = projects.find((item) => item.id === projectId);
      const models = await this.models(projectId);
      if (!models.some((item) => item.id === deployment)) {
        throw new AppError('Select a successful Microsoft Decision deployment from this project.', 400);
      }
      return { endpoint: project.endpoint, deployment, subscriptionId: project.subscriptionId };
    },
  };
}
