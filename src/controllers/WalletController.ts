import { Request, Response } from 'express';
import { z } from 'zod';
import { createWalletClient, http, parseEther } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { CredentialService } from '../services/CredentialService';
import { MerchantService } from './MerchantController';
import { generateMerchantName } from '../lib/names';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getSecret, vaultSecretId } from '../lib/secrets';
import { encryptSessionKey } from '../services/SessionKeyVault';
import { logger } from '../lib/logger';

const credentialService = new CredentialService();
const merchantService = new MerchantService();

const ConnectWalletSchema = z.object({
  sessionToken: z.string(),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  ownerEmail: z.string().email(),
});

/**
 * Handles the completion of the crypto wallet setup flow.
 * 
 * 1. Validates the pending setup session.
 * 2. Auto-creates a P2P merchant handle for the user (The "Hack").
 * 3. Creates the SpendingMandate authorized to use the wallet.
 * 4. Generates an isolated ERC-4337 Session Key, KMS-encrypts it, and stores the ciphertext on the mandate row.
 */
export async function connectWallet(req: Request, res: Response): Promise<void> {
  const parsed = ConnectWalletSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const { sessionToken, walletAddress, ownerEmail } = parsed.data;

  const session = await credentialService.getSetupSession(sessionToken);
  if (!session || session.status !== 'pending') {
    res.status(400).json({ code: 'invalid_session', message: 'Session is invalid or expired' });
    return;
  }

  // 0. Uniqueness check — a wallet can only be linked to one account at a time
  const existingWalletOwner = await merchantService.getMerchantByWallet(walletAddress);
  if (existingWalletOwner && existingWalletOwner.contactEmail !== ownerEmail) {
    res.status(409).json({
      code: 'wallet_already_linked',
      message: 'This wallet is already connected to a different Delegare account. Disconnect it there first.',
    });
    return;
  }

  // 1. Resolve User Identity and P2P Handle
  // If the user already has an account (e.g. from a previous Stripe connection),
  // we do not want to orphan them into a brand new merchant account.
  let primaryAccountId: string;
  let merchantHandle = generateMerchantName(walletAddress);

  const existingAccount = await merchantService.getMerchantByEmail(ownerEmail);
  
  const { ddb, TABLE } = await import('../lib/dynamodb');
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');

  if (existingAccount) {
    primaryAccountId = existingAccount.merchantId;
    // Create the funny handle row as a P2P routing alias,
    // marked as a buyer so it doesn't break the UI.
    const aliasAccount = await merchantService.upsertAutoMerchant(merchantHandle, walletAddress, ownerEmail);
    await ddb.send(new UpdateCommand({
      TableName: TABLE.MERCHANTS,
      Key: { merchantId: aliasAccount.merchantId },
      UpdateExpression: 'SET accountType = :buyer, targetMerchantId = :target, updatedAt = :now',
      ExpressionAttributeValues: { ':buyer': 'buyer', ':target': primaryAccountId, ':now': new Date().toISOString() },
    }));

    // Update the primary account with the wallet address and handle
    await ddb.send(new UpdateCommand({
      TableName: TABLE.MERCHANTS,
      Key: { merchantId: primaryAccountId },
      UpdateExpression: 'SET usdcWalletAddress = :w, merchantHandle = :h, updatedAt = :now',
      ExpressionAttributeValues: {
        ':w': walletAddress,
        ':h': merchantHandle,
        ':now': new Date().toISOString(),
      },
    }));
  } else {
    // Brand new user — their funny handle becomes their primary identity
    primaryAccountId = merchantHandle;
    const newAccount = await merchantService.upsertAutoMerchant(merchantHandle, walletAddress, ownerEmail);
    await ddb.send(new UpdateCommand({
      TableName: TABLE.MERCHANTS,
      Key: { merchantId: newAccount.merchantId },
      UpdateExpression: 'SET accountType = :buyer, usdcWalletAddress = :w, updatedAt = :now',
      ExpressionAttributeValues: {
        ':buyer': 'buyer',
        ':w': walletAddress,
        ':now': new Date().toISOString(),
      },
    }));
  }

  // 2. Create the spending delegate tied to the primary account
  const mandate = await credentialService.issueIntentMandate({
    sessionToken,
    ownerId: primaryAccountId,
    ownerEmail,
    smartWalletAddress: walletAddress,
  });

  // 3. Generate a dedicated ERC-4337 Session Key for this mandate
  const sessionKeyPrivate = generatePrivateKey();
  const sessionKeyAddress = privateKeyToAccount(sessionKeyPrivate).address;
  const isTestMode = process.env.ENVIRONMENT !== 'prod';
  const network = isTestMode ? 'base-sepolia' : 'base-mainnet';

  // 4. KMS-encrypt the private key and store the ciphertext on the mandate row.
  //    Encryption context binds the ciphertext to this specific mandateId —
  //    it cannot be decrypted in the context of any other mandate.
  const encryptedSessionKey = await encryptSessionKey(sessionKeyPrivate, mandate.mandateId);

  await ddb.send(new UpdateCommand({
    TableName: TABLE.MANDATES,
    Key: { mandateId: mandate.mandateId, userDid: mandate.userDid },
    UpdateExpression: 'SET encryptedSessionKey = :ek, sessionKeyNetwork = :n, sessionKeyAddress = :a, updatedAt = :now',
    ExpressionAttributeValues: {
      ':ek': encryptedSessionKey,
      ':n': network,
      ':a': sessionKeyAddress,
      ':now': new Date().toISOString(),
    },
  }));

  // 5. Auto-fund the session key with a small ETH gas stipend from the Vault ops wallet.
  //    Gas on Base L2 is ~$0.001/tx, so 0.0003 ETH (~$0.75) covers ~10 txs.
  //    This is absorbed as a cost of goods sold — trivial vs the 3¢+ platform fee per tx.
  try {
    const secrets = await getSecret(vaultSecretId());
    const opsKey = secrets.OPS_WALLET_PRIVATE_KEY;
    if (opsKey) {
      const chain = isTestMode ? baseSepolia : base;
      const rpcUrl = process.env[isTestMode ? 'BASE_SEPOLIA_RPC_URL' : 'BASE_RPC_URL'];
      const opsAccount = privateKeyToAccount(opsKey as `0x${string}`);
      const opsClient = createWalletClient({ account: opsAccount, chain, transport: http(rpcUrl) });
      const GAS_STIPEND = parseEther('0.000005'); // ~3 payMerchant txs on Base L2 (150k gas @ 0.005 gwei + buffer)
      const fundHash = await opsClient.sendTransaction({
        to: sessionKeyAddress,
        value: GAS_STIPEND,
      });
      logger.info({ sessionKeyAddress, fundHash, stipend: '0.0001 ETH' }, 'Session key funded with gas stipend');
    } else {
      logger.warn({ sessionKeyAddress }, 'OPS_WALLET_PRIVATE_KEY not configured — session key has no gas');
    }
  } catch (fundErr: any) {
    // Non-fatal — the mandate is still valid, gas can be added later
    logger.warn({ err: fundErr.message, sessionKeyAddress }, 'Failed to auto-fund session key gas');
  }

  res.status(201).json({
    status: 'completed',
    intentMandate: mandate.mandateId,
    merchantHandle, // Give the user their new identity
    walletAddress,
    sessionKeyAddress, // The frontend must prompt the user to authorize this public address on their Smart Wallet!
  });
}
