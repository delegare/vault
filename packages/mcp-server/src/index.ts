import { McpServer } from "skybridge/server";
import { z } from "zod";
import { x402Fetch } from "./utils/x402Fetch";

const API_BASE_URL = process.env.API_BASE_URL || 'https://api.delegare.dev';
const TX_EXPLORER_BASE = API_BASE_URL.includes('sandbox') || API_BASE_URL.includes('localhost')
  ? 'https://sepolia.basescan.org'
  : 'https://basescan.org';

const server = new McpServer({
  name: "delegare",
  title: "Delegare Payments",
  version: "1.1.0",
  description: "Delegare is a delegated payment protocol for AI agents. It allows users to set spending limits and authorize agents to pay on their behalf using fiat or crypto.",
  websiteUrl: "https://delegare.dev",
  icons: [{ src: "https://delegare.dev/logo.png" }],
});

/**
 * Robustly extracts authentication data from tool context (args/extra).
 * Supports both body-injected meta and raw HTTP headers from the MCP transport.
 */
function getAuth(args: any, extra: any) {
  const meta = args?._meta || extra?.requestMeta || {};
  const headers = extra?.requestInfo?.headers || {};
  
  // Extract token from Bearer string
  const authHeader = headers['authorization'] || headers['Authorization'];
  let oauthToken = meta.oauthToken || args.oauthToken;
  if (!oauthToken && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    oauthToken = authHeader.substring(7);
  }

  let merchantId = meta.merchantId || headers['x-delegare-merchant-id'] || headers['X-Delegare-Merchant-Id'] || args.merchantId;
  
  // ChatGPT aggressively hallucinates the user's email address into the `merchantId`
  // argument because of the prompt's context. This breaks DynamoDB's exact primary 
  // key lookup in the Vault. If the resolved merchantId is an email, discard it.
  if (typeof merchantId === 'string' && merchantId.includes('@')) {
    merchantId = undefined;
  }

  return {
    merchantId,
    apiKey: meta.apiKey || headers['x-delegare-api-key'] || headers['X-Delegare-Api-Key'] || args.apiKey,
    oauthToken
  };
}

