import Parser from 'rss-parser';

const parser = new Parser({
  customFields: {
    item: ['media:content', 'media:thumbnail', 'itunes:image', 'content:encoded', 'description']
  }
});

const feeds = [
  { url: 'https://feeds.arstechnica.com/arstechnica/index', name: 'Ars Technica' },
  { url: 'https://techcrunch.com/feed/', name: 'TechCrunch' },
  { url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge' },
];

for (const feed of feeds) {
  try {
    const result = await parser.parseURL(feed.url);
    console.log(`\n=== ${feed.name} ===`);
    console.log(`Items: ${result.items.length}`);
    
    // Check first 2 items
    for (const item of result.items.slice(0, 2)) {
      console.log(`\n  Title: ${item.title}`);
      console.log(`  enclosure:`, JSON.stringify(item.enclosure)?.slice(0, 200));
      console.log(`  image:`, item.image);
      console.log(`  media:content:`, JSON.stringify(item['media:content'])?.slice(0, 200));
      console.log(`  media:thumbnail:`, JSON.stringify(item['media:thumbnail'])?.slice(0, 200));
      console.log(`  content:encoded:`, (item['content:encoded'] || '').slice(0, 500));
      console.log(`  description:`, (item.description || '').slice(0, 200));
      
      // Check if there's an img in the HTML fields
      const allText = (item['content:encoded'] || '') + (item.description || '');
      const imgMatch = allText.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)/i);
      console.log(`  -> IMG in HTML:`, imgMatch ? imgMatch[1].slice(0, 200) : 'NONE');
    }
  } catch (e) {
    console.log(`\n=== ${feed.name} === ERROR: ${e.message}`);
  }
}

console.log('\n\n=== Checking ALL feeds for HTML images ===');
for (const feed of feeds) {
  try {
    const result = await parser.parseURL(feed.url);
    let itemsWithImg = 0;
    let itemsWithMetaImg = 0;
    for (const item of result.items) {
      const allText = (item['content:encoded'] || '') + (item.description || '');
      const imgMatch = allText.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)/i);
      if (imgMatch) itemsWithImg++;
      
      const hasMeta = item.enclosure?.url || item.image || item['media:content'] || item['media:thumbnail'];
      if (hasMeta) itemsWithMetaImg++;
    }
    console.log(`${feed.name}: ${result.items.length} items, ${itemsWithMetaImg} with meta image, ${itemsWithImg} with HTML images`);
  } catch (e) {
    console.log(`${feed.name}: ERROR - ${e.message}`);
  }
}
