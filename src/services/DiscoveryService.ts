import { DidService } from './DidService';

/**
 * Service to generate A2A and AP2 discovery documents.
 * These follow the patterns from the #2112 A2A discussion and current live implementations.
 */
export class DiscoveryService {
  private static baseUrl(): string {
    return process.env.API_BASE_URL || process.env.BASE_URL || 'https://api.delegare.dev';
  }

  private static version(): string {
    return process.env.npm_package_version ?? '0.1.0';
  }

  /**
   * Generates the A2A v0.2 Agent Card catalog document.
   * Path: /.well-known/agent-card.json
   */
  static getAgentCard(): object {
    const baseUrl = this.baseUrl();
    const version = this.version();
    const platformDid = DidService.getPlatformDid();

    return {
      protocolVersion: '0.2.0',
      catalog: 'delegare-a2a-v0.2',
      extensions: ['https://a2a-extensions.dev/ap2/v1'],
      count: 1,
      name: 'Delegare',
      description: 'AP2 issuer + dual-rail payment facilitator. Issues intent/checkout/payment mandates (SD-JWT-VC) and settles x402 micropayments via EIP-3009 on Base (USDC) or Stripe (fiat card-on-file). Platform fee: 3% of transaction amount, $0.005 min, $0.03 cap.',
      url: baseUrl,
      documentationUrl: 'https://docs.delegare.dev',
      version: version,
      provider: {
        organization: 'Delegare',
        url: 'https://delegare.dev'
      },
      did: platformDid,
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false
      },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      additionalInterfaces: [
        { transport: 'HTTP+JSON', url: `${baseUrl}/v1` },
        { transport: 'MCP',       url: `${baseUrl}/mcp` }
      ],
      cards: [
        {
          name: 'Delegare — AP2 Issuer + x402 Facilitator',
          description: 'Trustless agent payment authorization. Issues bounded-authority AP2 mandates (intent / checkout / payment) as SD-JWT-VC, and settles x402 payments on EIP-3009 (USDC/Base) or Stripe (fiat card-on-file). Agents authenticate against mandates instead of holding keys.',
          url: baseUrl,
          version: version,
          protocolVersion: '0.2.0',
          agent_id: 'delegare-platform',
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          skills: [
            {
              id: 'issue-intent-mandate',
              name: 'Issue AP2 intent mandate',
              description: 'Issue a bounded-authority intent mandate (SD-JWT-VC) for a buyer agent. Mandate carries spending limit, accepted rails, expiry, allowed merchants.',
              tags: ['ap2', 'mandate', 'intent', 'sd-jwt-vc', 'issuer'],
              examples: [`POST /v1/mandates/issue {"type":"intent", "limits":{...}}`],
              inputModes: ['application/json'],
              outputModes: ['application/json']
            },
            {
              id: 'verify-mandate',
              name: 'Verify AP2 mandate',
              description: 'Cryptographically verify any Delegare-issued mandate against the issuer\'s JWKS at /.well-known/jwks.json. Free read.',
              tags: ['ap2', 'verify', 'vc'],
              examples: ['POST /v1/mandates/verify { ...sd-jwt-vc... }'],
              inputModes: ['application/json'],
              outputModes: ['application/json']
            },
            {
              id: 'settle-x402-crypto',
              name: 'Settle x402 payment (USDC on Base)',
              description: 'Verify and settle an x402 payment via EIP-3009 receiveWithAuthorization on USDC/Base. Emits AuthorizationUsed event for on-chain attribution.',
              tags: ['x402', 'settle', 'eip-3009', 'usdc', 'base'],
              examples: ['POST /v1/x402/settle { ...paymentPayload... }'],
              inputModes: ['application/json'],
              outputModes: ['application/json']
            },
            {
              id: 'charge-stripe-fiat',
              name: 'Charge mandate via Stripe (fiat fallback)',
              description: 'Off-session charge against a buyer\'s card-on-file using a Delegare-issued mandate. Used by clients without a crypto wallet; bypasses the x402 USDC path.',
              tags: ['fiat', 'stripe', 'card-on-file', 'fallback'],
              examples: ['POST /v1/charge { mandate, amount }'],
              inputModes: ['application/json'],
              outputModes: ['application/json']
            }
          ],
          capabilities: {
            streaming: false,
            pushNotifications: false,
            stateTransitionHistory: false,
            extensions: [
              {
                uri: 'https://a2a-extensions.dev/ap2/v1',
                description: 'AP2 issuer + facilitator. Issues SD-JWT-VC mandates verifiable via /.well-known/jwks.json; settles via x402 (USDC) or Stripe (fiat).',
                required: true,
                params: {
                  role: 'issuer-and-facilitator',
                  protocol: 'x402',
                  facilitator_endpoint: `${baseUrl}/v1/x402`,
                  well_known: '/.well-known/x402',
                  issuer_did: platformDid,
                  jwks_uri: `${baseUrl}/.well-known/jwks.json`,
                  ap2_manifest_uri: `${baseUrl}/.well-known/ap2.json`,
                  ap2_configuration_uri: `${baseUrl}/.well-known/ap2-configuration`,
                  supported_mandate_types: ['intent', 'checkout', 'payment'],
                  credential_format: 'sd-jwt-vc',
                  credential_schemas: {
                    intent: 'https://ap2-protocol.org/schemas/intent-mandate-v1.json'
                  },
                  assets: ['USDC'],
                  chains: ['base'],
                  fiat_rail: 'stripe',
                  pricing_model: 'percentage_with_bounds',
                  platform_fee: {
                    model: 'percentage',
                    percent: 3,
                    currency: 'USD',
                    min_usd: 0.005,
                    max_usd: 0.03,
                    applies_to: 'per_successful_settlement',
                    note: '3% of transaction amount, floor $0.005 (covers EIP-3009 base settlement gas), cap $0.03 (reached at amount ≥ $1.00).'
                  },
                  requires_human_review: false
                }
              }
            ]
          },
          tags: ['ap2', 'x402', 'mandate', 'issuer', 'facilitator', 'sd-jwt-vc', 'dual-rail', 'usdc', 'stripe', 'eip-3009'],
          provider: {
            organization: 'Delegare',
            url: 'https://delegare.dev'
          },
          documentationUrl: 'https://docs.delegare.dev',
          payment: {
            protocol: 'x402',
            role: 'issuer-and-facilitator',
            facilitator_endpoint: `${baseUrl}/v1/x402`,
            assets: ['USDC'],
            chains: ['base'],
            fiat_rail: 'stripe',
            pricing_model: 'percentage_with_bounds',
            platform_fee: {
              model: 'percentage',
              percent: 3,
              currency: 'USD',
              min_usd: 0.005,
              max_usd: 0.03,
              applies_to: 'per_successful_settlement',
              note: '3% of transaction amount, floor $0.005 (covers EIP-3009 base settlement gas), cap $0.03 (reached at amount ≥ $1.00).'
            },
            requires_human_review: false
          },
          next_best_actions: [
            { action: `POST ${baseUrl}/v1/mandates/issue`,  description: 'Issue an AP2 intent mandate for a buyer agent', price_usd: 0, free: true },
            { action: `POST ${baseUrl}/v1/mandates/verify`, description: 'Verify any Delegare-issued mandate', price_usd: 0, free: true },
            { action: `POST ${baseUrl}/v1/x402/verify`,     description: 'Verify an x402 payment before settling', price_usd: 0, free: true },
            { 
              action: `POST ${baseUrl}/v1/x402/settle`,     
              description: 'Settle a verified x402 payment via EIP-3009. Platform fee 3% (min $0.005, max $0.03).', 
              price_usd_min: 0.005, 
              price_usd_max: 0.03, 
              fee_model: 'percentage_with_bounds', 
              free: false 
            },
            { 
              action: `POST ${baseUrl}/v1/charge`,          
              description: 'Charge a mandate via Stripe (fiat fallback). Platform fee 3% (min $0.005, max $0.03).', 
              price_usd_min: 0.005, 
              price_usd_max: 0.03, 
              fee_model: 'percentage_with_bounds', 
              free: false 
            }
          ]
        }
      ],
      note: 'A2A v0.2 Agent Card. Delegare\'s role is issuer-and-facilitator — distinct from x402 merchants. The AP2 issuer-discovery doc is at /.well-known/ap2-configuration; this card\'s AP2 extension carries the canonical role declaration.'
    };
  }

  /**
   * Generates the AP2 v1 service manifest.
   * Path: /.well-known/ap2.json
   */
  static getAp2Manifest(): object {
    const baseUrl = this.baseUrl();
    const platformDid = DidService.getPlatformDid();

    return {
      ap2Version: 'v1',
      a2aExtension: 'https://a2a-extensions.dev/ap2/v1',
      agent_card: `${baseUrl}/.well-known/agent-card.json`,
      ap2_configuration: `${baseUrl}/.well-known/ap2-configuration`,
      did_document: `${baseUrl}/.well-known/did.json`,
      jwks: `${baseUrl}/.well-known/jwks.json`,
      service: 'Delegare — AP2 Issuer + x402 Facilitator',
      provider: 'Delegare',
      role: 'issuer-and-facilitator',
      issuer_did: platformDid,
      supported_mandate_types: ['intent', 'checkout', 'payment'],
      credential_format: 'sd-jwt-vc',
      credential_schemas: {
        intent: 'https://ap2-protocol.org/schemas/intent-mandate-v1.json'
      },
      protocol: 'x402',
      facilitator: {
        name: 'Delegare',
        endpoint: `${baseUrl}/v1/x402`
      },
      payment_methods: [
        {
          network: 'eip155:8453',
          name: 'Base',
          asset: 'USDC',
          asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          decimals: 6,
          settlement: 'eip-3009-receive-with-authorization'
        },
        {
          network: 'stripe',
          name: 'Stripe',
          asset: 'USD',
          decimals: 2,
          settlement: 'off-session-card-on-file'
        }
      ],
      pricing_model: 'percentage_with_bounds',
      platform_fee: {
        model: 'percentage',
        percent: 3,
        currency: 'USD',
        min_usd: 0.005,
        max_usd: 0.03,
        applies_to: 'per_successful_settlement',
        note: '3% of transaction amount, floor $0.005 (covers EIP-3009 base settlement gas), cap $0.03 (reached at amount ≥ $1.00).'
      },
      base_fee_usd: 0.005,
      max_fee_usd: 0.03,
      endpoints: [
        { method: 'POST', path: '/v1/mandates/issue',  price_usd: 0,    description: 'Issue an AP2 mandate (intent / checkout / payment) as SD-JWT-VC' },
        { method: 'POST', path: '/v1/mandates/verify', price_usd: 0,    description: 'Verify a Delegare-issued mandate against /.well-known/jwks.json' },
        { method: 'POST', path: '/v1/x402/verify',     price_usd: 0,    description: 'Verify an x402 payment payload without settling' },
        { 
          method: 'POST', 
          path: '/v1/x402/settle',     
          price_usd_min: 0.005, 
          price_usd_max: 0.03, 
          fee_model: 'percentage_with_bounds', 
          description: 'Settle an x402 payment via EIP-3009 (USDC/Base). Platform fee: 3% of transaction amount, $0.005 minimum (covers base settlement gas), $0.03 cap (amounts ≥ $1).' 
        },
        { 
          method: 'POST', 
          path: '/v1/charge',          
          price_usd_min: 0.005, 
          price_usd_max: 0.03, 
          fee_model: 'percentage_with_bounds', 
          description: 'Charge a mandate via Stripe (fiat fallback). Same fee model as crypto rail: 3% with $0.005 floor and $0.03 cap.' 
        }
      ],
      discovery: `${baseUrl}/.well-known/agent-card.json`,
      documentation: 'https://docs.delegare.dev',
      requires_human_review: false,
      note: 'AP2 / x402 service manifest. The canonical AP2 declaration is in /.well-known/agent-card.json under capabilities.extensions[] (https://a2a-extensions.dev/ap2/v1). Delegare\'s role is issuer-and-facilitator, distinct from x402 merchants — payment_methods lists rails Delegare facilitates; endpoints lists Delegare\'s own service routes. The OAuth-style issuer discovery doc is at /.well-known/ap2-configuration.'
    };
  }
}
