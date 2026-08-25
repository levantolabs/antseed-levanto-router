import type { AntseedRouterPlugin } from '@antseed/node';
import { LevantoRouter } from './router.js';

const plugin: AntseedRouterPlugin = {
  name: 'levanto',
  displayName: 'Levanto Model Router',
  version: '0.0.1',
  type: 'router',
  description: 'Routes each chat request to the cheapest capable model, picked by Levanto\'s routing peer',
  configSchema: [
    {
      key: 'LEVANTO_ROUTING_PEER_URL',
      label: 'Routing Peer URL',
      type: 'string',
      required: true,
      description: 'Base URL of the Levanto routing peer, e.g. http://127.0.0.1:8787',
    },
  ],
  createRouter(config: Record<string, string>) {
    const routingPeerUrl = config['LEVANTO_ROUTING_PEER_URL'];
    if (!routingPeerUrl) {
      throw new Error('LEVANTO_ROUTING_PEER_URL is required');
    }
    return new LevantoRouter({ routingPeerUrl });
  },
};

export default plugin;
export { LevantoRouter } from './router.js';
export type { LevantoRouterConfig } from './router.js';
export { buildDigest, periodKey } from './digest.js';
export type { DailyDigestBody } from './digest.js';
