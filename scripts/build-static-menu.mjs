#!/usr/bin/env node
/**
 * Build the customer-facing menu as a single static page.
 *
 *   npm run build:menu-site
 *
 * Output: dist-menu-site/, an index.html with no backend, no database and no
 * build step behind it. It is the one part of MARA that genuinely belongs on
 * plain PHP/static shared hosting — ProFreeHost, InfinityFree and the like —
 * because it only ever reads.
 *
 * What it deliberately is not: the POS, the QR ordering flow, or anything that
 * writes. Those need the API, and the API needs a Node host. A customer can
 * read this menu; they cannot order from it.
 *
 * Regenerate it whenever the menu changes — it is built from the same
 * data/mara-menu.json the importer loads, so the printed prices and the ones a
 * customer sees cannot drift apart.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-menu-site');

const menu = JSON.parse(
  readFileSync(join(root, 'packages/server/data/mara-menu.json'), 'utf8'),
);

/** Riyals, as they are printed on the menu. */
const price = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const escape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const categories = menu.categories.filter((c) => (c.items ?? []).length > 0);
const itemCount = categories.reduce((n, c) => n + c.items.length, 0);

const sections = categories.map((category, index) => {
  const items = category.items.map((item) => {
    // An item with no price is off sale; the menu says so rather than showing
    // a number nobody set.
    const unpriced = item.available === false || !item.price;
    return `
        <li class="item${unpriced ? ' item--off' : ''}">
          <div class="item__name">${escape(item.name)}${
            item.description ? `<span class="item__note">${escape(item.description)}</span>` : ''
          }</div>
          <div class="item__price">${
            unpriced ? '<span class="item__off">غير متوفر</span>' : `${price(item.price)}<span class="riyal"> ر.س</span>`
          }</div>
        </li>`;
  }).join('');

  return `
      <section class="section" id="cat-${index}" data-category="${index}">
        <h2 class="section__title">${escape(category.name)}</h2>
        <ul class="items">${items}
        </ul>
      </section>`;
}).join('');

const chips = categories.map((c, i) =>
  `<button class="chip" data-filter="${i}" type="button">${escape(c.name)}</button>`).join('');

