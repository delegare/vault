import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { logger } from '../lib/logger';
import { createHmac } from 'crypto';

const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-2' });
const WEBHOOK_QUEUE_URL = process.env.WEBHOOK_QUEUE_URL;

export async function startWebhookWorker() {
  if (!WEBHOOK_QUEUE_URL) {
    logger.warn('WEBHOOK_QUEUE_URL not set, WebhookWorker will not start');
    return;
  }

  logger.info({ queue: WEBHOOK_QUEUE_URL }, 'Starting WebhookWorker...');

  // Running in a simple loop for this prototype
  while (true) {
    try {
      const response = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: WEBHOOK_QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20, // Long polling
      }));

      if (!response.Messages || response.Messages.length === 0) {
        continue;
      }

      for (const message of response.Messages) {
        if (!message.Body) continue;

        try {
          const payload = JSON.parse(message.Body);
          const success = await deliverWebhook(payload);

          if (success) {
            await sqs.send(new DeleteMessageCommand({
              QueueUrl: WEBHOOK_QUEUE_URL,
              ReceiptHandle: message.ReceiptHandle!,
            }));
          } else {
            // If it failed, we let it sit in the queue. 
            // SQS Redrive Policy will eventually move it to DLQ.
            // We can explicitly increase visibility timeout for exponential backoff if we wanted,
            // but for now we'll just let SQS handle it.
            logger.warn({ merchantId: payload.merchantId }, 'Webhook delivery failed, leaving in queue for retry');
          }
        } catch (err) {
          logger.error({ err }, 'Error processing webhook message body');
          // Delete malformed messages
          await sqs.send(new DeleteMessageCommand({
            QueueUrl: WEBHOOK_QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle!,
          }));
        }
      }
    } catch (err) {
      logger.error({ err }, 'WebhookWorker loop error');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

async function deliverWebhook(data: any): Promise<boolean> {
  const { webhookUrl, secretKey, payload } = data;
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', secretKey).update(body).digest('hex');

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Delegare-Signature': signature,
        'User-Agent': 'Delegare-Webhooks/1.0',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      logger.info({ url: webhookUrl, status: res.status }, 'Webhook delivered successfully via worker');
      return true;
    } else {
      logger.warn({ url: webhookUrl, status: res.status }, 'Webhook delivery failed with non-2xx status');
      return false;
    }
  } catch (err: any) {
    logger.error({ err: err.message, url: webhookUrl }, 'Webhook delivery exception');
    return false;
  }
}
