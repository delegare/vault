import { DiscoveryService } from '../../services/DiscoveryService';

jest.mock('../../services/DidService', () => ({
  DidService: {
    getPlatformDid: jest.fn(() => 'did:web:delegare.dev'),
  },
}));

import { DidService } from '../../services/DidService';

describe('DiscoveryService', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV, API_BASE_URL: 'https://api.delegare.dev', BASE_DOMAIN: 'delegare.dev', npm_package_version: '1.2.3' };
    jest.spyOn(DidService, 'getPlatformDid').mockReturnValue('did:web:delegare.dev');
  });

  afterAll(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  describe('getAgentCard', () => {
    it('returns a well-formed agent card catalog', () => {
      const card = DiscoveryService.getAgentCard() as any;
      expect(card.protocolVersion).toBe('0.2.0');
      expect(card.catalog).toBe('delegare-a2a-v0.2');
      expect(card.extensions).toContain('https://a2a-extensions.dev/ap2/v1');
      expect(card.cards).toHaveLength(1);
      
      const mainCard = card.cards[0];
      expect(mainCard.agent_id).toBe('delegare-platform');
      expect(mainCard.version).toBe('1.2.3');
      expect(mainCard.skills).toHaveLength(4);
      expect(mainCard.payment.protocol).toBe('x402');
    });

    it('contains correctly shaped AP2 extension params', () => {
      const card = DiscoveryService.getAgentCard() as any;
      const extensions = card.cards[0].capabilities.extensions;
      const ap2Ext = extensions.find((ext: any) => ext.uri === 'https://a2a-extensions.dev/ap2/v1');
      
      expect(ap2Ext).toBeDefined();
      expect(ap2Ext.params.role).toBe('issuer-and-facilitator');
      expect(ap2Ext.params.issuer_did).toBe('did:web:delegare.dev');
      expect(ap2Ext.params.ap2_manifest_uri).toBe('https://api.delegare.dev/.well-known/ap2.json');
    });
  });

  describe('getAp2Manifest', () => {
    it('returns a well-formed AP2 manifest', () => {
      const manifest = DiscoveryService.getAp2Manifest() as any;
      expect(manifest.ap2Version).toBe('v1');
      expect(manifest.role).toBe('issuer-and-facilitator');
      expect(manifest.protocol).toBe('x402');
      expect(manifest.payment_methods).toHaveLength(2);
      expect(manifest.endpoints).toHaveLength(5);
    });

    it('cross-references the agent-card and other discovery documents', () => {
      const manifest = DiscoveryService.getAp2Manifest() as any;
      expect(manifest.agent_card).toBe('https://api.delegare.dev/.well-known/agent-card.json');
      expect(manifest.ap2_configuration).toBe('https://api.delegare.dev/.well-known/ap2-configuration');
      expect(manifest.did_document).toBe('https://api.delegare.dev/.well-known/did.json');
      expect(manifest.jwks).toBe('https://api.delegare.dev/.well-known/jwks.json');
      expect(manifest.issuer_did).toBe('did:web:delegare.dev');
    });
  });

  describe('Cross-reference integrity', () => {
    it('agent-card and ap2 manifest perfectly cross-reference each other', () => {
      const card = DiscoveryService.getAgentCard() as any;
      const manifest = DiscoveryService.getAp2Manifest() as any;

      const ap2Ext = card.cards[0].capabilities.extensions.find((ext: any) => ext.uri === 'https://a2a-extensions.dev/ap2/v1');
      
      // agent_card's ap2_manifest_uri matches ap2.json's self URI conceptually (they share the same origin logic)
      // Here we just test they reference each other symmetrically
      expect(ap2Ext.params.ap2_manifest_uri).toContain('/.well-known/ap2.json');
      expect(manifest.agent_card).toContain('/.well-known/agent-card.json');
      
      // DID consistency
      expect(ap2Ext.params.issuer_did).toBe(manifest.issuer_did);
      expect(manifest.issuer_did).toBe(card.did);
      
      // JWKS consistency
      expect(ap2Ext.params.jwks_uri).toBe(manifest.jwks);
    });
  });

  describe('Pricing model', () => {
    it('declares percentage_with_bounds fee model with $0.005 floor and $0.03 cap on both manifests', () => {
      const card = DiscoveryService.getAgentCard() as any;
      const manifest = DiscoveryService.getAp2Manifest() as any;

      const ap2Ext = card.cards[0].capabilities.extensions
        .find((ext: any) => ext.uri === 'https://a2a-extensions.dev/ap2/v1');

      // Card AP2 extension
      expect(ap2Ext.params.pricing_model).toBe('percentage_with_bounds');
      expect(ap2Ext.params.platform_fee).toMatchObject({
        model: 'percentage', percent: 3, min_usd: 0.005, max_usd: 0.03,
      });

      // Card-level payment block mirrors
      expect(card.cards[0].payment.pricing_model).toBe('percentage_with_bounds');
      expect(card.cards[0].payment.platform_fee.min_usd).toBe(0.005);
      expect(card.cards[0].payment.platform_fee.max_usd).toBe(0.03);

      // ap2.json mirrors
      expect(manifest.pricing_model).toBe('percentage_with_bounds');
      expect(manifest.platform_fee.percent).toBe(3);
      expect(manifest.platform_fee.min_usd).toBe(0.005);
      expect(manifest.platform_fee.max_usd).toBe(0.03);
    });

    it('expresses settle/charge endpoint prices as a range, not a flat fee', () => {
      const manifest = DiscoveryService.getAp2Manifest() as any;
      const settle = manifest.endpoints.find((e: any) => e.path === '/v1/x402/settle');
      const charge = manifest.endpoints.find((e: any) => e.path === '/v1/charge');

      for (const ep of [settle, charge]) {
        expect(ep.price_usd_min).toBe(0.005);
        expect(ep.price_usd_max).toBe(0.03);
        expect(ep.fee_model).toBe('percentage_with_bounds');
        // Ensure the old flat field is gone
        expect(ep.price_usd).toBeUndefined();
      }

      // Free endpoints stay free
      for (const path of ['/v1/mandates/issue', '/v1/mandates/verify', '/v1/x402/verify']) {
        expect(manifest.endpoints.find((e: any) => e.path === path).price_usd).toBe(0);
      }
    });
  });
});
