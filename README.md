# tech-watch

`tech-watch` is a self-contained Node.js news watch app for daily monitoring of tech and AI. It aggregates public RSS feeds, caches them in memory, groups stories by category, and serves a lightweight Fastify + EJS web interface that is ready for Coolify Docker deployment.

## Features

- Fastify server with EJS-rendered web UI
- Public RSS aggregation across Tech and AI
- In-memory caching with automatic refresh every 6 hours by default
- Per-feed failure isolation so one broken source does not break the page
- Sorted newest-first article display with source attribution and timestamps
- Dockerfile targeting port `3000` for Coolify
- `/health` endpoint for lightweight monitoring

## Included RSS sources

### Tech

- TechCrunch: `https://techcrunch.com/feed/`
- The Verge: `https://www.theverge.com/rss/index.xml`
- Ars Technica: `https://feeds.arstechnica.com/arstechnica/index`
- Hacker News front page: `https://hnrss.org/frontpage`

### AI

- OpenAI News: `https://openai.com/news/rss.xml`
- VentureBeat AI: `https://venturebeat.com/category/ai/feed`
- Hugging Face Blog: `https://huggingface.co/blog/feed.xml`
- MIT News AI: `https://news.mit.edu/rss/topic/artificial-intelligence2`

## Local run

```bash
npm install
npm start
```

The app listens on `http://localhost:3000` by default.

## Environment variables

Copy `.env.example` if you want to override defaults.

- `PORT`: server port, default `3000`
- `HOST`: bind host, default `0.0.0.0`
- `REFRESH_INTERVAL_MS`: cache refresh interval, default `21600000` (6 hours)
- `FETCH_TIMEOUT_MS`: per-feed request timeout, default `15000`
- `MAX_ITEMS_PER_FEED`: cap items taken from each feed, default `12`
- `MAX_ITEMS_PER_CATEGORY`: cap items displayed per category, default `24`

## Coolify deployment

Use Docker deployment with this repository root. The container exposes port `3000`, so no extra process manager is required.

## Health check

`GET /health`

Returns current cache metadata and per-feed status.