server.registerWidget(
  "execute_fetch",
  {
    title: "Execute Fetch",
    description: "Secure Fetch Tool with x402 support",
  },
  {
    title: "Execute Fetch",
    description: "Fetch a URL. If the resource requires payment via x402, provide your intentMandate and this tool will automatically authorize the payment and retrieve the data. Supports both GET and POST. Can also be used for standard public API fetches.",
    inputSchema: {
      url: z.string().url().describe("The URL to fetch"),
      method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method"),
      body: z.string().optional().describe("Optional JSON body for POST requests"),
      intentMandate: z.string().optional().describe("Optional: Your intent mandate (the SD-JWT-VC encoded token) to automatically pay for x402 protected resources."),
      _meta: z.any().optional().describe("Internal metadata for transport"),
    },
    outputSchema: {
      url: z.string().describe("The fetched URL"),
      status: z.number().describe("HTTP response status code"),
      content: z.any().describe("The response body (JSON or text)"),
      paymentExecuted: z.boolean().describe("Whether an x402 payment was executed"),
      receipt: z.any().optional().describe("Payment receipt if executed")
    },
    annotations: {
      title: "Execute Fetch",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    securitySchemes: [{ type: "oauth2", scopes: ["pay"] }],
  } as any,
  async (args, extra: any) => {
    const { url, method, body, intentMandate } = args;

    try {
      const init: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? body : undefined,
      };

      // Mandate-backed x402 autopay. On 402 with x402 requirements, this
      // helper retries with `X-DELEGARE-MANDATE` if intentMandate is provided.
      const { response, receipt, autoPaid } = await x402Fetch(url, init, {
        intentMandate: intentMandate,
      });

      const isJson = response.headers.get('content-type')?.includes('application/json');
      const text = await response.text();

      let content: unknown;
      try {
        content = isJson ? JSON.parse(text) : text;
      } catch {
        content = text;
      }

      const paymentSummary = receipt
        ? ` Automatic x402 payment executed — tx ${receipt.transaction} on ${receipt.network}.`
        : autoPaid
          ? ' Payment retry succeeded (no receipt header present).'
          : '';

      return {
        content: [
          {
            type: "text",
            text: `Successfully fetched ${url}.${paymentSummary}\n\nResponse Content:\n${typeof content === 'string' ? content : JSON.stringify(content, null, 2)}`,
          },
        ],
        structuredContent: {
          url,
          status: response.status,
          content,
          paymentExecuted: !!receipt,
          receipt,
        },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Fetch failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.registerWidget(
  "request_payment_authorization",
  { 
    title: "Request Payment Authorization",
    description: "Authorization Link UI",
    _meta: {
      ui: {
        csp: {
          connectDomains: ["https://api.delegare.dev", "https://api.sandbox.delegare.dev", "http://localhost:3000"],
          redirectDomains: ["https://app.delegare.dev"],
        }
      }
    }
  },
  {
    title: "Request Payment Authorization",
    description: "Set up agent spending limits. Request permission from the user to spend money on their behalf. Use this BEFORE making a payment to generate an Intent Mandate token.",
    inputSchema: {
      maxPerTxCents: z.number().describe("Requested maximum amount in cents allowed per single transaction"),
      maxMonthlySpendCents: z.number().describe("Requested maximum total amount in cents allowed per month"),
      _meta: z.any().optional().describe("Internal metadata for transport"),
    },
    outputSchema: {
      setupUrl: z.string().optional().describe("URL for the user to complete payment authorization"),
      sessionToken: z.string().optional().describe("Token to poll for completion"),
      intentMandate: z.string().optional().describe("Encoded intent mandate if shortcut available"),
      shortcut: z.boolean().optional().describe("Whether an existing mandate was used"),
      maxPerTxCents: z.number().optional().describe("Confirmed max per transaction"),
      maxMonthlySpendCents: z.number().optional().describe("Confirmed max monthly spend")
    },
    annotations: {
      title: "Request Payment Authorization",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    securitySchemes: [{ type: "oauth2", scopes: ["pay", "balance", "revoke"] }],
  } as any,
  async (args, extra: any) => {
    const { maxPerTxCents, maxMonthlySpendCents } = args;
    const { merchantId, apiKey, oauthToken } = getAuth(args, extra);

    try {
      if (!oauthToken && !apiKey) {
        throw new Error("Unauthorized: You must be authenticated via OAuth or provide a valid API key to request payment authorizations.");
      }
      
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-delegare-merchant-id': merchantId || '',
      };
      
      if (oauthToken) headers['Authorization'] = `Bearer ${oauthToken}`;
      if (apiKey) headers['x-delegare-api-key'] = apiKey;

      const response = await fetch(`${API_BASE_URL}/v1/mandates`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          maxPerTxCents,
          maxMonthlySpendCents,
          rail: 'both',
          railPreference: 'auto',
        })
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || 'Failed to create authorization request');
      }

      const data = await response.json();
      
      // Attempt to return existing active mandates if they are sufficient to skip the UI
      if (data.existingMandates && data.existingMandates.length > 0) {
        // Return the first active mandate as a valid shortcut
        const bestMandate = data.existingMandates[0];
        return {
          content: [
            {
              type: "text",
              text: `You already have an active spending authorization that covers these limits!\n\nNo need to ask the user to click a link. You may proceed immediately using the following intentMandate:\n\n${bestMandate.encodedMandate}`,
            },
          ],
          structuredContent: {
            ...data,
            shortcut: true,
            intentMandate: bestMandate.encodedMandate,
            maxPerTxCents,
            maxMonthlySpendCents
          },
          _meta: { status: "success", shortcut: true },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Please ask the user to visit this URL to connect their payment method: ${data.setupUrl}\n\nIMPORTANT: You must use the 'poll_setup_session' tool with the sessionToken '${data.sessionToken}' to wait for the user to complete the setup. Do NOT attempt to use the sessionToken as an intentMandate! You must wait for the polling tool to return the final intentMandate.`,
          },
        ],
        structuredContent: {
          ...data,
          maxPerTxCents,
          maxMonthlySpendCents
        },
        _meta: { status: "success", url: data.setupUrl },
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to request authorization: ${err.message}\n\nDEBUG_INFO: ${JSON.stringify({ authUsed: { merchantId, hasApiKey: !!apiKey, hasToken: !!oauthToken } })}`,
          },
        ],
        structuredContent: { error: err.message, debug: { merchantId, hasApiKey: !!apiKey, hasToken: !!oauthToken } },
        _meta: { status: "error", message: err.message },
      };
    }
  }
);

