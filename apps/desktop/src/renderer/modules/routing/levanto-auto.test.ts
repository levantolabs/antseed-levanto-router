import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VprModelCatalogEntry, VprRoutingPreferences } from '../../core/state';
import type { RouterPluginInfo } from '../../types/bridge';
import {
  isLevantoAutoEntry,
  isLevantoAutoSelected,
  withLevantoAutoCatalogEntry,
} from './levanto-auto.js';

function realEntry(overrides: Partial<VprModelCatalogEntry> = {}): VprModelCatalogEntry {
  return {
    provider: 'openai',
    serviceId: 'gpt-5.6-luna',
    label: 'GPT 5.6 Luna',
    peerCount: 3,
    categories: [],
    kind: 'text',
    protocols: [],
    minInputUsdPerMillion: 0.2,
    maxInputUsdPerMillion: 0.3,
    minOutputUsdPerMillion: 1.1,
    maxOutputUsdPerMillion: 1.2,
    minCachedInputUsdPerMillion: null,
    maxCachedInputUsdPerMillion: null,
    minImageUsdPerImage: null,
    maxImageUsdPerImage: null,
    expectedSavingsPct: null,
    hasEligibleFreeSeller: false,
    bestPeerId: '0xAAA',
    ...overrides,
  };
}

type AutoPreferences = Pick<VprRoutingPreferences, 'autoDayPassEnabled' | 'selectedRouterPackage'>;

const ENABLED_LEVANTO_DEFAULT: AutoPreferences = { autoDayPassEnabled: true, selectedRouterPackage: null };
const DISABLED: AutoPreferences = { autoDayPassEnabled: false, selectedRouterPackage: null };

const CUSTOM_ROUTER: RouterPluginInfo = {
  package: '@antseed/router-custom',
  version: '1.0.0',
  name: 'custom',
  displayName: 'Custom Router',
  description: 'A different router plugin',
  autoRouteServiceId: 'custom-auto',
};

test('withLevantoAutoCatalogEntry falls back to the Levanto identity when no router plugin metadata is available', () => {
  const catalog = withLevantoAutoCatalogEntry([realEntry()], ENABLED_LEVANTO_DEFAULT, []);
  assert.equal(catalog.length, 2);
  assert.ok(isLevantoAutoEntry(catalog[0]!));
  assert.equal(catalog[0]!.provider, 'levanto');
  assert.equal(catalog[0]!.serviceId, 'levanto-auto');
});

test('withLevantoAutoCatalogEntry uses the selected plugin\'s own declared identity when installed', () => {
  const preferences: AutoPreferences = { autoDayPassEnabled: true, selectedRouterPackage: CUSTOM_ROUTER.package };
  const catalog = withLevantoAutoCatalogEntry([realEntry()], preferences, [CUSTOM_ROUTER]);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0]!.provider, 'custom');
  assert.equal(catalog[0]!.serviceId, 'custom-auto');
  assert.equal(catalog[0]!.label, 'Custom Router');
});

test('withLevantoAutoCatalogEntry is idempotent -- never duplicates the entry on repeated calls', () => {
  const once = withLevantoAutoCatalogEntry([realEntry()], ENABLED_LEVANTO_DEFAULT, []);
  const twice = withLevantoAutoCatalogEntry(once, ENABLED_LEVANTO_DEFAULT, []);
  assert.equal(twice.filter(isLevantoAutoEntry).length, 1);
});

test('withLevantoAutoCatalogEntry works on an empty catalog (no discovered sellers yet)', () => {
  const catalog = withLevantoAutoCatalogEntry([], ENABLED_LEVANTO_DEFAULT, []);
  assert.equal(catalog.length, 1);
  assert.ok(isLevantoAutoEntry(catalog[0]!));
});

test('withLevantoAutoCatalogEntry omits the Auto entry when disabled', () => {
  const catalog = withLevantoAutoCatalogEntry([realEntry()], DISABLED, []);
  assert.equal(catalog.length, 1);
  assert.equal(catalog.some(isLevantoAutoEntry), false);
});

test('withLevantoAutoCatalogEntry drops a stale Auto entry when disabled, even if the catalog already had one', () => {
  const withEntry = withLevantoAutoCatalogEntry([realEntry()], ENABLED_LEVANTO_DEFAULT, []);
  const afterToggleOff = withLevantoAutoCatalogEntry(withEntry, DISABLED, []);
  assert.equal(afterToggleOff.length, 1);
  assert.equal(afterToggleOff.some(isLevantoAutoEntry), false);
});

test('withLevantoAutoCatalogEntry on an empty catalog when disabled stays empty', () => {
  const catalog = withLevantoAutoCatalogEntry([], DISABLED, []);
  assert.equal(catalog.length, 0);
});

test('isLevantoAutoEntry rejects a real model entry', () => {
  withLevantoAutoCatalogEntry([], ENABLED_LEVANTO_DEFAULT, []);
  assert.equal(isLevantoAutoEntry(realEntry()), false);
});

test('isLevantoAutoSelected is false when no model is selected (null)', () => {
  assert.equal(isLevantoAutoSelected(null), false);
});

test('isLevantoAutoSelected is false for a real, concretely-selected model', () => {
  withLevantoAutoCatalogEntry([], ENABLED_LEVANTO_DEFAULT, []);
  assert.equal(isLevantoAutoSelected(realEntry()), false);
});

test('isLevantoAutoSelected is true when the currently-active Auto entry is the selected model', () => {
  const catalog = withLevantoAutoCatalogEntry([], ENABLED_LEVANTO_DEFAULT, []);
  assert.equal(isLevantoAutoSelected(catalog[0]!), true);
});
