import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { ProcessManager, resolveCommandArgs, applyLevantoRouterDemoOverride } from './process-manager.js';
import { LEVANTO_ROUTER_PACKAGE } from '../../shared/router-plugin-defaults.js';

test('resolveCommandArgs launches the grouped buyer runtime command without forcing the default router', () => {
  const args = resolveCommandArgs({
    mode: 'connect',
    router: 'local',
    configPath: '/tmp/antseed-config.json',
    verbose: true,
  });

  assert.deepEqual(args, [
    '--verbose',
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'buyer', 'start',
  ]);
});

test('resolveCommandArgs forwards non-default routers', () => {
  const args = resolveCommandArgs({
    mode: 'connect',
    router: 'custom-router',
    configPath: '/tmp/antseed-config.json',
  });

  assert.deepEqual(args, [
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'buyer', 'start', '--router', 'custom-router',
  ]);
});

test('applyLevantoRouterDemoOverride forces the Levanto router on connect-mode starts, regardless of the caller-requested router', () => {
  // Regression for the real bug this was originally written to fix: the
  // renderer's own boot-time auto-start (app.ts's ensureConnectRuntimeStarted)
  // requests whatever router the user has configured (defaulting away from
  // 'levanto'), races ahead of the main process's own attempt to force
  // 'levanto', and wins -- so the override has to hold regardless of what a
  // caller asks for, not just when nothing is specified. Loading the plugin
  // doesn't depend on autoDayPassEnabled at all, so no stub for that flag is
  // needed here (see a real fresh-install 502 this avoids -- the module doc
  // comment above applyLevantoRouterDemoOverride has the full incident). Pinned to
  // base-local here so the assertions can check the devnet isolation flags;
  // the base-mainnet/base-sepolia branch is covered separately.
  for (const requestedRouter of [undefined, 'local', 'custom-router']) {
    const result = applyLevantoRouterDemoOverride({
      mode: 'connect',
      router: requestedRouter,
      env: { EXISTING: '1' },
    }, () => 'base-local', () => LEVANTO_ROUTER_PACKAGE);
    assert.equal(result.router, LEVANTO_ROUTER_PACKAGE, `router should be forced to Levanto's package when requested router was ${String(requestedRouter)}`);
    // router-levanto picks its own devnet default from the generic
    // ANTSEED_CHAIN_ID the CLI passes every plugin, so this file only
    // forwards an explicit override -- neither is forced here.
    assert.equal(result.env?.['LEVANTO_ROUTING_PEER_URL'], process.env['LEVANTO_ROUTING_PEER_URL']);
    assert.equal(result.env?.['LEVANTO_SELLER_PEER_ID'], process.env['LEVANTO_SELLER_PEER_ID']);
    assert.equal(
      result.env?.['LEVANTO_DATA_DIR'],
      process.env['LEVANTO_DATA_DIR'] ?? join(homedir(), '.antseed', 'router-levanto'),
      'router-levanto must get a persistent data dir so the routing_decisions ledger survives a subprocess restart',
    );
    assert.equal(
      result.env?.['ANTSEED_DIRECT_PEER_ADDRESSES_JSON'],
      process.env['ANTSEED_DIRECT_PEER_ADDRESSES_JSON'] ?? '{"c199453fd6b1c6823634ef9b3702eb5aeca71265":"127.0.0.1:6892","6306c9b78c84ad83365ff1e8c12eaa5f135fe1f2":"127.0.0.1:6894","c9f8839e97d2dfff1ac24e88830f0a58283d5b4c":"127.0.0.1:6896","447cecac64c36f8cf507109c464f1126c042a65b":"127.0.0.1:6898","54ba02b713327d36ea210deaacc20d464b9f3ccb":"127.0.0.1:6900","7a69b2ea13db7bbe63eef45627b13b98582a723a":"127.0.0.1:6902"}',
      'base-local must isolate via devnet mock-seller addresses',
    );
    assert.equal(
      result.env?.['ANTSEED_NO_OFFICIAL_BOOTSTRAP'],
      process.env['ANTSEED_NO_OFFICIAL_BOOTSTRAP'] ?? '1',
      'base-local must isolate from the real dht1/dht2.antseed.com swarm',
    );
    assert.equal(result.env?.['EXISTING'], '1', 'existing env entries must be preserved, not dropped');
  }
});

