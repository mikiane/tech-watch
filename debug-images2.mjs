// Comprehensive debug - test ALL our feeds
import Parser from 'rss-parser';

const allFeeds = [
  { url: 'https://feeds.arstechnica.com/arstechnica/index', name: 'Ars Technica' },
  { url: 'https://techcrunch.com/feed/', name: 'TechCrunch' },
  { url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge' },
  { url: 'https://hnrss.org/frontpage', name: 'HackerNews' },
  { url: 'https://wired.com/feed/rss', name: 'Wired' },
  { url: 'https://www.wired.com/feed/tag/ai/latest/rss', name: 'Wired AI' },
  { url: 'https://www.wired.com/tag/artificial-intelligence/feed/', name: 'Wired AI (alt)' },
];

async function testFeed(feedConfig) {
  // Test with custom fields
  const parser = new Parser({
    customFields: {
      item: ['media:content', 'media:thumbnail', 'content:encoded', 'description']
    }
  });
  const result = await parser.parseURL(feedConfig.url);
  
  // Also fetch raw XML for first feed
  let rawSnippet = '';
  const resp = await fetch(feedConfig.url, {
    headers: { 'user-agent': 'Mozilla/5.0' }
  });
  rawSnippet = await resp.text();
  rawSnippet = rawSnippet.slice(0, 3000);
  
  // Find <img> tags in raw XML
  const rawImgs = rawSnippet.match(/<img[^>]+src="([^"]+)"/g) || [];
  console.log(`\n\n================== ${feedConfig.name} ==================`);
  console.log(`Total items: ${result.items.length}`);
  console.log(`Raw XML has <img> tags: ${rawImgs.length > 0 ? rawImgs[0].slice(0, 120) : 'none'}`);
  
  let stats = { meta: 0, enclosure: 0, html: 0, none: 0 };
  
  for (const item of result.items) {
    const enclosure = item.enclosure?.url;
    const mediaContent = item['media:content'];
    const mediaThumb = item['media:thumbnail'];
    
    let hasMeta = false;
    if (enclosure) { stats.meta++; hasMeta = true; }
    if (mediaContent) {
      const url = typeof mediaContent === 'object' 
        ? (mediaContent.url || mediaContent?.$?.url || mediaContent.$.href) 
        : mediaContent;
      if (url) { if (!hasMeta) stats.meta++; hasMeta = true; }
    }
    if (mediaThumb) {
      const url = typeof mediaThumb === 'object' 
        ? (mediaThumb.url || mediaThumb?.$?.url) 
        : mediaThumb;
      if (url) { if (!hasMeta) stats.meta++; hasMeta = true; }
    }
    
    const desc = item.description || '';
    const encoded = item['content:encoded'] || '';
    const htmlImg = (desc + encoded).match(/<img[^>]+src=["']([^"']+)/i);
    if (htmlImg) stats.html++;
    if (!hasMeta && !htmlImg) stats.none++;
  }
  
  console.log(`Image stats: meta=${stats.meta}, html=${stats.html}, none=${stats.none}`);
  
  // Show first item with an image
  for (const item of result.items.slice(0, 3)) {
    const mc = item['media:content'];
    if (mc && typeof mc === 'object') {
      console.log(`\n  Media:content structure:`, JSON.stringify(mc, null, 2).slice(0, 400));
    }
    const enc = item.enclosure;
    if (enc) {
      console.log(`\n  Enclosure:`, enc);
    }
  }
}

for (const feed of allFeeds) {
  try {
    await testFeed(feed);
  } catch(e) {
    console.log(`\n\n=== ${feed.name} === ERROR: ${e.message}`);
  }
}
