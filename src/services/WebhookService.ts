import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { logger } from '../lib/logger';
import { createHmac } from 'crypto';

const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-2' });
const WEBHOOK_QUEUE_URL = process.env.WEBHOOK_QUEUE_URL;

export interface WebhookPayload {
  event: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded';
  data: any;
  timestamp: string;
}

export class WebhookService {
  /**
   * Dispatches a webhook to the merchant.
   * In production, this sends the task to an SQS queue for background processing with retries.
   * If no queue is configured, it attempts a one-time direct delivery.
   */
  static async dispatch(merchantId: string, webhookUrl: string | undefined, secretKey: string, payload: WebhookPayload): Promise<void> {
    if (!webhookUrl) return;

    if (WEBHOOK_QUEUE_URL) {
      try {
        await sqs.send(new SendMessageCommand({
          QueueUrl: WEBHOOK_QUEUE_URL,
          MessageBody: JSON.stringify({
            merchantId,
            webhookUrl,
            secretKey,
            payload,
            attempt: 1,
          }),
        }));
        logger.info({ merchantId, event: payload.event }, 'Webhook queued for delivery');
        return;
      } catch (err) {
        logger.error({ err, merchantId }, 'Failed to queue webhook, attempting direct delivery');
      }
    }

    // Fallback: Direct one-time delivery
    void this.deliverDirectly(webhookUrl, secretKey, payload);
  }

  private static async deliverDirectly(url: string, secretKey: string, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', secretKey).update(body).digest('hex');

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Delegare-Signature': signature,
          'User-Agent': 'Delegare-Webhooks/1.0',
        },
        body,
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        logger.info({ url, status: res.status }, 'Webhook delivered directly');
      } else {
        logger.warn({ url, status: res.status }, 'Webhook direct delivery failed');
      }
    } catch (err: any) {
      logger.error({ err: err.message, url }, 'Webhook direct delivery exception');
    }
  }
}
