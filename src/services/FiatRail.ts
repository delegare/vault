import Stripe from 'stripe';
import { getSecret, vaultSecretId } from '../lib/secrets';
import type { SpendingMandate } from '../models/SpendingMandate';

let stripeLiveClient: Stripe | null = null;
let stripeTestClient: Stripe | null = null;

async function getStripe(isTestMode: boolean): Promise<Stripe> {
  const secrets = await getSecret(vaultSecretId());
  
  if (isTestMode) {
    if (stripeTestClient) return stripeTestClient;
    const testKey = secrets['STRIPE_TEST_SECRET_KEY'] ?? process.env.STRIPE_TEST_SECRET_KEY ?? '';
    stripeTestClient = new Stripe(testKey, { apiVersion: '2024-12-18.acacia' as any });
    return stripeTestClient;
  }

  if (stripeLiveClient) return stripeLiveClient;
  const liveKey = secrets['STRIPE_SECRET_KEY'] ?? process.env.STRIPE_SECRET_KEY ?? '';
  stripeLiveClient = new Stripe(liveKey, { apiVersion: '2024-12-18.acacia' as any });
  return stripeLiveClient;
}

export interface FiatChargeParams {
  delegate: SpendingMandate;
  amountCents: number;
  currency: string;
  description: string;
  merchantStripeAccountId?: string;
  merchantApplicationFeeAmountCents: number;
  idempotencyKey: string;
  metadata?: Record<string, string>;
  isTestMode: boolean;
}

export interface FiatChargeResult {
  stripePaymentIntentId: string;
  status: 'completed' | 'pending' | 'failed';
  failureReason?: string;
}

export async function chargeFiat(params: FiatChargeParams): Promise<FiatChargeResult> {
  const stripe = await getStripe(params.isTestMode);

  if (!params.delegate.stripeCustomerId || !params.delegate.stripePaymentMethodId) {
    return { stripePaymentIntentId: '', status: 'failed', failureReason: 'No fiat payment method on delegate' };
  }

  try {
    const intentPayload: Stripe.PaymentIntentCreateParams = {
      amount: params.amountCents,
      currency: params.currency === 'usd' ? 'usd' : params.currency,
      customer: params.delegate.stripeCustomerId,
      payment_method: params.delegate.stripePaymentMethodId,
      confirm: true,
      off_session: true,
      description: params.description,
      metadata: params.metadata ?? {},
    };

    if (params.merchantStripeAccountId) {
      intentPayload.application_fee_amount = params.merchantApplicationFeeAmountCents;
      intentPayload.transfer_data = { destination: params.merchantStripeAccountId };
    }

    let intent: Stripe.PaymentIntent;
    try {
      intent = await stripe.paymentIntents.create(
        intentPayload,
        { idempotencyKey: params.idempotencyKey },
      );
    } catch (err: any) {
      const isMissingCapability =
        err.type === 'StripeInvalidRequestError' &&
        (err.message as string ?? '').includes('capabilities');

      if (isMissingCapability && params.merchantStripeAccountId) {
        // The connected account has not yet had `transfers` capability approved.
        // This typically happens when the merchant connected Stripe in live mode
        // against a sandbox backend, or when a newly-linked account is still
        // pending Stripe's capability review.
        // We do NOT silently fall back to a direct charge — that would suppress
        // the platform fee and route funds incorrectly. Surface the error instead
        // so the merchant can reconnect their Stripe account in test mode.
        console.error(
          `[FiatRail] Connected account ${params.merchantStripeAccountId} is missing the ` +
          `'transfers' capability. Merchant must reconnect Stripe via the dashboard.`,
        );
        return {
          stripePaymentIntentId: '',
          status: 'failed',
          failureReason:
            `Merchant Stripe account is not fully configured for payments. ` +
            `Please reconnect Stripe in the merchant dashboard.`,
        };
      }

      console.error('[FiatRail] Stripe charge failed:', err.message);
      return {
        stripePaymentIntentId: '',
        status: 'failed',
        failureReason: err.message ?? 'Unknown Stripe error',
      };
    }

    if (intent.status === 'succeeded') {
      return { stripePaymentIntentId: intent.id, status: 'completed' };
    }

    if (intent.status === 'processing') {
      return { stripePaymentIntentId: intent.id, status: 'pending' };
    }

    return {
      stripePaymentIntentId: intent.id,
      status: 'failed',
      failureReason: intent.last_payment_error?.message ?? `Stripe status: ${intent.status}`,
    };
  } catch (err: any) {
    console.error('[FiatRail] Stripe charge failed:', err.message);
    return {
      stripePaymentIntentId: '',
      status: 'failed',
      failureReason: err.message ?? 'Unknown Stripe error',
    };
  }
}

export async function getStripeConnectOAuthUrl(sessionToken: string, isTestMode: boolean = false): Promise<string> {
  const secrets = await getSecret(vaultSecretId());
  
  const keyName = isTestMode ? 'STRIPE_TEST_CONNECT_CLIENT_ID' : 'STRIPE_CONNECT_CLIENT_ID';
  const clientId = secrets[keyName] ?? process.env[keyName] ?? '';
  const baseUrl = process.env.BASE_URL ?? 'https://api.delegare.dev';

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'read_write',
    redirect_uri: `${baseUrl}/v1/webhooks/stripe-connect/callback`,
    state: sessionToken,
  });

  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}
