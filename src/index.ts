#!/usr/bin/env node
/**
 * MCP Client CLI — Cross-App Access (XAA) Sample
 *
 * Demonstrates how an AI agent authenticates a user once via OIDC, then uses
 * the MCP SDK's withCrossAppAccess() middleware to connect to multiple MCP
 * servers — each with its own resource-specific access token.
 *
 * Flow:
 *   1. OIDC login (PKCE) → ID Token 
 *   2. For each MCP server: withCrossAppAccess() exchanges the ID Token for
 *      a resource-specific access token (Token Exchange + JWT Bearer grant)
 *   3. Claude AI chat loop routes tool calls to the correct server
 */

// =============================================================================
// Section 1: Imports & Configuration
// =============================================================================

import { setMaxListeners } from 'node:events';
import readline from 'node:readline';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  applyMiddlewares,
  withCrossAppAccess,
} from '@modelcontextprotocol/client';
import * as oidc from 'openid-client';
import express from 'express';
import open from 'open';
import dotenv from 'dotenv';
import chalk from 'chalk';
import ora from 'ora';

// Suppress MaxListenersExceededWarning from MCP SDK internal polling
setMaxListeners(0);

dotenv.config();

// --- Types ---

interface ServerConfig {
  name: string;
  url: string;
  authServerUrl: string;
  audience: string;
  scopes: string[];
}

interface ResourceInfo {
  uri: string;
  name: string;
  description?: string;
  server: string;
}

// --- Environment ---

const servers: ServerConfig[] = [
  {
    name: process.env.MCP_SERVER_1_NAME || 'QRTY MCP Server',
    url: process.env.MCP_SERVER_1_URL || 'https://mcp.qrty.page',
    authServerUrl: process.env.MCP_SERVER_1_AUTH_URL || 'https://auth.resource.xaa.dev',
    audience: process.env.MCP_SERVER_1_AUDIENCE || 'https://mcp.qrty.page/mcp',
    scopes: (process.env.MCP_SERVER_1_SCOPES || 'mcp.access').split(','),
  },
  {
    name: process.env.MCP_SERVER_2_NAME || 'Todo0 MCP Server',
    url: process.env.MCP_SERVER_2_URL || 'https://mcp.xaa.dev',
    authServerUrl: process.env.MCP_SERVER_2_AUTH_URL || 'https://auth.resource.xaa.dev',
    audience: process.env.MCP_SERVER_2_AUDIENCE || 'https://mcp.xaa.dev/mcp',
    scopes: (process.env.MCP_SERVER_2_SCOPES || 'todos.read,mcp.access').split(','),
  },
];

const IDP_URL = process.env.IDP_URL || 'https://idp.xaa.dev';
const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const CALLBACK_PORT = parseInt(process.env.CALLBACK_PORT || '3333', 10);
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

// =============================================================================
// Section 2: authenticate() — OIDC login via browser, returns ID Token
// =============================================================================

async function authenticate(): Promise<string> {
  const spinner = ora('Discovering OIDC configuration...').start();
  const oidcConfig = await oidc.discovery(new URL(IDP_URL), CLIENT_ID, CLIENT_SECRET);

  // Generate PKCE values
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();

  // Build authorization URL
  const authUrl = oidc.buildAuthorizationUrl(oidcConfig, new URLSearchParams({
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email',
    prompt: 'login',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  }));

  // Start local callback server to receive the authorization code
  let resolveCallback: (url: URL) => void;
  const callbackPromise = new Promise<URL>((resolve) => {
    resolveCallback = resolve;
  });

  const app = express();
  app.get('/callback', (req, res) => {
    res.send(`
      <html>
        <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e;">
          <div style="text-align: center; color: white;">
            <h1 style="color: #4ade80;">Authentication Successful!</h1>
            <p>This window will close automatically...</p>
          </div>
        </body>
        <script>setTimeout(() => window.close(), 1000);</script>
      </html>
    `);
    resolveCallback(new URL(req.url, `http://localhost:${CALLBACK_PORT}`));
  });

  const server = app.listen(CALLBACK_PORT);

  // Open browser and wait for callback
  spinner.text = 'Opening browser for login...';
  await open(authUrl.href);

  spinner.text = 'Waiting for authentication...';
  const callbackUrl = await callbackPromise;
  server.close();

  // Exchange authorization code for tokens
  spinner.text = 'Exchanging code for tokens...';
  const tokens = await oidc.authorizationCodeGrant(oidcConfig, callbackUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState: state,
    expectedNonce: nonce,
    idTokenExpected: true,
  });

  const idToken = tokens.id_token;
  if (!idToken) throw new Error('No ID token received');

  const claims = tokens.claims();
  spinner.succeed(`Authenticated as ${chalk.cyan(claims?.email || claims?.sub)}`);

  return idToken;
}