server.registerWidget(
  "poll_setup_session",
  {
    title: "Poll Setup Session",
    description: "Check if the user has completed the payment setup in their browser."
  },
  {
    title: "Poll Setup Session",
    description: "Polls the status of a pending spending mandate setup. Call this after generating a setup URL to get the final intentMandate.",
    inputSchema: {
      sessionToken: z.string().describe("The sessionToken returned by request_payment_authorization"),
      _meta: z.any().optional().describe("Internal metadata for transport"),
    },
    outputSchema: {
      status: z.string().describe("Current status: pending, complete, or expired"),
      intentMandate: z.string().optional().describe("The finalized intent mandate if complete"),
      encodedMandate: z.string().optional().describe("Legacy encoded mandate field")
    },
    annotations: {
      title: "Poll Setup Session",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    securitySchemes: [{ type: "oauth2", scopes: ["pay", "balance", "revoke"] }],
  } as any,
  async (args, extra: any) => {
    const { sessionToken } = args;
    const { merchantId, apiKey, oauthToken } = getAuth(args, extra);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-delegare-merchant-id': merchantId || '',
      };
      if (oauthToken) headers['Authorization'] = `Bearer ${oauthToken}`;
      if (apiKey) headers['x-delegare-api-key'] = apiKey;

      const response = await fetch(`${API_BASE_URL}/v1/setup-sessions/${encodeURIComponent(sessionToken)}`, { headers });
      
      if (!response.ok) {
        throw new Error(`Failed to poll status: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.status === 'complete' && data.encodedMandate) {
        return {
          content: [
            {
              type: "text",
              text: `Setup Complete! The user has authorized the payment limits. You may now execute payments using the following intentMandate:\n\n${data.encodedMandate}`,
            },
          ],
          structuredContent: {
            ...data,
            intentMandate: data.encodedMandate
          },
        };
      } else if (data.status === 'expired') {
        return {
          content: [{ type: "text", text: "The setup session has expired. The user took too long or cancelled the flow." }],
          isError: true,
        };
      } else {
        return {
          content: [{ type: "text", text: "Setup is still pending. The user has not completed the browser flow yet." }],
          structuredContent: data,
        };
      }
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Polling failed: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// Helper to simulate API call to backend
const getBalance = async (token: string) => {
  // In reality, this would fetch from https://api.delegare.dev/v1/mandates/:token/balance
  return {
    status: "active",
    maxMonthlySpendCents: 5000,
    currentMonthlySpendCents: 1500,
    remainingMonthlySpendCents: 3500,
    maxPerTxCents: 1000,
    currency: "usd"
  };
};

const processPayment = async (merchantId: string | undefined, apiKey: string | undefined, oauthToken: string | undefined, token: string, amountCents: number, description: string, recipient?: string, idempotencyKey?: string) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-delegare-merchant-id': merchantId || '',
  };
  if (oauthToken) headers['Authorization'] = `Bearer ${oauthToken}`;
  if (apiKey) headers['x-delegare-api-key'] = apiKey;

  // Strip leading '@' — agents commonly include it, e.g. '@sunny-amber-capybara'
  const cleanRecipient = recipient?.startsWith('@') ? recipient.slice(1) : recipient;

  const response = await fetch(`${API_BASE_URL}/v1/payments/charge`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      intentMandate: token,
      amountCents,
      currency: "usd",
      description,
      recipient: cleanRecipient,
      idempotencyKey,
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `Payment failed with status ${response.status}`);
  }

  return response.json();
};

const fetchMerchantStats = async (merchantId: string, apiKey: string) => {
  const response = await fetch(`${API_BASE_URL}/v1/merchants/${merchantId}/stats`, {
    headers: {
      'x-delegare-merchant-id': merchantId,
      'x-delegare-api-key': apiKey,
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || 'Failed to fetch merchant stats');
  }

  return response.json();
};

server.registerWidget(
  "get_balance",
  { 
    title: "Get Balance",
    description: "Allowance UI",
    _meta: {
      ui: {
        csp: {
          connectDomains: ["https://api.delegare.dev", "https://api.sandbox.delegare.dev", "http://localhost:3000"],
          redirectDomains: ["https://app.delegare.dev", "https://app.sandbox.delegare.dev"],
        }
      }
    }
  },
  {
    title: "Get Balance",
    description: "Check your remaining spending allowance and monthly limits.",
    inputSchema: {
      intentMandate: z.string().describe("The intent mandate to check balance for"),
      _meta: z.any().optional().describe("Internal metadata for transport"),
    },
    outputSchema: {
      status: z.string().optional().describe("Mandate status (e.g. active)"),
      maxMonthlySpendCents: z.number().optional().describe("Maximum monthly limit"),
      currentMonthlySpendCents: z.number().optional().describe("Amount spent this month"),
      remainingMonthlySpendCents: z.number().optional().describe("Remaining budget this month"),
      maxPerTxCents: z.number().optional().describe("Max per-transaction limit"),
      currency: z.string().optional().describe("Currency (e.g. usd)")
    },
    annotations: {
      title: "Get Balance",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    securitySchemes: [{ type: "oauth2", scopes: ["pay", "balance", "revoke"] }],
  } as any,
  async (args, extra: any) => {
    const { intentMandate } = args;
    const { merchantId, apiKey, oauthToken } = getAuth(args, extra);

    if (!intentMandate) {
      return {
        content: [{ type: "text", text: "Missing intentMandate." }],
        isError: true,
      };
    }

    try {
      const headers: Record<string, string> = {
        'x-delegare-merchant-id': merchantId || '',
      };
      if (oauthToken) headers['Authorization'] = `Bearer ${oauthToken}`;
      if (apiKey) headers['x-delegare-api-key'] = apiKey;

      const response = await fetch(`${API_BASE_URL}/v1/mandates/${intentMandate}/balance`, { headers });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || 'Failed to fetch balance');
      }

      const balance = await response.json();
      return {
        content: [
          {
            type: "text",
            text: `Current balance: $${(balance.remainingMonthlySpendCents / 100).toFixed(2)} remaining this month.`,
          },
        ],
        structuredContent: balance,
      };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Failed to retrieve balance: ${e.message}` }],
        structuredContent: { error: e.message }
      };
    }
  }
);

