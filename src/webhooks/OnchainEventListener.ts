import { Request, Response } from 'express';
import { UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/dynamodb';

interface AlchemyWebhookEvent {
  type: string;
  event: {
    data: {
      block: {
        transactions: Array<{
          hash: string;
          status: number; // 1 = success, 0 = failed
        }>;
      };
    };
  };
}

/**
 * Receives on-chain event notifications from Alchemy.
 * Used to update transaction status for async crypto settlements.
 *
 * Configure in Alchemy Dashboard:
 * - Webhook type: Address Activity
 * - Address: Delegare payment contract on Base
 * - URL: https://api.delegare.dev/v1/webhooks/onchain
 */
export async function handleOnchainEvent(req: Request, res: Response): Promise<void> {
  // Validate Alchemy signature
  const alchemyToken = req.headers['x-alchemy-token'];
  const expectedToken = process.env.ALCHEMY_WEBHOOK_TOKEN;

  if (!expectedToken || alchemyToken !== expectedToken) {
    res.status(401).json({ code: 'unauthorized' });
    return;
  }

  const body = req.body as AlchemyWebhookEvent;

  if (body.type === 'MINED_TRANSACTION') {
    const txs = body.event?.data?.block?.transactions ?? [];
    for (const tx of txs) {
      const status = tx.status === 1 ? 'completed' : 'failed';
      await updateTransactionByTxHash(tx.hash, status);
    }
  }

  res.json({ received: true });
}

async function updateTransactionByTxHash(
  txHash: string,
  status: 'completed' | 'failed',
): Promise<void> {
  // Query the txHashIndex GSI to find the receipt
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE.TRANSACTIONS,
      IndexName: 'txHashIndex',
      KeyConditionExpression: 'txHash = :hash',
      ExpressionAttributeValues: { ':hash': txHash },
      Limit: 1,
    }),
  );

  const item = result.Items?.[0];
  if (!item) return;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE.TRANSACTIONS,
        Key: { receiptId: item['receiptId'] as string },
        UpdateExpression: 'SET #status = :status, completedAt = :now',
        ConditionExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': status,
          ':pending': 'pending',
          ':now': new Date().toISOString(),
        },
      }),
    );
  } catch (err) {
    // Already updated or other error
  }
}