// =============================================================================
// Section 3: connectWithXAA() — Connect to one MCP server using Cross-App Access
// =============================================================================

async function connectWithXAA(
  idToken: string,
  serverConfig: ServerConfig
): Promise<Client> {
  const spinner = ora(`Connecting to ${chalk.bold(serverConfig.name)} using Enterprise Managed Auth Flow...`).start();

  // This is the key XAA integration point:
  // The middleware handles Token Exchange (ID Token → ID-JAG) at the IDP,
  // then JWT Bearer grant at the MCP authorization server → access token.
  const xaaMiddleware = withCrossAppAccess({
    idpUrl: IDP_URL,
    idToken,
    idpClientId: CLIENT_ID,
    idpClientSecret: CLIENT_SECRET,
    mcpAuthorisationServerUrl: serverConfig.authServerUrl,
    mcpResourceUrl: serverConfig.audience,
    mcpClientId: CLIENT_ID,
    mcpClientSecret: CLIENT_SECRET,
    scope: serverConfig.scopes,
  });

  const enhancedFetch = applyMiddlewares(xaaMiddleware)(fetch);

  const transport = new StreamableHTTPClientTransport(
    new URL(`${serverConfig.url}/mcp`),
    { fetch: enhancedFetch }
  );

  const mcpClient = new Client(
    { name: 'mcp-sample-cli', version: '1.0.0' },
    { capabilities: {} }
  );

  await mcpClient.connect(transport);
  spinner.succeed(`Connected to ${chalk.bold(serverConfig.name)} ${chalk.gray(serverConfig.url)}`);

  return mcpClient;
}

// =============================================================================
// Section 4: discoverCapabilities() — Find tools & resources across all servers
// =============================================================================

async function discoverCapabilities(connectedServers: Map<string, Client>) {
  const toolServerMap = new Map<string, string>();
  const resourceServerMap = new Map<string, string>();
  const tools: Anthropic.Tool[] = [];
  const resources: ResourceInfo[] = [];

  const spinner = ora('Discovering capabilities...').start();

  for (const [serverName, mcpClient] of connectedServers) {
    // Discover tools (some servers may not support this)
    try {
      const { tools: serverTools } = await mcpClient.listTools();
      for (const tool of serverTools) {
        toolServerMap.set(tool.name, serverName);
        tools.push({
          name: tool.name,
          description: `[${serverName}] ${tool.description || tool.name}`,
          input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
        });
      }
    } catch {
      // Server doesn't support tools/list — that's fine
    }

    // Discover resources (some servers may not support this)
    try {
      const { resources: serverResources } = await mcpClient.listResources();
      for (const r of serverResources) {
        resourceServerMap.set(r.uri, serverName);
        resources.push({ uri: r.uri, name: r.name, description: r.description, server: serverName });
      }
    } catch {
      // Server doesn't support resources/list — that's fine
    }
  }

  // Expose MCP resources to Claude as a "read_resource" proxy tool
  if (resources.length > 0) {
    const resourceList = resources
      .map((r) => `${r.uri} [${r.server}]: ${r.description || r.name}`)
      .join(', ');

    toolServerMap.set('read_resource', resources[0].server);
    tools.push({
      name: 'read_resource',
      description: `Read an MCP resource by URI. Available: ${resourceList}`,
      input_schema: {
        type: 'object' as const,
        properties: {
          uri: {
            type: 'string',
            description: 'The resource URI to read',
            enum: resources.map((r) => r.uri),
          },
        },
        required: ['uri'],
      },
    });
  }

  spinner.succeed(
    `Discovered ${chalk.bold(tools.length)} tools and ${chalk.bold(resources.length)} resources across ${chalk.bold(connectedServers.size)} server(s)`
  );

  return { toolServerMap, resourceServerMap, tools };
}

// =============================================================================
// Section 5: handleToolCall() — Route a single tool call to the right server
// =============================================================================

async function handleToolCall(
  block: Anthropic.ToolUseBlock,
  connectedServers: Map<string, Client>,
  toolServerMap: Map<string, string>,
  resourceServerMap: Map<string, string>
): Promise<string> {
  const serverName = toolServerMap.get(block.name);
  if (!serverName) throw new Error(`Unknown tool: ${block.name}`);

  // read_resource is a proxy tool — route by URI, not tool name
  if (block.name === 'read_resource') {
    const uri = (block.input as Record<string, unknown>).uri as string;
    const ownerServer = resourceServerMap.get(uri) || serverName;
    const mcpClient = connectedServers.get(ownerServer)!;
    const result = await mcpClient.readResource({ uri });

    return result.contents
      .map((c) => ('text' in c ? c.text : `[Binary: ${c.mimeType}]`))
      .join('\n');
  }

  // Regular MCP tool call
  const mcpClient = connectedServers.get(serverName)!;
  const result = await mcpClient.callTool({
    name: block.name,
    arguments: block.input as Record<string, unknown>,
  });

  return (result.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? JSON.stringify(c))
    .join('\n');
}

