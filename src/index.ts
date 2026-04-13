#!/usr/bin/env node
/**
 * MCP Web App — Cross-App Access (XAA) Sample
 *
 * Demonstrates how an AI agent authenticates a user once via OIDC, then uses
 * the MCP SDK's withCrossAppAccess() middleware to connect to multiple MCP
 * servers — each with its own resource-specific access token.
 *
 * Flow:
 *   1. GET /login  → OIDC redirect to IDP (PKCE)
 *   2. GET /callback → exchange code for ID Token, connect MCP servers via XAA
 *   3. POST /api/chat → SSE-streamed agent loop (Claude + MCP tool calls)
 */

// =============================================================================
// Section 1: Imports & Configuration
// =============================================================================

import { setMaxListeners } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  applyMiddlewares,
  withCrossAppAccess,
} from '@modelcontextprotocol/client';
import * as oidc from 'openid-client';
import express from 'express';
import session from 'express-session';
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

interface TokenReviewRecord {
  raw: string;
  header: unknown;
  payload: unknown;
}

interface IdentityReviewData {
  idToken: TokenReviewRecord;
  delegatedTokens: Record<string, TokenReviewRecord>;
}

interface McpSessionData {
  connectedServers: Map<string, Client>;
  toolServerMap: Map<string, string>;
  resourceServerMap: Map<string, string>;
  tools: Anthropic.Tool[];
  conversationHistory: Anthropic.MessageParam[];
  systemPrompt: string;
  userEmail: string;
  identityReview: IdentityReviewData;
}

// Extend express-session with our PKCE fields
declare module 'express-session' {
  interface SessionData {
    codeVerifier?: string;
    state?: string;
    nonce?: string;
  }
}

// --- Environment ---

const serverEnvConfigs = [
  {
    enabled: process.env.MCP_SERVER_1_ENABLED,
    name: process.env.MCP_SERVER_1_NAME || 'QRTY MCP Server',
    url: process.env.MCP_SERVER_1_URL || 'https://mcp.qrty.page',
    authServerUrl: process.env.MCP_SERVER_1_AUTH_URL || 'https://auth.resource.xaa.dev',
    audience: process.env.MCP_SERVER_1_AUDIENCE || 'https://mcp.qrty.page/mcp',
    scopes: (process.env.MCP_SERVER_1_SCOPES || 'mcp.access').split(','),
  },
  {
    enabled: process.env.MCP_SERVER_2_ENABLED,
    name: process.env.MCP_SERVER_2_NAME || 'Todo0 MCP Server',
    url: process.env.MCP_SERVER_2_URL || 'https://mcp.xaa.dev',
    authServerUrl: process.env.MCP_SERVER_2_AUTH_URL || 'https://auth.resource.xaa.dev',
    audience: process.env.MCP_SERVER_2_AUDIENCE || 'https://mcp.xaa.dev/mcp',
    scopes: (process.env.MCP_SERVER_2_SCOPES || 'todos.read,mcp.access').split(','),
  },
];

const servers: ServerConfig[] = serverEnvConfigs
  .filter((server) => server.enabled !== 'false')
  .map(({ enabled: _enabled, ...server }) => server);

