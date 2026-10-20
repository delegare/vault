import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';

const isProd = process.env.ENVIRONMENT === 'prod';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
  customProps: (req) => ({
    merchantId: (req as any).merchantId,
  }),
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      id: req.id,
      merchantId: req.raw.merchantId,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
});
