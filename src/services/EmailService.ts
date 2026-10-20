import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { logger } from '../lib/logger';

const ses = new SESClient({ region: process.env.AWS_REGION || 'us-east-2' });

const SENDER_EMAIL = process.env.SENDER_EMAIL
  || (process.env.ENVIRONMENT === 'prod' ? 'receipts@delegare.dev' : 'receipts@sandbox.delegare.dev');

export interface SendReceiptParams {
  toEmail: string;
  amountCents: number;
  merchantName: string;
  description: string;
  receiptId: string;
}

export class EmailService {
  static async sendReceipt(params: SendReceiptParams): Promise<void> {
    if (!params.toEmail) return;
    
    // In dev mode, don't actually hit SES unless SENDER_EMAIL is real
    if (process.env.NODE_ENV !== 'production' && SENDER_EMAIL === 'receipts@delegare.dev') {
      logger.info({ email: params.toEmail, receipt: params.receiptId }, 'Mock email sent (development)');
      return;
    }

    const amountStr = `$${(params.amountCents / 100).toFixed(2)}`;
    
    try {
      await ses.send(
        new SendEmailCommand({
          Source: SENDER_EMAIL,
          Destination: { ToAddresses: [params.toEmail] },
          Message: {
            Subject: {
              Data: `Delegare Receipt: ${amountStr} to ${params.merchantName}`,
              Charset: 'UTF-8',
            },
            Body: {
              Text: {
                Data: `Your AI agent just made a payment via Delegare.\n\nAmount: ${amountStr}\nMerchant: ${params.merchantName}\nDescription: ${params.description}\nReceipt ID: ${params.receiptId}\n\nTo view your delegate limits or revoke access, visit your dashboard at ${process.env.SETUP_UI_URL || 'https://app.delegare.dev'}`,
                Charset: 'UTF-8',
              },
              Html: {
                Data: `
                  <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px; padding: 24px;">
                    <h2 style="margin-top: 0;">Payment Receipt</h2>
                    <p>Your AI agent completed an autonomous payment.</p>
                    <table style="width: 100%; border-collapse: collapse; margin-top: 24px;">
                      <tr><td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #666;">Amount</td><td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; text-align: right;">${amountStr}</td></tr>
                      <tr><td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #666;">Merchant</td><td style="padding: 8px 0; border-bottom: 1px solid #eee; text-align: right;">${params.merchantName}</td></tr>
                      <tr><td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #666;">Description</td><td style="padding: 8px 0; border-bottom: 1px solid #eee; text-align: right;">${params.description}</td></tr>
                      <tr><td style="padding: 8px 0; color: #666;">Receipt ID</td><td style="padding: 8px 0; text-align: right; font-family: monospace;">${params.receiptId}</td></tr>
                    </table>
                    <p style="margin-top: 32px; font-size: 13px; color: #888;">
                      To view your delegate limits or revoke access, visit your <a href="${process.env.SETUP_UI_URL || 'https://app.delegare.dev'}" style="color: #0066cc;">Delegare dashboard</a>.
                    </p>
                  </div>
                `,
                Charset: 'UTF-8',
              },
            },
          },
        })
      );
      logger.info({ email: params.toEmail, receiptId: params.receiptId }, 'Receipt email sent');
    } catch (err: any) {
      // Non-fatal — email failure must never break a payment. Log prominently so it's visible in CloudWatch.
      const code = err?.name || err?.Code || 'unknown';
      const hint = code === 'MessageRejected'
        ? ' HINT: The sending domain is likely not verified in SES. Run `cdk deploy` to create the EmailIdentity and DKIM records.'
        : code === 'AccessDenied'
        ? ' HINT: The ECS task role is missing ses:SendEmail permission.'
        : '';
      logger.error(
        { err, senderEmail: SENDER_EMAIL, toEmail: params.toEmail, receiptId: params.receiptId, errorCode: code },
        `Failed to send receipt email via SES [${code}].${hint}`,
      );
    }
  }
}