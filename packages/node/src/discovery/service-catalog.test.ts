import { describe, expect, it } from 'vitest';
import { buildNetworkServiceOffers, compareNetworkServiceOfferPrice, selectLowestPricedNetworkServiceOffer } from './service-catalog.js';

describe('buildNetworkServiceOffers', () => {
  it('projects provider-specific services, pricing, protocols, and image billing', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'a'.repeat(40),
      displayName: 'Seller',
      providers: ['openai', 'anthropic'],
      reputationScore: 90,
      providerPricing: {
        openai: {
          defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          services: { 'gpt-image-test': {} },
        },
        anthropic: {
          services: { 'claude-test': { inputUsdPerMillion: 3, outputUsdPerMillion: 9 } },
        },
      },
      providerServiceApiProtocols: {
        openai: { services: { 'gpt-image-test': ['openai-images'] } },
        anthropic: { services: { 'claude-test': ['anthropic-messages'] } },
      },
      providerServiceCapabilities: {
        openai: { services: { 'gpt-image-test': { inputs: ['text'], outputs: ['image'] } } },
      },
      providerServiceUnitBillingModels: {
        openai: {
          services: {
            'gpt-image-test': {
              'openai-images': {
                version: 1,
                components: [
                  { unit: 'output_images', priceUsd: 0.04 },
                  { unit: 'output_images', priceUsd: 0.08 },
                ],
              },
            },
          },
        },
      },
    }]);

    expect(offers).toHaveLength(2);
    expect(offers.find((offer) => offer.serviceId === 'gpt-image-test')).toMatchObject({
      provider: 'openai',
      protocol: 'openai-images',
      type: 'image',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      minImageUsdPerImage: 0.04,
      maxImageUsdPerImage: 0.08,
    });
    expect(offers.find((offer) => offer.serviceId === 'claude-test')).toMatchObject({
      provider: 'anthropic',
      protocol: 'anthropic-messages',
      type: 'text',
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 9,
    });
  });

  it('supports legacy peer-wide service lists', () => {
    expect(buildNetworkServiceOffers([{
      peerId: 'b'.repeat(40),
      providers: ['openai'],
      services: ['legacy-model'],
    }])).toMatchObject([{
      serviceId: 'legacy-model',
      provider: 'openai',
      protocol: 'openai-chat-completions',
      type: 'text',
    }]);
  });

  it('derives type "day-pass" for the antseed-day-pass protocol and carries a flat price', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'c'.repeat(40),
      displayName: 'Routing Peer',
      providerPricing: {
        'acme-routing': {
          services: { 'antseed-day-pass': { inputUsdPerMillion: 0.59 } },
        },
      },
      providerServiceApiProtocols: {
        'acme-routing': { services: { 'antseed-day-pass': ['antseed-day-pass'] } },
      },
    }]);

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      serviceId: 'antseed-day-pass',
      protocol: 'antseed-day-pass',
      type: 'day-pass',
      flatUsdPrice: 0.59,
    });
  });

  it('never lets a day-pass offer sort as "cheapest" against real per-token model offers', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'd'.repeat(40),
      providerPricing: {
        'acme-routing': {
          services: { 'antseed-day-pass': { inputUsdPerMillion: 0.59 } },
        },
        openai: {
          services: { 'gpt-real-model': { inputUsdPerMillion: 10, outputUsdPerMillion: 30 } },
        },
      },
      providerServiceApiProtocols: {
        'acme-routing': { services: { 'antseed-day-pass': ['antseed-day-pass'] } },
        openai: { services: { 'gpt-real-model': ['openai-chat-completions'] } },
      },
    }]);

    expect(offers).toHaveLength(2);
    const sorted = [...offers].sort(compareNetworkServiceOfferPrice);
    expect(sorted[0]?.serviceId).toBe('gpt-real-model');
    expect(selectLowestPricedNetworkServiceOffer(offers)?.serviceId).toBe('gpt-real-model');
  });
});
