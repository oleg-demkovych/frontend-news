// Збирає новини з усіх джерел у public/data/news.json. Без залежностей, Node 20+.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const OUT = new URL('public/data/news.json', root);
const KEEP_DAYS = 90, MAX_TOTAL = 3000, MAX_PER_SOURCE = 40;
const DEV_TAGS = ['frontend','javascript','react','css','webdev','vue','typescript','angular'];

const ENT = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', mdash:'—', ndash:'–', hellip:'…', rsquo:'’', lsquo:'‘', ldquo:'“', rdquo:'”' };
const decode = s => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] !== '#') return ENT[e] ?? m;
  const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n <= 0x10ffff ? String.fromCodePoint(n) : m;
});
const unwrap = s => s.includes('<![CDATA[') ? s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : decode(s);
const plain = s => decode(unwrap(s).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const tag = (block, ...names) => {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
};
const cut = (s, n = 240) => s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s;
const safeUrl = (u, base) => { try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };

export function parseFeed(xml, src) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  return blocks.map(b => {
    const links = [...b.matchAll(/<link\s([^>]*?)\/?>/gi)].map(m => m[1]);
    const alt = links.find(a => /rel=["']alternate["']/.test(a)) ?? links.find(a => !/rel=/.test(a));
    const href = alt?.match(/href=["']([^"']+)["']/)?.[1];
    const url = safeUrl(href ? decode(href) : unwrap(tag(b, 'link', 'guid')).trim(), src.url);
    const date = new Date(unwrap(tag(b, 'pubDate', 'published', 'dc:date', 'updated')));
    const media = b.match(/<(?:media:content|media:thumbnail|enclosure)\s[^>]*url=["']([^"']+\.(?:jpe?g|png|webp|gif)[^"']*)["']/i)?.[1]
      ?? unwrap(tag(b, 'content:encoded', 'content', 'description')).match(/<img\s[^>]*src=["']([^"']+)["']/i)?.[1];
    return {
      title: cut(decode(unwrap(tag(b, 'title'))).replace(/\s+/g, ' ').trim(), 200), url,
      date: isNaN(date) ? null : date.toISOString(),
      text: cut(plain(tag(b, 'description', 'summary', 'content:encoded', 'content'))),
      image: media ? safeUrl(decode(media), src.url) : '',
      source: src.name, cat: src.cat,
    };
  }).filter(i => i.title && i.url && i.date);
}

async function get(url, tries = 4) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'FrontendNews/1.0 (RSS reader)', accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, */*' } });
  // 429: сервіс просить зачекати
  if (res.status === 429 && tries > 1) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || 10, 60);
    await new Promise(r => setTimeout(r, wait * 1000));
    return get(url, tries - 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function rss(src) {
  let items = parseFeed(await get(src.url), src);
  if (!items.length) throw new Error('порожня або нерозпізнана стрічка');
  if (src.filter) { const re = new RegExp(src.filter, 'i'); items = items.filter(i => re.test(i.title + ' ' + i.text)); }
  return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, src.max ?? MAX_PER_SOURCE);
}

async function devto(t) {
  const list = JSON.parse(await get(`https://dev.to/api/articles?tag=${t}&top=7&per_page=40`));
  return list.map(a => ({ title: a.title, url: a.url, date: a.published_at, text: a.description ?? '', image: a.cover_image ?? '', source: 'DEV Community', cat: 'Спільнота', score: a.public_reactions_count }));
}

async function hn(q) {
  const since = Math.floor(Date.now() / 1000) - 14 * 86400;
  const data = JSON.parse(await get(`https://hn.algolia.com/api/v1/search_by_date?query=${q}&tags=story&hitsPerPage=40&numericFilters=created_at_i>${since},points>10`));
  return data.hits.map(h => ({ title: h.title, url: safeUrl(h.url || `https://news.ycombinator.com/item?id=${h.objectID}`), date: h.created_at, text: `${h.points} балів · ${h.num_comments ?? 0} коментарів на Hacker News`, image: '', source: 'Hacker News', cat: 'Спільнота', score: h.points }));
}

async function previous() {
  try {
    // PREV_URL потрібен у GitHub Actions, де локального файлу між запусками немає
    return JSON.parse(process.env.PREV_URL ? await get(process.env.PREV_URL) : await readFile(OUT, 'utf8')).items ?? [];
  } catch { return []; }
}

export function merge(old, fresh, now = Date.now()) {
  const map = new Map();
  for (const i of [...old, ...fresh]) {
    const t = Date.parse(i.date);
    if (!i.url || !(t > now - KEEP_DAYS * 86400e3) || t > now + 86400e3) continue;
    const key = i.url.replace(/[?#]utm_.*$/, '').replace(/\/$/, '');
    const prev = map.get(key);
    // перше джерело залишається власником запису, свіжі дані оновлюють лише його
    if (!prev || prev.source === i.source) map.set(key, i);
  }
  return [...map.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, MAX_TOTAL);
}

export async function update() {
  const sources = JSON.parse(await readFile(new URL('scripts/sources.json', root), 'utf8'));
  const jobs = [
    ...sources.map(s => [s.name, () => rss(s)]),
    ...['javascript','css','react','frontend','typescript'].map(q => [`HN ${q}`, () => hn(q)]),
  ];
  const results = [];
  for (let i = 0; i < jobs.length; i += 8) {
    results.push(...await Promise.all(jobs.slice(i, i + 8).map(async ([name, run]) => {
      try { return { name, items: await run() }; }
      catch (e) { return { name, items: [], error: e.message }; }
    })));
  }
  // DEV обмежує частоту запитів, тому теги читаємо по черзі
  for (const t of DEV_TAGS) {
    await new Promise(r => setTimeout(r, 1500));
    try { results.push({ name: `DEV #${t}`, items: await devto(t) }); }
    catch (e) { results.push({ name: `DEV #${t}`, items: [], error: e.message }); }
  }
  const fresh = results.flatMap(r => r.items);
  if (!fresh.length) throw new Error('Жодне джерело не відповіло — старі дані збережено');
  const items = merge(await previous(), fresh);
  const data = { updated: new Date().toISOString(), status: results.map(r => ({ name: r.name, count: r.items.length, error: r.error })), items };
  await mkdir(new URL('.', OUT), { recursive: true });
  const tmp = fileURLToPath(OUT) + '.tmp';
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, OUT);
  const failed = data.status.filter(s => s.error);
  console.log(`${data.updated}: ${items.length} матеріалів; помилок: ${failed.length}/${results.length}`);
  failed.forEach(f => console.log(`  ✗ ${f.name}: ${f.error}`));
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await update();
