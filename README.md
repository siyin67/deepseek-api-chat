# chat-demo

English | [简体中文](README.zh-CN.md)

A chat app built on the DeepSeek API, modified into a self-hosted service: accounts, server-side conversation storage, and server-side model forwarding. The browser never holds the model API key — it only talks to this application's own `/api`.

Compared with the original static demo, conversations and messages live in PostgreSQL and are shared across devices after logging in. The UI and interactions are unchanged, apart from the added login screen.

## Getting started (development)

Requirements: Node.js 22+, pnpm, and a PostgreSQL instance (or `docker run -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16-alpine`).

```sh
# 1) front-end dependencies
pnpm install

# 2) server dependencies
cd server && npm install && cd ..

# 3) environment
cp deploy/.env.example deploy/.env   # then edit it
# DATABASE_URL, APP_ENCRYPTION_KEY are required; generate a key with:
openssl rand -base64 32

# 4) run the server (port 3000) and the front-end dev server (port 8090)
cd server && npm run dev          # terminal 1
pnpm dev                          # terminal 2, proxies /api to :3000
```

Open http://localhost:8090, register an account, then either set your own model key under Settings → Data or provide `DEEPSEEK_API_KEY` on the server as a fallback.

Type checks: `pnpm type` (front-end) and `cd server && npm run build` (server).

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.
- Email + password accounts; conversations, messages, and the encrypted model key are stored server-side and synced across devices.

## Data and storage

The server is the source of truth:

- Accounts, conversations, messages, and the encrypted model key live in PostgreSQL.
- The model key is stored with AES-256-GCM under `APP_ENCRYPTION_KEY`; the API only ever returns a mask such as `sk-***abcd`.
- The browser sends requests to this application's `/api` with a bearer token and never sees a plaintext key.
- IndexedDB remains as a **cache only**: the sidebar renders conversation metadata first, message bodies are fetched when a conversation is opened, and older messages are paged in when you scroll to the top. Local settings (theme, language, voice) stay in localStorage.

History import and export in Settings still use ZIP archives; imported conversations are pushed to the server. Exports include conversations and locally available original images, but exclude API keys and settings. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format.

Settings → Data → Delete all chats clears all conversations on the server and the local cache after confirmation, stops ongoing replies, and returns to a new chat.

## Deployment

Docker deployment files live in [`deploy/`](deploy/README.md): a multi-stage `Dockerfile`, `docker-compose.yml` (app + PostgreSQL + Caddy), a `Caddyfile` that disables buffering and compression for the streaming endpoint, and `.env.example`. Start-up instructions and the full environment variable table are in [deploy/README.md](deploy/README.md).

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Front-end dev server on 8090 |
| `pnpm build`  | Build front-end into `dist/` |
| `pnpm type`   | Front-end type checks        |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) proxies `/api` to `http://127.0.0.1:3000` during development; pass `createConfig({ devServer })` to customize it.

```text
deploy/                Docker, reverse proxy, environment template
docs/                  Design notes for the self-hosted migration
server/                API server (Fastify + PostgreSQL)
  src/config.ts        Environment validation
  src/crypto.ts        Password hashing, token, key encryption
  src/context.ts       Context assembly and token budgeting
  src/routes/          auth, model key, sessions, turns, files, speech
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, login, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, streaming SSE, and protocol types
    chat/              Conversations, message branches, server sync, history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
