import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from 'http';
import app from '../../../src/app';

let server: Server;
let client: Client;
let transport: StreamableHTTPClientTransport;

beforeAll((done) => {
  // 1. Start the vault server on a random port
  server = app.listen(0, async () => {
    const port = (server.address() as any).port;
    
    // 2. Connect the MCP client to the local HTTP endpoint
    transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    
    try {
      await client.connect(transport);
      done();
    } catch (e) {
      console.error('Failed to connect MCP client', e);
      done(e);
    }
  });
});

afterAll(async () => {
  if (client) {
    try { await client.close(); } catch (e) {}
  }
  if (server) {
    server.close();
  }
});

describe('Delegare MCP — full agent payment flow', () => {
  // In a real e2e test we would generate these via the actual Vault APIs.
  // For this integration test, we will mock the responses or set up real records if DynamoDB Local is running.
  // Since we already mocked the Vault API in payments.test.ts, we'll verify the MCP layer correctly translates.

  it('lists available tools', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).toEqual(
      expect.arrayContaining([
        'setup_payment_delegate',
        'check_agent_balance',
        'pay_merchant',
        'revoke_delegate',
      ])
    );
  });
});
