import type { AntseedRouterPlugin } from '@antseed/node';
import { DEFAULT_BASELINE_MODELS, LevantoRouter } from './router.js';

const plugin: AntseedRouterPlugin = {
  name: 'levanto',
  displayName: 'Levanto Model Router',
  version: '0.0.1',
  type: 'router',
  description: 'Routes each chat request to the cheapest capable model, picked by Levanto\'s routing peer',
  autoRouteServiceId: 'levanto-auto',
  autoRouteInfo: {
    title: 'Levanto Router',
    body: 'Levanto Router picks the best model and seller for every message you send, weighing cost '
      + 'against quality according to your Cost / quality tradeoff preference. No need to switch '
      + 'models by hand as prices and availability change.',
  },
  savingsBaselineModel: DEFAULT_BASELINE_MODELS[0],
  configSchema: [
    {
      key: 'LEVANTO_ROUTING_PEER_URL',
      label: 'Routing Peer URL',
      type: 'string',
      required: true,
      description: 'Base URL of the Levanto routing peer, e.g. http://127.0.0.1:8787',
    },
    {
      key: 'LEVANTO_DATA_DIR',
      label: 'Data Directory',
      type: 'string',
      required: false,
      description: 'Directory to persist the routing_decisions ledger in. Omit to keep the ledger in-memory only.',
    },
    {
      key: 'LEVANTO_SELLER_PEER_ID',
      label: 'Routing Peer ID',
      type: 'string',
      required: false,
      description: 'The routing peer\'s P2P peer id (40-char hex EVM address) -- who the daily usage charge is signed against. Distinct from the HTTP URL above: this is a P2P identity, not an endpoint. Omit to disable daily signing (routing-only, no charge).',
    },
    {
      key: 'LEVANTO_BUYER_PEER_ID',
      label: 'Buyer Peer ID',
      type: 'string',
      required: false,
      description: 'This buyer\'s own P2P peer id, sent to the routing peer as x-antseed-buyer-peer-id so the daily-charge gate has someone to check. Omit and the routing peer sees no buyer identity at all -- every request fails that gate. See LevantoRouterConfig.buyerPeerId for why this is a demo-shaped stopgap, not a real authentication mechanism.',
    },
  ],
  createRouter(config: Record<string, string>) {
    const routingPeerUrl = config['LEVANTO_ROUTING_PEER_URL'];
    if (!routingPeerUrl) {
      throw new Error('LEVANTO_ROUTING_PEER_URL is required');
    }
    return new LevantoRouter({
      routingPeerUrl,
      dataDir: config['LEVANTO_DATA_DIR'] || undefined,
      sellerPeerId: config['LEVANTO_SELLER_PEER_ID'] || undefined,
      buyerPeerId: config['LEVANTO_BUYER_PEER_ID'] || undefined,
    });
  },
};

export default plugin;
export { LevantoRouter, RoutingPeerError } from './router.js';
export type { LevantoRouterConfig } from './router.js';
export { buildDigest, periodKey } from './digest.js';
export type { DailyDigestBody } from './digest.js';