test('applyLevantoRouterDemoOverride does not force a routing-peer URL/seller id on a real chain, and skips the devnet isolation flags', () => {
  // The gap this closes: base-mainnet/base-sepolia buyers used to get the
  // exact same devnet-shaped env as base-local, including
  // ANTSEED_NO_OFFICIAL_BOOTSTRAP=1, which would cut a real buyer off from
  // the real dht1/dht2.antseed.com swarm entirely.
  for (const chainId of ['base-mainnet', 'base-sepolia'] as const) {
    const result = applyLevantoRouterDemoOverride({
      mode: 'connect',
      env: { EXISTING: '1' },
    }, () => chainId, () => LEVANTO_ROUTER_PACKAGE);
    assert.equal(result.router, LEVANTO_ROUTER_PACKAGE);
    // router-levanto defaults both to its own real mainnet routing peer,
    // discovered via P2P/DHT when no URL is given, so host code doesn't
    // inject either unless an operator explicitly overrides via the env var.
    assert.equal(result.env?.['LEVANTO_ROUTING_PEER_URL'], process.env['LEVANTO_ROUTING_PEER_URL']);
    assert.equal(result.env?.['LEVANTO_SELLER_PEER_ID'], process.env['LEVANTO_SELLER_PEER_ID']);
    assert.equal(
      result.env?.['LEVANTO_DATA_DIR'],
      process.env['LEVANTO_DATA_DIR'] ?? join(homedir(), '.antseed', 'router-levanto'),
      'real-chain buyers must also get a persistent router-levanto data dir',
    );
    assert.equal(result.env?.['ANTSEED_NO_OFFICIAL_BOOTSTRAP'], undefined, `${chainId} must not isolate from the real network`);
    assert.equal(result.env?.['ANTSEED_DIRECT_PEER_ADDRESSES_JSON'], undefined, `${chainId} must not get devnet mock-seller addresses`);
    assert.equal(result.env?.['EXISTING'], '1', 'existing env entries must be preserved, not dropped');
  }
});

test('applyLevantoRouterDemoOverride leaves connect-mode starts untouched when the router dropdown is explicitly set to None', () => {
  // The gap this closes: unconditionally forcing router:'levanto' meant a
  // genuine mainnet buyer with the router dropdown left on "None" was still
  // silently pointed at a local routing-peer URL, devnet peer addresses, and
  // official-bootstrap disabled -- mixing devnet routing infra into a
  // real-network session the user never asked to be in. "None" is an
  // explicit choice (VprPreferencesView.tsx writes selectedRouterPackage:
  // null for it), distinct from the field never having been set at all --
  // resolveRouterPackage returning null models exactly that.
  const opts = { mode: 'connect' as const, router: 'local', env: { EXISTING: '1' } };
  const result = applyLevantoRouterDemoOverride(opts, () => 'base-local', () => null);
  assert.deepEqual(result, opts);
});

test('applyLevantoRouterDemoOverride leaves non-connect modes untouched', () => {
  const opts = { mode: 'system-proxy' as const, systemProxyPort: 8080 };
  const result = applyLevantoRouterDemoOverride(opts);
  assert.deepEqual(result, opts);
});

test('applyLevantoRouterDemoOverride passes a non-Levanto selected router straight through by package name, with none of the Levanto env injection', () => {
  const opts = { mode: 'connect' as const, router: 'local', env: { EXISTING: '1' } };
  const result = applyLevantoRouterDemoOverride(opts, () => 'base-local', () => '@antseed/router-other');
  assert.equal(result.router, '@antseed/router-other');
  assert.deepEqual(result.env, { EXISTING: '1' });
});

test('resolveCommandArgs launches the System Proxy runtime with selected profiles and models', () => {
  const args = resolveCommandArgs({
    mode: 'system-proxy',
    configPath: '/tmp/antseed-config.json',
    systemProxyPeerId: '0123456789abcdef0123456789abcdef01234567',
    systemProxyPort: 8378,
    systemProxyProfiles: ['editor', 'browser'],
    systemProxyDefaultModel: 'model-a',
    systemProxyServedModels: ['model-a', 'model-b'],
    setSystemProxy: true,
  });

  assert.deepEqual(args, [
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'system-proxy', 'start',
    '--peer', '0123456789abcdef0123456789abcdef01234567',
    '--port', '8378',
    '--profile', 'editor',
    '--profile', 'browser',
    '--default-model', 'model-a',
    '--served-model', 'model-a',
    '--served-model', 'model-b',
    '--system-proxy',
  ]);
});

test('resolveCommandArgs launches the public tunnel through the CLI', () => {
  const args = resolveCommandArgs({
    mode: 'tunnel',
    configPath: '/tmp/antseed-config.json',
    tunnelBuyerPort: 9456,
  });

  assert.deepEqual(args, [
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'tunnel', 'start', '--buyer-port', '9456',
  ]);
});

test('attached runtimes can be stopped locally without owning the shared process', async () => {
  const logs: string[] = [];
  const processManager = new ProcessManager((_mode, _stream, line) => logs.push(line));

  const attached = processManager.attach('connect');
  assert.equal(attached.running, true);
  assert.equal(attached.pid, null);
  assert.equal(processManager.isAttached('connect'), true);

  const stopped = await processManager.stop('connect', true);
  assert.equal(stopped.running, false);
  assert.equal(stopped.pid, null);
  assert.equal(processManager.isAttached('connect'), false);
  assert.deepEqual(logs, ['Attached to existing connect runtime']);
});