// =============================================================================
// Section 6: chat() — Claude AI chat loop
// =============================================================================

async function chat(
  connectedServers: Map<string, Client>,
  toolServerMap: Map<string, string>,
  resourceServerMap: Map<string, string>,
  tools: Anthropic.Tool[]
) {
  const anthropic = new Anthropic();
  const conversationHistory: Anthropic.MessageParam[] = [];

  const serverSummary = [...connectedServers.keys()].join(', ');
  const systemPrompt = `You are a helpful assistant connected to these MCP servers: ${serverSummary}.
Tool descriptions show which server they belong to in [brackets]. Use the appropriate tools when asked.`;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => {
      process.stdout.write('\r\x1b[K');
      rl.question(q, resolve);
    });

  console.log('\n' + chalk.bold.green('=== MCP Interactive Chat ==='));
  console.log(chalk.gray('Chat with Your Agent about your MCP resources.'));
  console.log(chalk.gray('Type "quit" to exit.\n'));

  // --- Chat loop ---

  while (true) {
    const userInput = await ask(chalk.blue('You: '));
    if (!userInput.trim()) continue;
    if (userInput.trim().toLowerCase() === 'quit') {
      console.log(chalk.yellow('\nGoodbye!'));
      break;
    }

    conversationHistory.push({ role: 'user', content: userInput });
    const spinner = ora({ text: 'Thinking...', color: 'cyan', stream: process.stderr }).start();

    try {
      let response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages: conversationHistory,
      });

      // --- Tool use loop: keep going until Claude is done calling tools ---

      while (response.stop_reason === 'tool_use') {
        conversationHistory.push({ role: 'assistant', content: response.content });

        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
        );
        spinner.text = `Using ${toolUseBlocks.length} tool(s)...`;

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of toolUseBlocks) {
          spinner.text = `Calling ${chalk.bold(block.name)}...`;

          try {
            const content = await handleToolCall(block, connectedServers, toolServerMap, resourceServerMap);
            console.log(chalk.magenta(`\n[TOOL RESULT] ${block.name}: ${content.slice(0, 300)}`));
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
          } catch (err) {
            const errMsg = `Error: ${err instanceof Error ? err.message : err}`;
            console.log(chalk.red(`\n[TOOL ERROR] ${block.name}: ${errMsg}`));
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: errMsg,
              is_error: true,
            });
          }
        }

        conversationHistory.push({ role: 'user', content: toolResults });

        spinner.text = 'Processing results...';
        response = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          tools,
          messages: conversationHistory,
        });
      }

      // --- Display the agent response ---

      spinner.stop();
      conversationHistory.push({ role: 'assistant', content: response.content });

      const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      if (text) {
        console.log(chalk.green('Your Agent: ') + text.text + '\n');
      } else {
        console.log(chalk.yellow('Your Agent: ') + '[No text response]\n');
      }
    } catch (error) {
      spinner.fail('Error');
      console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
      console.log('');
    }
  }

  rl.close();
}

// =============================================================================
// Section 7: main() — Orchestrate auth, connections, and chat
// =============================================================================

async function main() {
  console.log(chalk.bold.magenta('\n  MCP Client CLI — Cross-App Access (XAA) Sample\n'));

  console.log(chalk.gray(`  Configured ${servers.length} MCP server(s):`));
  for (const s of servers) {
    console.log(chalk.gray(`    - ${s.name}: ${s.url}`));
  }
  console.log('');

  // Step 1: Authenticate with the IDP
  const idToken = await authenticate();

  // Step 2: Connect to all MCP servers via XAA
  const connectedServers = new Map<string, Client>();
  for (const serverConfig of servers) {
    const mcpClient = await connectWithXAA(idToken, serverConfig);
    connectedServers.set(serverConfig.name, mcpClient);
  }

  // Step 3: Discover tools and resources
  const { toolServerMap, resourceServerMap, tools } = await discoverCapabilities(connectedServers);

  console.log(chalk.green('\n✔ Ready\n'));

  // Step 4: Start interactive chat
  await chat(connectedServers, toolServerMap, resourceServerMap, tools);

  // Cleanup
  for (const mcpClient of connectedServers.values()) {
    await mcpClient.close();
  }
  console.log(chalk.gray('Disconnected.'));
}

main().catch((err) => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