const IDP_URL = process.env.IDP_URL || 'https://idp.xaa.dev';
const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const PORT = parseInt(process.env.PORT || '3333', 10);
const CALLBACK_URL = process.env.CALLBACK_URL || `http://localhost:${PORT}/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

function decodeJwtPart(part: string): unknown {
  try {
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function buildTokenReviewRecord(raw: string | undefined): TokenReviewRecord | null {
  if (!raw) return null;

  const [header = '', payload = ''] = raw.split('.');
  return {
    raw,
    header: decodeJwtPart(header),
    payload: decodeJwtPart(payload),
  };
}

function getTokenScopes(token: TokenReviewRecord | undefined): string[] {
  if (!token || !token.payload || typeof token.payload !== 'object') return [];

  const payload = token.payload as Record<string, unknown>;
  const scopeClaim = payload.scope;
  if (typeof scopeClaim === 'string') {
    return scopeClaim.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  }

  const scpClaim = payload.scp;
  if (Array.isArray(scpClaim)) {
    return scpClaim.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0);
  }

  return [];
}

function formatToolError(
  err: unknown,
  serverName: string,
  identityReview: IdentityReviewData
): string {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const normalizedMessage = rawMessage.toLowerCase();
  const delegatedToken = identityReview.delegatedTokens[serverName];
  const delegatedScopes = getTokenScopes(delegatedToken);

  const deniedByScope =
    normalizedMessage.includes('insufficient_scope') ||
    normalizedMessage.includes('insufficient scope') ||
    normalizedMessage.includes('forbidden') ||
    normalizedMessage.includes('not authorized') ||
    normalizedMessage.includes('permission') ||
    normalizedMessage.includes('403') ||
    normalizedMessage.includes('401');

  if (!deniedByScope) {
    return `Server ${serverName} rejected the action: ${rawMessage}`;
  }

  const scopeText = delegatedScopes.length > 0 ? delegatedScopes.join(', ') : 'no scope claim found in delegated token';
  return [
    `Server ${serverName} rejected the action.`,
    'This likely means the delegated token does not include the permission required for that tool call.',
    `Delegated token scopes: ${scopeText}.`,
    `Original error: ${rawMessage}`,
  ].join(' ');
}

// =============================================================================
// Section 2: connectWithXAA() — Connect to one MCP server using Cross-App Access
// =============================================================================

async function connectWithXAA(
  idToken: string,
  serverConfig: ServerConfig
): Promise<{ mcpClient: Client; getDelegatedAccessToken: () => string | undefined }> {
  const spinner = ora(`Connecting to ${chalk.bold(serverConfig.name)} using Enterprise Managed Auth Flow...`).start();
  let delegatedAccessToken: string | undefined;

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

  const tokenCaptureFetch: typeof fetch = async (input, init) => {
    const authHeader = new Headers(init?.headers).get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      delegatedAccessToken = authHeader.slice('Bearer '.length);
    }
    return fetch(input, init);
  };

  const enhancedFetch = applyMiddlewares(xaaMiddleware)(tokenCaptureFetch);

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

  return {
    mcpClient,
    getDelegatedAccessToken: () => delegatedAccessToken,
  };
}

// =============================================================================
// Section 3: discoverCapabilities() — Find tools & resources across all servers
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
// Section 4: handleToolCall() — Route a single tool call to the right server
// =============================================================================

async function handleToolCall(
  block: Anthropic.ToolUseBlock,
  connectedServers: Map<string, Client>,
  toolServerMap: Map<string, string>,
  resourceServerMap: Map<string, string>
): Promise<{ content: string; serverName: string }> {
  const serverName = toolServerMap.get(block.name);
  if (!serverName) throw new Error(`Unknown tool: ${block.name}`);

  // read_resource is a proxy tool — route by URI, not tool name
  if (block.name === 'read_resource') {
    const uri = (block.input as Record<string, unknown>).uri as string;
    const ownerServer = resourceServerMap.get(uri) || serverName;
    const mcpClient = connectedServers.get(ownerServer)!;
    const result = await mcpClient.readResource({ uri });

    return {
      serverName: ownerServer,
      content: result.contents
        .map((c) => ('text' in c ? c.text : `[Binary: ${c.mimeType}]`))
        .join('\n'),
    };
  }

  // Regular MCP tool call
  const mcpClient = connectedServers.get(serverName)!;
  const result = await mcpClient.callTool({
    name: block.name,
    arguments: block.input as Record<string, unknown>,
  });

  return {
    serverName,
    content: (result.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? JSON.stringify(c))
      .join('\n'),
  };
}

// =============================================================================
// Section 5: Express Web Server
// =============================================================================

// In-memory store: MCP connections and conversation state per session
const mcpSessions = new Map<string, McpSessionData>();

const anthropic = new Anthropic();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // set secure: true when serving over HTTPS
  })
);

// ---------------------------------------------------------------------------
// GET /login — Initiate OIDC authorization (PKCE)
// ---------------------------------------------------------------------------

app.get('/login', async (req, res) => {
  try {
    const oidcConfig = await oidc.discovery(new URL(IDP_URL), CLIENT_ID, CLIENT_SECRET);

    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();

    req.session.codeVerifier = codeVerifier;
    req.session.state = state;
    req.session.nonce = nonce;

    const authUrl = oidc.buildAuthorizationUrl(oidcConfig, new URLSearchParams({
      redirect_uri: CALLBACK_URL,
      scope: 'openid profile email',
      prompt: 'login',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    }));

    res.redirect(authUrl.href);
  } catch (err) {
    console.error('Login error:', err);
    res.redirect('/?error=login_failed');
  }
});

// ---------------------------------------------------------------------------
// GET /callback — Exchange code for tokens, connect MCP servers
// ---------------------------------------------------------------------------

app.get('/callback', async (req, res) => {
  const { codeVerifier, state, nonce } = req.session;

  if (!codeVerifier || !state || !nonce) {
    return res.redirect('/?error=session_expired');
  }

  try {
    const oidcConfig = await oidc.discovery(new URL(IDP_URL), CLIENT_ID, CLIENT_SECRET);
    const callbackUrl = new URL(req.url, CALLBACK_URL);

    const tokens = await oidc.authorizationCodeGrant(oidcConfig, callbackUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    });

    const idToken = tokens.id_token;
    if (!idToken) throw new Error('No ID token received');

    const claims = tokens.claims();
    const userEmail = (claims?.email as string) || (claims?.sub as string) || 'User';

    // Clear PKCE state from session
    delete req.session.codeVerifier;
    delete req.session.state;
    delete req.session.nonce;

    console.log(chalk.cyan(`\nUser authenticated: ${userEmail}`));

    // Connect all MCP servers via XAA
    const connectedServers = new Map<string, Client>();
    const delegatedTokenReaders = new Map<string, () => string | undefined>();
    for (const serverConfig of servers) {
      const { mcpClient, getDelegatedAccessToken } = await connectWithXAA(idToken, serverConfig);
      connectedServers.set(serverConfig.name, mcpClient);
      delegatedTokenReaders.set(serverConfig.name, getDelegatedAccessToken);
    }

    // Discover tools and resources
    const { toolServerMap, resourceServerMap, tools } = await discoverCapabilities(connectedServers);

    const serverSummary = [...connectedServers.keys()].join(', ');
    const systemPrompt = `You are a helpful assistant connected to these MCP servers: ${serverSummary}. Tool descriptions show which server they belong to in [brackets]. Use the appropriate tools when asked.`;
    const delegatedTokens = Object.fromEntries(
      [...delegatedTokenReaders.entries()]
        .map(([serverName, readToken]) => [serverName, buildTokenReviewRecord(readToken())])
        .filter((entry): entry is [string, TokenReviewRecord] => entry[1] !== null)
    );
    const reviewedIdToken = buildTokenReviewRecord(idToken);
    if (!reviewedIdToken) {
      throw new Error('Failed to decode ID token for identity review');
    }

    mcpSessions.set(req.sessionID, {
      connectedServers,
      toolServerMap,
      resourceServerMap,
      tools,
      conversationHistory: [],
      systemPrompt,
      userEmail,
      identityReview: {
        idToken: reviewedIdToken,
        delegatedTokens,
      },
    });

    console.log(chalk.green(`Session ready for ${userEmail}\n`));
    res.redirect('/');
  } catch (err) {
    console.error('Callback error:', err);
    res.redirect('/?error=auth_failed');
  }
});

// ---------------------------------------------------------------------------
// GET /api/status — Return authentication and connection state
// ---------------------------------------------------------------------------

app.get('/api/status', (req, res) => {
  const data = mcpSessions.get(req.sessionID);
  if (data) {
    res.json({
      authenticated: true,
      user: data.userEmail,
      servers: [...data.connectedServers.keys()],
      identityReview: data.identityReview,
    });
  } else {
    res.json({ authenticated: false });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat — SSE-streamed agent loop
// ---------------------------------------------------------------------------

app.post('/api/chat', async (req, res) => {
  const data = mcpSessions.get(req.sessionID);
  if (!data) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { message } = req.body as { message?: string };
  if (!message?.trim()) {
    res.status(400).json({ error: 'Message required' });
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (payload: object) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const { connectedServers, toolServerMap, resourceServerMap, tools, conversationHistory, systemPrompt, identityReview } = data;

  conversationHistory.push({ role: 'user', content: message.trim() });

  try {
    send({ type: 'thinking' });
    let continueLoop = true;

    while (continueLoop) {
      // Stream Claude's response token by token
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages: conversationHistory,
      });

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          send({ type: 'token', text: event.delta.text });
        }
      }

      const response = await stream.finalMessage();
      conversationHistory.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
        );

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of toolUseBlocks) {
          const toolServerName = toolServerMap.get(block.name) || 'Unknown MCP Server';
          send({ type: 'tool_start', name: block.name, server: toolServerName });

          try {
            const { content, serverName } = await handleToolCall(
              block,
              connectedServers,
              toolServerMap,
              resourceServerMap
            );
            send({ type: 'tool_result', name: block.name, server: serverName, preview: content.slice(0, 400) });
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
          } catch (err) {
            const serverName = toolServerMap.get(block.name) || 'Unknown MCP Server';
            const errMsg = formatToolError(err, serverName, identityReview);
            send({ type: 'tool_result', name: block.name, server: serverName, preview: errMsg, isError: true });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: errMsg,
              is_error: true,
            });
          }
        }

        conversationHistory.push({ role: 'user', content: toolResults });
        // Signal that Claude is processing tool results before next response
        send({ type: 'thinking' });
      } else {
        continueLoop = false;
        send({ type: 'done' });
      }
    }
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }

  res.end();
});

// ---------------------------------------------------------------------------
// POST /api/logout — Disconnect MCP clients and destroy session
// ---------------------------------------------------------------------------

app.post('/api/logout', (req, res) => {
  const data = mcpSessions.get(req.sessionID);
  if (data) {
    for (const client of data.connectedServers.values()) {
      client.close().catch(() => {});
    }
    mcpSessions.delete(req.sessionID);
  }
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(chalk.bold.magenta('\n  MCP Web App — Cross-App Access (XAA) Sample'));
  console.log(chalk.gray(`  Running at: ${chalk.cyan(`http://localhost:${PORT}`)}`));
  console.log(chalk.gray(`  Callback URL: ${chalk.cyan(CALLBACK_URL)}`));
  console.log(chalk.gray(`  Configured ${servers.length} MCP server(s):`));
  for (const s of servers) {
    console.log(chalk.gray(`    - ${s.name}: ${s.url}`));
  }
  console.log('');
});
