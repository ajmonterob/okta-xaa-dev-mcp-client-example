# Okta XAA MCP Client Example

This example shows how to use the [MCP SDK][] and [Cross-App Access (XAA)][] to authenticate a user once via OIDC, then connect to multiple MCP servers — each with its own resource-specific access token. The authentication is achieved through the [Authorization Code Flow with PKCE](https://auth0.com/docs/flows/authorization-code-flow-with-proof-key-for-code-exchange-pkce), where the user is redirected to the [XAA Playground](https://xaa.dev/idp) IDP login page. After the user authenticates, the SDK's `withCrossAppAccess()` middleware handles Token Exchange and JWT Bearer grants to obtain access tokens for each MCP server.

This code sample demonstrates:
* Authenticating with the [XAA Playground][] IDP using OIDC + PKCE
* Using Cross-App Access (XAA) to connect to multiple MCP servers with a single login
* Routing Claude AI tool calls to the correct MCP server
* Interactive chat with Claude using tools from multiple MCP servers

## Prerequisites

Before running this sample, you will need the following:

* [Node.js 18+](https://nodejs.org/)
* Client Credentials from a [XAA Playground](https://xaa.dev) application registration:
  * Client ID
  * Client Secret
* An [Anthropic API key](https://console.anthropic.com/) for Claude AI

## Get the Code

```bash
git clone https://github.com/okta-samples/mcp-client-cli.git
cd mcp-client-cli
```

Copy `.env.sample` to `.env` and update it with the values from your application's configuration:

```bash
cp .env.sample .env
```

```text
IDP_URL=https://idp.xaa.dev
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
```

### Where are my app's credentials?

Register at the [XAA Playground](https://xaa.dev) to obtain your client credentials. The playground provides:
- **Client ID** and **Client Secret** for authenticating with the IDP
- Pre-configured MCP servers (QRTY MCP Server and Todo0 MCP Server) ready for Cross-App Access

## Run the Example

Install dependencies:

```bash
npm install
```

Build and start the application:

```bash
npm run build
npm start
```

The CLI will:
1. Open your browser for IDP login at the XAA Playground
2. Exchange the authorization code for an ID Token
3. Connect to each configured MCP server using Cross-App Access (XAA)
4. Start an interactive chat session with Claude AI

You can ask Claude to use tools from any connected server. For example:
- "What tools do you have?" — lists tools from all servers
- "Show my todos" — routes to the Todo0 MCP Server
- "Create a QR code for https://example.com" — routes to the QRTY MCP Server

Type `quit` to exit.

## How XAA Works

The key integration point is the `withCrossAppAccess()` middleware from the MCP SDK:

```typescript
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
```

This middleware automatically handles:
1. **Token Exchange** at the IDP — exchanges the ID Token for an ID-JAG (Identity JWT Authorization Grant)
2. **JWT Bearer Grant** at the MCP Authorization Server — exchanges the ID-JAG for a resource-specific access token

## Helpful Resources

* [XAA Playground](https://xaa.dev)
* [MCP SDK Documentation](https://modelcontextprotocol.io/)
* [Cross-App Access (XAA) Specification](https://datatracker.ietf.org/doc/draft-parecki-oauth-cross-app-access/)
* [Authorization Code Flow with PKCE](https://developer.okta.com/docs/guides/implement-grant-type/authcodepkce/main/)

## Help

Please visit our [Okta Developer Forums](https://devforum.okta.com/).

[MCP SDK]: https://github.com/modelcontextprotocol/typescript-sdk
[Cross-App Access (XAA)]: https://datatracker.ietf.org/doc/draft-parecki-oauth-cross-app-access/
[XAA Playground]: https://xaa.dev
[Authorization Code Flow with PKCE]: https://developer.okta.com/docs/guides/implement-grant-type/authcodepkce/main/
