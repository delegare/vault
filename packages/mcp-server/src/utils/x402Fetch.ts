/**
 * Mandate-backed x402 auto-pay fetch helper for buyer agents.
 *
 * Usage:
 *
 *   const res = await x402Fetch(url, init, { intentMandate });
 *
 * Flow:
 *   1. Issue the original request.
 *   2. If the server returns 402 with x402 PaymentRequirements, parse
 *      `accepts` for an exact/base(-sepolia) USDC requirement.
 *   3. Retry the request with `X-DELEGARE-MANDATE: <intentMandate>` —
 *      vault's `requireX402Payment` middleware routes that through the
 *      router-based mandate settlement path (no popups, no EIP-3009
 *      signing) and returns the gated content plus an `X-PAYMENT-RESPONSE`
 *      receipt header.
 *
 * Rationale:
 *   USDC's canonical `transferWithAuthorization` does NOT call
 *   `isValidSignature`, so smart-wallet session keys cannot sign a valid
 *   EIP-3009 payload for x402. Instead, we delegate settlement to vault's
 *   facilitator which charges the mandate via the existing
 *   `chargeCrypto` router flow.
 *
 *   For merchants NOT using vault's middleware (pure EIP-3009 x402 servers),
 *   this helper currently returns the original 402 response untouched —
 *   buyers would need a raw EOA with USDC to pay those.
 */

export interface X402FetchOptions {
  /** SD-JWT-VC intent mandate. */
  intentMandate: string;
  /** Log or trace callback for the autopay attempt. */
  onAutopayAttempt?: (requirements: X402Requirement) => void;
}

export interface X402Requirement {
  scheme: 'exact';
  network: 'base' | 'base-sepolia';
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  resource: string;
  mimeType?: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface X402PaymentReceipt {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
}

export interface X402FetchResult {
  response: Response;
  /** Decoded `X-PAYMENT-RESPONSE` receipt, if the server paid. */
  receipt?: X402PaymentReceipt;
  /** True if the 402 path was exercised. */
  autoPaid: boolean;
}

/** Parse the server's 402 body into a PaymentRequirements accepts list. */
async function tryParseRequirements(res: Response): Promise<X402Requirement[]> {
  try {
    const clone = res.clone();
    const body: any = await clone.json();
    if (Array.isArray(body?.accepts)) return body.accepts as X402Requirement[];
  } catch {
    /* non-JSON 402 body — not an x402 response */
  }
  return [];
}

function pickRequirement(accepts: X402Requirement[]): X402Requirement | undefined {
  return accepts.find(
    (a) => a.scheme === 'exact' && (a.network === 'base' || a.network === 'base-sepolia'),
  );
}

function decodePaymentResponseHeader(header: string | null): X402PaymentReceipt | undefined {
  if (!header) return undefined;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

export async function x402Fetch(
  url: string,
  init: RequestInit | undefined,
  options: X402FetchOptions,
): Promise<X402FetchResult> {
  const first = await fetch(url, init);

  if (first.status !== 402) {
    return { response: first, autoPaid: false };
  }

  const accepts = await tryParseRequirements(first);
  const requirement = pickRequirement(accepts);
  if (!requirement) {
    // 402 from a non-x402 server, or no supported network/scheme — return as-is.
    return { response: first, autoPaid: false };
  }

  options.onAutopayAttempt?.(requirement);

  const retryHeaders = new Headers(init?.headers ?? {});
  retryHeaders.set('X-DELEGARE-MANDATE', options.intentMandate);

  const second = await fetch(url, { ...init, headers: retryHeaders });

  const receipt = decodePaymentResponseHeader(second.headers.get('x-payment-response'));
  return {
    response: second,
    receipt,
    autoPaid: second.status >= 200 && second.status < 300,
  };
}
