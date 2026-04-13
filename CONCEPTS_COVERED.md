# Concepts Covered in This Repository

This document summarizes the key LLM, identity, agent, and MCP concepts demonstrated by the sample app.

## 1) Identity for AI Agents (Human-in-the-loop Authentication)

- The app authenticates a **human user** with OpenID Connect (OIDC) and Authorization Code Flow with PKCE.
- The user session is established once, then reused to let the agent act on the user’s behalf.
- PKCE protections are implemented via a `codeVerifier` + `codeChallenge`, with `state` and `nonce` checks to prevent interception/replay and CSRF-style issues.

## 2) OIDC Tokens and Claims

- The callback exchanges an authorization code for tokens and requires an `id_token`.
- The app reads user claims from token response (`email`, etc.) and stores identity context in session state.
- It also decodes JWT parts (header + payload) for transparent identity review in the UI.

## 3) Cross-App Access (XAA) and Delegation

- A central idea is that one authenticated identity can be delegated across multiple protected MCP resources.
- The app uses `withCrossAppAccess()` middleware to handle:
  1. Token exchange at the identity provider
  2. JWT bearer grant at each MCP authorization server
  3. Issuance of **resource-specific delegated access tokens**
- This demonstrates **least privilege** at resource level: each server can require different scopes.

## 4) Multi-Server Authorization Model

- MCP servers are configured independently (URL, auth server URL, audience, scopes).
- Each server is connected with its own delegated token, rather than one broad token for everything.
- Per-server scopes illustrate practical fine-grained authorization design (`mcp.access`, `todos.read`, etc.).

## 5) MCP Capability Discovery

- After connecting, the client discovers each server’s capabilities:
  - Tools (`tools/list`)
  - Resources (`resources/list`)
- Tool and resource ownership maps are built so later calls can be routed to the correct server.
- A synthetic proxy tool (`read_resource`) exposes MCP resources consistently to the model.

## 6) Agentic Tool-Use Loop (LLM + Tools)

- The app runs an iterative loop with Claude:
  1. Send conversation + tool schema
  2. Stream model text tokens to UI (SSE)
  3. If model emits `tool_use`, execute MCP tool calls
  4. Return `tool_result` blocks to model
  5. Continue until model emits final answer
- This is a canonical **agent/tool orchestration** pattern with explicit tool contracts.

## 7) Tool Routing and Multi-Backend Mediation

- Tool calls are routed through a `toolServerMap` (tool -> MCP server).
- Resource reads are routed by resource URI owner (`resourceServerMap`).
- The app acts as an **agent runtime gateway**: model proposes actions, runtime enforces backend boundaries.

## 8) Permission Diagnostics and Identity Observability

- The sample surfaces delegated token scopes and improves unauthorized error messages.
- When tool calls fail with auth/permission indicators, errors include likely scope mismatch causes.
- This is important for debugging agent behavior where failures are often auth-policy driven.

## 9) Session-Oriented Agent State

- Per-user session state stores connected servers, discovered tools, resource maps, history, and identity review data.
- This demonstrates practical runtime concerns:
  - Session isolation
  - Stateful chat continuity
  - Graceful logout and connection cleanup

## 10) Security and Architecture Principles Illustrated

- **User-centric delegation:** agent acts only after user login.
- **Bounded delegation:** token audience/scope constrained per MCP resource.
- **Defense in depth:** PKCE + state + nonce + server-side session checks.
- **Separation of concerns:** identity, token exchange, transport, tool dispatch, and UI streaming are modular.

## 11) MCP in the LLM Stack (Conceptual Positioning)

- MCP provides a standardized interface for exposing tools/resources from external systems.
- The LLM does not call arbitrary services directly; it calls MCP-described tools.
- Identity and authorization layers (OIDC + XAA) wrap MCP calls so tool use is policy-controlled.

## 12) What This Repo Teaches End-to-End

- How to convert a normal OIDC login into delegated, multi-resource access for AI tooling.
- How to connect one agent to multiple MCP servers safely.
- How to build transparent identity review so developers can inspect delegated tokens and scopes.
- How to stream LLM responses while interleaving real tool execution.