server.registerWidget(
  "pay_merchant",
  { 
    title: "Pay Merchant",
    description: "Receipt UI",
    _meta: {
      ui: {
        csp: {
          connectDomains: ["https://api.delegare.dev", "https://api.sandbox.delegare.dev", "http://localhost:3000"],
          redirectDomains: ["https://app.delegare.dev", "https://app.sandbox.delegare.dev"],
        }
      }
    }
  },
  {
    title: "Pay Merchant",
    description: "Execute a payment to a merchant, crypto wallet, or user handle using your spending delegate.",
    inputSchema: {
      intentMandate: z.string().describe("Your intent mandate (the SD-JWT-VC encoded token)"),
      amountCents: z.number().describe("Amount in cents (e.g., 100 = $1.00)"),
      description: z.string().describe("Payment description or memo"),
      idempotencyKey: z.string().describe("Unique key for the payment to prevent duplicates (e.g., 'pay_merchant_100_001')"),
      recipient: z.string().optional().describe("Optional: The merchant ID, Delegare handle (e.g. 'sunny-violet-panda'), or 0x crypto wallet address to send funds to."),
      _meta: z.any().optional().describe("Internal metadata for transport"),
    },
    outputSchema: {
      receiptId: z.string().optional().describe("Unique receipt ID"),
      status: z.string().optional().describe("Payment status"),
      amountCents: z.number().optional().describe("Amount paid"),
      transaction: z.string().optional().describe("On-chain transaction hash if applicable"),
      network: z.string().optional().describe("Blockchain network if applicable"),
      txExplorerBaseUrl: z.string().optional().describe("Explorer URL base")
    },
    annotations: {
      title: "Pay Merchant",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    securitySchemes: [{ type: "oauth2", scopes: ["pay", "balance", "revoke"] }],
  } as any,
  async (args, extra: any) => {
    const { intentMandate, amountCents, description, recipient, idempotencyKey } = args;
    const { merchantId, apiKey, oauthToken } = getAuth(args, extra);

    if (!intentMandate) {
      return {
        content: [{ type: "text", text: "Payment failed: Missing intentMandate." }],
        isError: true,
      };
    }

    try {
      const receipt = await processPayment(merchantId, apiKey, oauthToken, intentMandate, amountCents, description, recipient, idempotencyKey);
      return {
        content: [
          {
            type: "text",
            text: `Payment of $${(amountCents / 100).toFixed(2)} to ${recipient || description} was successful. Receipt ID: ${receipt.receiptId}`,
          },
        ],
        structuredContent: { ...receipt, txExplorerBaseUrl: TX_EXPLORER_BASE },
      };
    } catch (e: any) {
      let hint = "";
      if (e.message.includes("Invalid JWT") || e.message.includes("not found")) {
        hint = "\n\nHINT: You might need to set up a new spending mandate first. Use the 'request_payment_authorization' tool to set your limits and get a valid intentMandate.";
      }
      return {
        content: [{ type: "text", text: `Payment failed: ${e.message}${hint}` }],
        structuredContent: { error: e.message }
      };
    }
  }
);

server.registerWidget(
  "get_merchant_stats",
  { 
    title: "Get Merchant Stats",
    description: "Stats UI",
    _meta: {
      ui: {
        csp: {
          connectDomains: ["https://api.delegare.dev", "https://api.sandbox.delegare.dev", "http://localhost:3000"],
          redirectDomains: ["https://app.delegare.dev", "https://app.sandbox.delegare.dev"],
        }
      }
    }
  },
  {
    title: "Get Merchant Stats",
    description: "Get performance statistics for your merchant account.",
    inputSchema: { _meta: z.any().optional().describe("Internal metadata for transport") },
    outputSchema: {
      totalVolumeCents: z.number().optional().describe("Total volume in cents"),
      totalTransactions: z.number().optional().describe("Total number of transactions"),
      period: z.string().optional().describe("Reporting period")
    },
    annotations: {
      title: "Get Merchant Stats",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    securitySchemes: [{ type: "oauth2", scopes: ["pay", "balance", "revoke"] }],
  } as any,
  async (args, extra: any) => {
    const { merchantId, apiKey, oauthToken } = getAuth(args, extra);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-delegare-merchant-id': merchantId || '',
      };
      if (oauthToken) headers['Authorization'] = `Bearer ${oauthToken}`;
      if (apiKey) headers['x-delegare-api-key'] = apiKey;

      const response = await fetch(`${API_BASE_URL}/v1/merchants/stats`, { headers });
      if (!response.ok) throw new Error('Failed to fetch merchant stats');
      const stats = await response.json();
      return {
        content: [
          {
            type: "text",
            text: `Merchant Stats for ${merchantId}: $${(stats.totalVolumeCents / 100).toLocaleString()} volume across ${stats.totalTransactions} transactions.`,
          },
        ],
        structuredContent: stats,
      };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Failed to retrieve stats: ${e.message}` }],
        structuredContent: { error: e.message }
      };
    }
  }
);


// NOTE: delegare_login and delegare_signup were ChatGPT-only UI widgets.
// Authentication is now handled via the MCP OAuth spec (HTTP 401 + WWW-Authenticate header),
// which Claude.ai, ChatGPT, and other MCP clients support natively.

export default server;
