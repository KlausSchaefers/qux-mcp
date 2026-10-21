# Quant-UX MCP server

The endpoints for coding agents (Claude Code, Cursor, VS Code, any MCP
client) live here. An agent reads the designs of a user: apps, screens,
links, design tokens and components, and the HTML of each screen. The agent
logs in by itself: the user only clicks *Allow* on a Quant-UX page.

## Connect an agent

Nothing to install, the server runs next to Quant-UX:

```sh
claude mcp add --transport http quant-ux https://mcp.quant-ux.com/mcp
```

The first call answers `401`. The client then discovers the login (OAuth 2.1 with
PKCE and dynamic client registration), opens the browser, the user approves, and
the client continues with its own token. In Claude Code: `/mcp` > *Authenticate*.

Agents that cannot log in (a script, a CI job) send a personal access token from
*My account > Connected agents*:

```sh
claude mcp add --transport http quant-ux https://mcp.quant-ux.com/mcp --header "Authorization: Bearer qux_pat_..."
```

## Tools (read only)

| Tool | What for |
|---|---|
| `list_apps` | Find the app the user means |
| `get_app_overview` | Screens, start screen, links between screens, design system summary |
| `get_design_tokens` | Tokens as `css` (variables + text classes) or `json` (role, usage, value) |
| `get_screen_handoff` | Everything to build one screen: rules, components and their states, images, links and the HTML (`data-qid` on every element) |
| `get_image` | An image of a screen, as image content (and a download link) |

Apps and screens are given by id or by name.

## Run

```sh
npm install
npm start           # HTTP server on PORT (default 8090)
npm test            # against a fake backend
```

Or with Docker:

```sh
docker build -t quant-ux-mcp .
docker run -p 8090:8090 \
  -e QUX_PUBLIC_URL=https://mcp.quant-ux.com \
  -e QUX_ISSUER=https://app.quant-ux.com \
  -e QUX_API_URL=http://backend:8080 \
  quant-ux-mcp
```

| Env | Default | |
|---|---|---|
| `QUX_PUBLIC_URL` | `http://localhost:8090` | Public URL of this server, e.g. `https://mcp.quant-ux.com`; the MCP endpoint is `<url>/mcp` |
| `QUX_ISSUER` | `QUX_PUBLIC_URL` | The OAuth authorization server: quant-ux, e.g. `https://app.quant-ux.com`, which proxies `/oauth` and `/.well-known` to the backend |
| `QUX_API_URL` | `QUX_ISSUER` | How this server reaches the backend, e.g. an internal URL |
| `PORT` | `8090` | |
| `QUX_ASSET_SECRET` | random per start | Key of the image download links (set it when several servers run) |

## Local development

The server needs the three parts of Quant-UX running locally:

| Part | Repo | Example |
|---|---|---|
| Backend (API + OAuth) | [matc_java](https://github.com/KlausSchaefers/matc_java) | `:8082`, with `oauth.issuer` = the frontend URL |
| Frontend (login proxy + consent page) | [quant-ux](https://github.com/KlausSchaefers/matc_vue) | `QUX_API_SERVER=http://localhost:8082 VUE_APP_QUX_MCP_URL=http://localhost:8091/mcp vue-cli-service serve --port 8085` |
| This server | qux-mcp | `PORT=8091 QUX_PUBLIC_URL=http://localhost:8091 QUX_ISSUER=http://localhost:8085 QUX_API_URL=http://localhost:8082 npm start` |

Then `claude mcp add --transport http quant-ux http://localhost:8091/mcp`.

`npm run e2e` runs the whole login as an MCP client against that setup. It
creates a user and an app, so never point it at production:

```sh
QUX_API=http://localhost:8082 MCP_URL=http://localhost:8091/mcp npm run e2e
```

## The editor code (vendor/)

The HTML and tokens an agent gets come from the same code as the editor
(QUX2HTML, TokenMapper, DesignSystem), through `src/headless/DesignHandoff.js`
of quant-ux. `vendor/headless.js` is that file bundled, and it is committed, so
this server runs without the editor. When the editor code changes:

```sh
QUX_APP_SRC=../quant-ux/src npm run vendor
npm test
```

The first line of `vendor/headless.js` names the quant-ux commit it was built from.

## How it fits together

```
agent ──/mcp──► MCP server (mcp.quant-ux.com) ──/rest/ai (Bearer)──► backend (resource + authorization server)
  │                                                                    ▲
  │   login (OAuth)                                                    │ /oauth/*, /.well-known (proxy)
  └──────────────► quant-ux (app.quant-ux.com) ────────────────────────┘
                     /#/agent/authorize.html: the user clicks Allow
```

- This server runs on its own host and serves `/mcp`, its resource metadata
  (`/.well-known/oauth-protected-resource/mcp`) and the image links (`/mcp/assets/`).
  The metadata names quant-ux (`QUX_ISSUER`) as the authorization server.
- quant-ux proxies `/oauth` and `/.well-known` to the backend and shows the consent
  page and *My account > Connected agents*. It knows nothing else of this server,
  only its URL to show it (`VUE_APP_QUX_MCP_URL`).
- Tokens are bound to this server (RFC 8707): a token for another resource is rejected.
- Tokens are read only: `qux_at_` (1 hour) + `qux_rt_` (60 days, rotating) from OAuth, `qux_pat_` (up to 1 year).
- A token never grants more than the user has: the backend checks the Team ACL on every call.
  Agent tokens only reach the design routes, never the account, password, teams, app secrets or the AI proxy.
- A new password, a retired user or *Disconnect* in *My account* revokes the tokens at once.

## Add a tool

1. The data comes from `/rest/ai` of the backend: add a method to `src/QuxClient.js`
   (and the route to the backend if it is new).
2. Register the tool in `src/tools.js`. Tools are read only (`readOnlyHint`) while
   the token scope is `apps:read`; a tool that writes needs a new scope in the
   backend and in `SCOPES` of `src/http.js`.
3. Add a case to `test/http.test.js` (the fake backend is at the top).
