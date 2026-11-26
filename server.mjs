// Локальний запуск: node server.mjs → http://localhost:3000
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { update } from './scripts/fetch.mjs';

const PORT = process.env.PORT || 3000;
const files = {
  '/': ['public/index.html', 'text/html'],
  '/index.html': ['public/index.html', 'text/html'],
  '/data/news.json': ['public/data/news.json', 'application/json'],
};

const run = () => update().then(() => {}, e => console.error(e.message));

createServer(async (req, res) => {
  const f = files[req.url.split('?')[0]];
  try {
    if (!f) throw 0;
    if (f[1] === 'application/json') await ready; // перший запуск: чекаємо на збір новин
    const body = await readFile(new URL(f[0], import.meta.url));
    res.writeHead(200, { 'content-type': `${f[1]}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(PORT, () => console.log(`Відкрийте http://localhost:${PORT} (перший збір новин триває близько хвилини)`));

const ready = readFile(new URL('public/data/news.json', import.meta.url)).catch(run);
ready.then((had) => had && run());
setInterval(run, 3600_000);