const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>مارا لاونج — المنيو</title>
<meta name="description" content="منيو مارا لاونج">
<meta name="theme-color" content="#0E1012">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=El+Messiri:wght@500;700&family=IBM+Plex+Sans+Arabic:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --ground: #0E1012;
    --surface: #16191C;
    --line: #24282D;
    --ink: #ECEEF0;
    --muted: #8B939B;
    --gold: #D4A72C;
    --gold-dim: #8A6E1E;
    --display: 'El Messiri', 'Segoe UI', Tahoma, sans-serif;
    --body: 'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, sans-serif;
  }
  * { box-sizing: border-box; }
  html { direction: rtl; }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--body);
    font-size: 16px;
    line-height: 1.5;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 0 16px 64px; }

  header {
    text-align: center;
    padding: 40px 16px 24px;
  }
  .brand {
    font-family: var(--display);
    font-size: 44px;
    font-weight: 700;
    letter-spacing: .18em;
    color: var(--gold);
    margin: 0;
    line-height: 1;
  }
  .tagline { color: var(--muted); font-size: 14px; margin-top: 10px; }
  .rule {
    width: 56px; height: 2px; margin: 20px auto 0;
    background: linear-gradient(90deg, transparent, var(--gold), transparent);
  }

  .tools {
    position: sticky; top: 0; z-index: 10;
    background: color-mix(in srgb, var(--ground) 92%, transparent);
    backdrop-filter: blur(12px);
    padding: 12px 0 10px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 8px;
  }
  .search {
    width: 100%; padding: 12px 14px;
    background: var(--surface); color: var(--ink);
    border: 1px solid var(--line); border-radius: 10px;
    font-family: inherit; font-size: 16px;
  }
  .search::placeholder { color: var(--muted); }
  .search:focus { outline: 2px solid var(--gold-dim); outline-offset: 1px; }

  .chips {
    display: flex; gap: 8px; overflow-x: auto; margin-top: 10px;
    padding-bottom: 4px; scrollbar-width: none;
  }
  .chips::-webkit-scrollbar { display: none; }
  .chip {
    flex: 0 0 auto; padding: 7px 14px;
    background: var(--surface); color: var(--muted);
    border: 1px solid var(--line); border-radius: 999px;
    font-family: inherit; font-size: 13px; white-space: nowrap;
    cursor: pointer;
  }
  .chip[aria-pressed="true"] {
    background: var(--gold); color: #17140A; border-color: var(--gold);
    font-weight: 600;
  }

  .section { margin-top: 32px; }
  .section__title {
    font-family: var(--display); font-size: 22px; font-weight: 700;
    color: var(--gold); margin: 0 0 12px;
    display: flex; align-items: center; gap: 12px;
  }
  .section__title::after {
    content: ''; flex: 1; height: 1px; background: var(--line);
  }

  .items { list-style: none; margin: 0; padding: 0; }
  .item {
    display: flex; align-items: baseline; gap: 12px;
    padding: 13px 0; border-bottom: 1px solid var(--line);
  }
  .item:last-child { border-bottom: 0; }
  .item__name { flex: 1; font-weight: 500; }
  .item__note {
    display: block; color: var(--muted); font-size: 13px;
    font-weight: 400; margin-top: 2px;
  }
  .item__price {
    font-variant-numeric: tabular-nums; font-weight: 600;
    color: var(--gold); white-space: nowrap; direction: ltr;
  }
  .riyal { font-size: 12px; color: var(--muted); font-weight: 400; }
  .item--off .item__name { color: var(--muted); }
  .item__off { font-size: 12px; color: var(--muted); font-weight: 400; }

  .empty { text-align: center; color: var(--muted); padding: 48px 0; display: none; }
  .empty.on { display: block; }

  footer {
    text-align: center; color: var(--muted); font-size: 12px;
    margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--line);
  }

  @media print {
    body { background: #fff; color: #000; }
    .tools, footer { display: none; }
    .brand, .section__title, .item__price { color: #000; }
    .item { border-color: #ddd; }
  }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <h1 class="brand">MARA</h1>
    <div class="tagline">مارا لاونج</div>
    <div class="rule"></div>
  </header>

  <div class="tools">
    <input class="search" id="q" type="search" placeholder="ابحث في المنيو…"
           autocomplete="off" aria-label="ابحث في المنيو">
    <div class="chips" id="chips">
      <button class="chip" data-filter="all" type="button" aria-pressed="true">الكل</button>
      ${chips}
    </div>
  </div>

  <main id="menu">${sections}
  </main>

  <p class="empty" id="empty">لا نتائج مطابقة</p>

  <footer>
    ${itemCount} صنفاً · الأسعار بالريال السعودي شاملة الضريبة
  </footer>

</div>

<script>
(function () {
  var q = document.getElementById('q');
  var chips = document.getElementById('chips');
  var empty = document.getElementById('empty');
  var sections = Array.prototype.slice.call(
    document.querySelectorAll('.section'));
  var filter = 'all';

  function apply() {
    var term = q.value.trim().toLowerCase();
    var anyVisible = false;

    sections.forEach(function (section) {
      var inCategory = filter === 'all' || section.dataset.category === filter;
      var visibleItems = 0;

      Array.prototype.forEach.call(section.querySelectorAll('.item'),
        function (item) {
          var name = item.querySelector('.item__name').textContent.toLowerCase();
          var show = inCategory && (!term || name.indexOf(term) !== -1);
          item.hidden = !show;
          if (show) visibleItems++;
        });

      section.hidden = visibleItems === 0;
      if (visibleItems > 0) anyVisible = true;
    });

    empty.classList.toggle('on', !anyVisible);
  }

  q.addEventListener('input', apply);

  chips.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    filter = chip.dataset.filter;
    Array.prototype.forEach.call(chips.querySelectorAll('.chip'),
      function (c) { c.setAttribute('aria-pressed', String(c === chip)); });
    apply();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
</script>
</body>
</html>
`;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), html, 'utf8');

// Shared hosting serves index.html by default, but some panels want this.
writeFileSync(join(out, '.htaccess'),
  'DirectoryIndex index.html\nAddDefaultCharset UTF-8\n', 'utf8');

const bytes = Buffer.byteLength(html, 'utf8');
console.log(`\nBuilt dist-menu-site/`);
console.log(`  ${categories.length} categories, ${itemCount} items`);
console.log(`  index.html — ${(bytes / 1024).toFixed(1)} KB, no backend, no database`);
console.log('\nUpload the contents of dist-menu-site/ to your host\'s htdocs folder.\n');
