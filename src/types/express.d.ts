import { Request } from 'express';

export interface AuthedRequest extends Request {
  merchantId: string;
  isTestMode: boolean;
}

export interface CognitoRequest extends Request {
  cognitoEmail: string;
  cognitoSub: string;
}
