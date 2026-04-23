const path = require('path');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const fastifyView = require('@fastify/view');
const ejs = require('ejs');
const Parser = require('rss-parser');
const fetch = require('node-fetch');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 6 * 60 * 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const MAX_ITEMS_PER_FEED = Number(process.env.MAX_ITEMS_PER_FEED || 12);
const MAX_ITEMS_PER_CATEGORY = Number(process.env.MAX_ITEMS_PER_CATEGORY || 24);
const ARTICLE_SCRAPE_TIMEOUT_MS = 5000;
const ARTICLE_SCRAPE_CONCURRENCY = 20;
const ARTICLE_SCRAPE_DELAY_MS = 50;

const FEEDS = [
  { category: 'Tech', source: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
  { category: 'Tech', source: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { category: 'Tech', source: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { category: 'Tech', source: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { category: 'AI', source: 'OpenAI News', url: 'https://openai.com/news/rss.xml' },
  { category: 'AI', source: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed' },
  { category: 'AI', source: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml' },
  { category: 'AI', source: 'MIT News AI', url: 'https://news.mit.edu/rss/topic/artificial-intelligence2' },
  { category: 'Geopolitics', source: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { category: 'Geopolitics', source: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { category: 'Geopolitics', source: 'The Guardian World', url: 'https://www.theguardian.com/world/rss' },
  { category: 'Geopolitics', source: 'Foreign Affairs', url: 'https://www.foreignaffairs.com/rss.xml' }
];

const parser = new Parser({
  customFields: {
    item: ['media:content', 'media:thumbnail', 'itunes:image', 'content:encoded', 'description']
  }
});

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty' }
      : undefined
  }
});

const cache = {
  categories: buildEmptyCategories(),
  lastUpdated: null,
  lastAttemptedAt: null,
  feedStatuses: [],
  hasData: false,
  totalItems: 0
};

let refreshInFlight = null;

function buildEmptyCategories() {
  return {
    Tech: [],
    AI: [],
    Geopolitics: []
  };
}

function toDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stripHtml(value) {
  if (!value) {
    return '';
  }

  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value, length) {
  if (!value || value.length <= length) {
    return value;
  }

  return `${value.slice(0, length - 1).trim()}…`;
}

function extractImageUrl(candidate) {
  if (!candidate) {
    return null;
  }

  if (typeof candidate === 'string') {
    return cleanImageUrl(candidate);
  }

  if (Array.isArray(candidate)) {
    for (const entry of candidate) {
      const url = extractImageUrl(entry);
      if (url) {
        return url;
      }
    }

    return null;
  }

  if (typeof candidate === 'object') {
    const mimeType = typeof candidate.type === 'string' ? candidate.type.toLowerCase() : '';
    const medium = typeof candidate.medium === 'string' ? candidate.medium.toLowerCase() : '';

    if ((mimeType && !mimeType.startsWith('image/')) || (medium && medium !== 'image')) {
      return null;
    }

    return (
      extractImageUrl(candidate.url) ||
      extractImageUrl(candidate.href) ||
      extractImageUrl(candidate.image) ||
      extractImageUrl(candidate.$?.url) ||
      extractImageUrl(candidate.$?.href)
    );
  }

  return null;
}

function cleanImageUrl(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'utm_id',
      'utm_name',
      'utm_cid',
      'utm_reader',
      'utm_referrer',
      'utm_social',
      'utm_social-type',
      'fbclid',
      'gclid',
      'mc_cid',
      'mc_eid',
      'igshid',
      'ref',
      'ref_src',
      'source'
    ];

    for (const key of trackingParams) {
      url.searchParams.delete(key);
    }

    return url.toString();
  } catch {
    return trimmed;
  }
}

function resolveImageUrl(candidate, baseUrl) {
  if (!candidate || typeof candidate !== 'string') {
    return null;
  }

  try {
    return cleanImageUrl(new URL(candidate, baseUrl).toString());
  } catch {
    return cleanImageUrl(candidate);
  }
}

function extractImageFromHtml(htmlString) {
  if (!htmlString || typeof htmlString !== 'string') {
    return null;
  }

  const match = htmlString.match(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/i);
  if (!match?.[2]) {
    return null;
  }

  return cleanImageUrl(match[2]);
}

function extractImageFromMetadata(item) {
  return (
    extractImageUrl(item.enclosure) ||
    extractImageUrl(item.image) ||
    extractImageUrl(item['media:content']) ||
    extractImageUrl(item['media:thumbnail']) ||
    extractImageUrl(item.itunes?.image) ||
    extractImageUrl(item['itunes:image']) ||
    null
  );
}

function extractImage(item) {
  return (
    extractImageFromMetadata(item) ||
    extractImageFromHtml(item.description) ||
    extractImageFromHtml(item['content:encoded']) ||
    null
  );
}

function extractInitialImage(item) {
  const metadataImage = extractImageFromMetadata(item);
  if (metadataImage) {
    return {
      image: metadataImage,
      imageSource: 'metadata'
    };
  }

  const htmlImage =
    extractImageFromHtml(item.description) ||
    extractImageFromHtml(item['content:encoded']) ||
    null;

  if (htmlImage) {
    return {
      image: htmlImage,
      imageSource: 'html'
    };
  }

  return {
    image: null,
    imageSource: null
  };
}

async function scrapeArticleImage(url) {
  if (!url) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ARTICLE_SCRAPE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const ogImageMatch = html.match(
      /<meta\b[^>]*property\s*=\s*(["'])og:image\1[^>]*content\s*=\s*(["'])(.*?)\2[^>]*>/i
    ) || html.match(
      /<meta\b[^>]*content\s*=\s*(["'])(.*?)\1[^>]*property\s*=\s*(["'])og:image\3[^>]*>/i
    );

    if (ogImageMatch) {
      const ogImage = resolveImageUrl(ogImageMatch[2] || ogImageMatch[3], url);
      if (ogImage) {
        return ogImage;
      }
    }

    const twitterImageMatch = html.match(
      /<meta\b[^>]*name\s*=\s*(["'])twitter:image\1[^>]*content\s*=\s*(["'])(.*?)\2[^>]*>/i
    ) || html.match(
      /<meta\b[^>]*content\s*=\s*(["'])(.*?)\1[^>]*name\s*=\s*(["'])twitter:image\3[^>]*>/i
    );

    if (twitterImageMatch) {
      const twitterImage = resolveImageUrl(twitterImageMatch[2] || twitterImageMatch[3], url);
      if (twitterImage) {
        return twitterImage;
      }
    }

    const baseUrl = new URL(url);
    const imgPattern = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi;
    let match;

    while ((match = imgPattern.exec(html)) !== null) {
      const candidate = match[2];
      if (!candidate) {
        continue;
      }

      try {
        const imageUrl = resolveImageUrl(candidate, baseUrl);
        if (imageUrl) {
          return imageUrl;
        }
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function extractImageWithFallback(item, logger) {
  const initialImage = extractInitialImage(item);
  if (initialImage.image) {
    return initialImage;
  }

  const scrapedImage = await scrapeArticleImage(item.link);
  if (scrapedImage) {
    logger.info({ url: item.link, image: scrapedImage }, 'Scraped article image');
    return {
      image: scrapedImage,
      imageSource: 'scraping'
    };
  }

  logger.info({ url: item.link }, 'No article image found during scrape');
  return initialImage;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeItem(feed, item) {
  const initialImage = extractInitialImage(item);
  const publishedAt =
    toDate(item.isoDate) ||
    toDate(item.pubDate) ||
    toDate(item.date) ||
    new Date(0);

  const summary = stripHtml(
    item.contentSnippet ||
    item.content ||
    item['content:encoded'] ||
    item.description ||
    ''
  );

  return {
    category: feed.category,
    source: feed.source,
    title: item.title || 'Untitled',
    link: item.link || '#',
    publishedAt,
    publishedAtIso: publishedAt.toISOString(),
    summary: truncate(summary, 220),
    image: initialImage.image,
    imageSource: initialImage.imageSource,
    _rssItem: item
  };
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'tech-watch/1.0 (+https://coolify.io)'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();
    const parsed = await parser.parseString(xml);
    const items = (parsed.items || [])
      .map((item) => normalizeItem(feed, item))
      .filter((item) => item.link && item.title)
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, MAX_ITEMS_PER_FEED);

    return {
      ok: true,
      source: feed.source,
      category: feed.category,
      url: feed.url,
      itemCount: items.length,
      durationMs: Date.now() - startedAt,
      items
    };
  } catch (error) {
    return {
      ok: false,
      source: feed.source,
      category: feed.category,
      url: feed.url,
      itemCount: 0,
      durationMs: Date.now() - startedAt,
      error: error.name === 'AbortError' ? 'Request timed out' : error.message,
      items: []
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshCache() {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    cache.lastAttemptedAt = new Date();

    const results = await Promise.all(FEEDS.map((feed) => fetchFeed(feed)));
    const nextCategories = buildEmptyCategories();
    let totalItems = 0;
    let metadataImageCount = 0;
    let htmlImageCount = 0;
    let scrapedImageCount = 0;

    const itemsToScrape = [];
    let nextScrapeAt = Date.now();

    for (const result of results) {
      if (result.ok) {
        for (const item of result.items) {
          if (item.imageSource === 'metadata') {
            metadataImageCount += 1;
          } else if (item.imageSource === 'html') {
            htmlImageCount += 1;
          } else {
            itemsToScrape.push(item);
          }
        }

        nextCategories[result.category].push(...result.items);
        totalItems += result.items.length;
      }
    }

    await mapWithConcurrency(itemsToScrape, ARTICLE_SCRAPE_CONCURRENCY, async (item, index) => {
      const now = Date.now();
      const scheduledAt = Math.max(nextScrapeAt, now);
      nextScrapeAt = scheduledAt + ARTICLE_SCRAPE_DELAY_MS;

      if (scheduledAt > now) {
        await new Promise((resolve) => setTimeout(resolve, scheduledAt - now));
      }

      const extracted = await extractImageWithFallback(item._rssItem, app.log);
      item.image = extracted.image;
      item.imageSource = extracted.imageSource;

      if (item.imageSource === 'scraping') {
        scrapedImageCount += 1;
      }
    });

    for (const category of Object.keys(nextCategories)) {
      nextCategories[category] = nextCategories[category].map((item) => {
        delete item._rssItem;
        return item;
      });
    }

    for (const category of Object.keys(nextCategories)) {
      nextCategories[category] = nextCategories[category]
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, MAX_ITEMS_PER_CATEGORY);
    }

    const successfulFeeds = results.filter((result) => result.ok).length;
    if (successfulFeeds > 0) {
      cache.categories = nextCategories;
      cache.totalItems = totalItems;
      cache.lastUpdated = new Date();
      cache.hasData = true;
    }

    cache.feedStatuses = results.map((result) => ({
      source: result.source,
      category: result.category,
      ok: result.ok,
      itemCount: result.itemCount,
      error: result.error || null,
      durationMs: result.durationMs
    }));

    app.log.info({
      metadataImageCount,
      htmlImageCount,
      scrapedImageCount,
      totalArticles: totalItems,
      stats: `Image extraction: ${metadataImageCount} from metadata, ${htmlImageCount} from HTML, ${scrapedImageCount} from scraping, total articles: ${totalItems}`,
      successfulFeeds,
      totalFeeds: results.length,
      totalItems: cache.totalItems
    }, 'RSS refresh completed');
    app.log.info(
      `Image extraction: ${metadataImageCount} from metadata, ${htmlImageCount} from HTML, ${scrapedImageCount} from scraping, total articles: ${totalItems}`
    );

    return cache;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function fetchAllFeeds() {
  return refreshCache();
}

function formatTimestamp(value) {
  if (!value) {
    return 'Never';
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(value);
}

function relativeTime(value) {
  const seconds = Math.round((value.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  const ranges = [
    { unit: 'day', seconds: 86400 },
    { unit: 'hour', seconds: 3600 },
    { unit: 'minute', seconds: 60 }
  ];

  for (const range of ranges) {
    if (Math.abs(seconds) >= range.seconds || range.unit === 'minute') {
      return formatter.format(Math.round(seconds / range.seconds), range.unit);
    }
  }

  return 'just now';
}

async function bootstrap() {
  await app.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/public/'
  });

  await app.register(fastifyView, {
    engine: { ejs },
    root: path.join(__dirname, 'views')
  });

  const fs = require('fs');
  const faviconPath = path.join(__dirname, 'public', 'favicon.svg');

  app.get('/favicon.ico', (_request, reply) => {
    return reply.header('Content-Type', 'image/svg+xml').send(fs.readFileSync(faviconPath));
  });

  app.get('/', async (_request, reply) => {
    return reply.view('index.ejs', {
      categories: cache.categories,
      lastUpdated: formatTimestamp(cache.lastUpdated),
      lastAttemptedAt: formatTimestamp(cache.lastAttemptedAt),
      totalItems: cache.totalItems,
      refreshIntervalHours: REFRESH_INTERVAL_MS / (60 * 60 * 1000),
      hasData: cache.hasData,
      feedStatuses: cache.feedStatuses,
      formatArticleDate: formatTimestamp,
      relativeTime
    });
  });

  app.get('/api/refresh', async (_request, reply) => {
    const updatedCache = await fetchAllFeeds();

    return reply.send({
      categories: updatedCache.categories,
      lastUpdated: updatedCache.lastUpdated ? updatedCache.lastUpdated.toISOString() : null,
      lastAttemptedAt: updatedCache.lastAttemptedAt ? updatedCache.lastAttemptedAt.toISOString() : null,
      feedStatuses: updatedCache.feedStatuses,
      hasData: updatedCache.hasData,
      totalItems: updatedCache.totalItems
    });
  });

  app.get('/health', async () => ({
    status: cache.hasData ? 'ok' : 'warming',
    lastUpdated: cache.lastUpdated ? cache.lastUpdated.toISOString() : null,
    lastAttemptedAt: cache.lastAttemptedAt ? cache.lastAttemptedAt.toISOString() : null,
    totalItems: cache.totalItems,
    feeds: cache.feedStatuses
  }));

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.status(500).send('Internal Server Error');
  });

  await refreshCache();

  const interval = setInterval(() => {
    refreshCache().catch((error) => app.log.error(error, 'Scheduled refresh failed'));
  }, REFRESH_INTERVAL_MS);

  interval.unref();

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`tech-watch listening on http://${HOST}:${PORT}`);
}

bootstrap().catch((error) => {
  app.log.error(error, 'Failed to start server');
  process.exit(1);
});
