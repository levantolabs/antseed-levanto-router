import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VprModelCatalogEntry } from '../../core/state';
import {
  LEVANTO_AUTO_CATALOG_ENTRY,
  LEVANTO_AUTO_PROVIDER,
  LEVANTO_AUTO_SERVICE_ID,
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

test('LEVANTO_AUTO_CATALOG_ENTRY matches the router-levanto plugin sentinel', () => {
  assert.equal(LEVANTO_AUTO_CATALOG_ENTRY.provider, LEVANTO_AUTO_PROVIDER);
  assert.equal(LEVANTO_AUTO_CATALOG_ENTRY.serviceId, LEVANTO_AUTO_SERVICE_ID);
  assert.equal(LEVANTO_AUTO_SERVICE_ID, 'levanto-auto');
});

test('withLevantoAutoCatalogEntry prepends the Auto entry to a real catalog when enabled', () => {
  const catalog = withLevantoAutoCatalogEntry([realEntry()], true);
  assert.equal(catalog.length, 2);
  assert.ok(isLevantoAutoEntry(catalog[0]!));
});

test('withLevantoAutoCatalogEntry is idempotent -- never duplicates the entry on repeated calls', () => {
  const once = withLevantoAutoCatalogEntry([realEntry()], true);
  const twice = withLevantoAutoCatalogEntry(once, true);
  assert.equal(twice.filter(isLevantoAutoEntry).length, 1);
});

test('withLevantoAutoCatalogEntry works on an empty catalog (no discovered sellers yet)', () => {
  const catalog = withLevantoAutoCatalogEntry([], true);
  assert.equal(catalog.length, 1);
  assert.ok(isLevantoAutoEntry(catalog[0]!));
});

test('withLevantoAutoCatalogEntry omits the Auto entry when disabled', () => {
  const catalog = withLevantoAutoCatalogEntry([realEntry()], false);
  assert.equal(catalog.length, 1);
  assert.equal(catalog.some(isLevantoAutoEntry), false);
});

test('withLevantoAutoCatalogEntry drops a stale Auto entry when disabled, even if the catalog already had one', () => {
  const withEntry = withLevantoAutoCatalogEntry([realEntry()], true);
  const afterToggleOff = withLevantoAutoCatalogEntry(withEntry, false);
  assert.equal(afterToggleOff.length, 1);
  assert.equal(afterToggleOff.some(isLevantoAutoEntry), false);
});

test('withLevantoAutoCatalogEntry on an empty catalog when disabled stays empty', () => {
  const catalog = withLevantoAutoCatalogEntry([], false);
  assert.equal(catalog.length, 0);
});

test('isLevantoAutoEntry rejects a real model entry', () => {
  assert.equal(isLevantoAutoEntry(realEntry()), false);
});

test('isLevantoAutoSelected is false when no model is selected (null)', () => {
  assert.equal(isLevantoAutoSelected(null), false);
});

test('isLevantoAutoSelected is false for a real, concretely-selected model', () => {
  assert.equal(isLevantoAutoSelected(realEntry()), false);
});

test('isLevantoAutoSelected is true when Levanto Auto is the selected model', () => {
  assert.equal(isLevantoAutoSelected(LEVANTO_AUTO_CATALOG_ENTRY), true);
});
