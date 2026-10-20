import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';

// Mock the entire AWS SDK client
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return {
    ...actual,
    SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  };
});

// We need fresh module imports per test to reset the cache
let getSecret: typeof import('../lib/secrets').getSecret;
let putSecret: typeof import('../lib/secrets').putSecret;
let cryptoDelegateSecretId: typeof import('../lib/secrets').cryptoDelegateSecretId;
let vaultSecretId: typeof import('../lib/secrets').vaultSecretId;

beforeEach(() => {
  jest.clearAllMocks();
  // Reset module cache so the internal Map cache is fresh
  jest.resetModules();
  const mod = require('../lib/secrets');
  getSecret = mod.getSecret;
  putSecret = mod.putSecret;
  cryptoDelegateSecretId = mod.cryptoDelegateSecretId;
  vaultSecretId = mod.vaultSecretId;
});

describe('secrets — getSecret', () => {
  it('should fetch and parse a JSON secret', async () => {
    mockSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ key: 'value', token: 'abc' }),
    });

    const result = await getSecret('my-secret');
    expect(result).toEqual({ key: 'value', token: 'abc' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('should return cached value on subsequent calls within TTL', async () => {
    mockSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ cached: 'yes' }),
    });

    const first = await getSecret('cached-secret');
    const second = await getSecret('cached-secret');

    expect(first).toEqual({ cached: 'yes' });
    expect(second).toEqual({ cached: 'yes' });
    expect(mockSend).toHaveBeenCalledTimes(1); // Only one API call
  });

  it('should throw if SecretString is empty', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: undefined });
    await expect(getSecret('empty-secret')).rejects.toThrow('no string value');
  });
});

describe('secrets — putSecret', () => {
  it('should update an existing secret via PutSecretValueCommand', async () => {
    mockSend.mockResolvedValueOnce({}); // PutSecretValueCommand succeeds

    await putSecret('existing-secret', '{"data":"updated"}');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('PutSecretValueCommand');
    expect(cmd.input.SecretId).toBe('existing-secret');
    expect(cmd.input.SecretString).toBe('{"data":"updated"}');
  });

  it('should fall back to CreateSecretCommand when secret does not exist', async () => {
    // First call (PutSecretValueCommand) throws ResourceNotFoundException
    const notFound = new ResourceNotFoundException({
      message: 'Secret not found',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(notFound);
    // Second call (CreateSecretCommand) succeeds
    mockSend.mockResolvedValueOnce({});

    await putSecret('new-secret', '{"data":"created"}');

    expect(mockSend).toHaveBeenCalledTimes(2);
    const firstCmd = mockSend.mock.calls[0][0];
    expect(firstCmd.constructor.name).toBe('PutSecretValueCommand');
    const secondCmd = mockSend.mock.calls[1][0];
    expect(secondCmd.constructor.name).toBe('CreateSecretCommand');
    expect(secondCmd.input.Name).toBe('new-secret');
    expect(secondCmd.input.SecretString).toBe('{"data":"created"}');
  });

  it('should also handle ResourceNotFoundException by error name string', async () => {
    const notFound = new Error('Not found');
    (notFound as any).name = 'ResourceNotFoundException';
    mockSend.mockRejectedValueOnce(notFound);
    mockSend.mockResolvedValueOnce({});

    await putSecret('string-rnf', '{"x":1}');

    expect(mockSend).toHaveBeenCalledTimes(2);
    const secondCmd = mockSend.mock.calls[1][0];
    expect(secondCmd.constructor.name).toBe('CreateSecretCommand');
  });

  it('should re-throw non-ResourceNotFoundException errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('Access Denied'));

    await expect(putSecret('denied-secret', '{}')).rejects.toThrow('Access Denied');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('secrets — helper functions', () => {
  it('should generate correct cryptoDelegateSecretId', () => {
    // env defaults to 'dev' in the module
    expect(cryptoDelegateSecretId('mandate_abc')).toBe('delegare/dev/delegates/mandate_abc/crypto');
  });

  it('should generate correct vaultSecretId', () => {
    expect(vaultSecretId()).toBe('delegare/dev/vault');
  });
});
