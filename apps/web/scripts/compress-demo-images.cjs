const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const dir = path.join('public', 'demo');

async function toWebp(name, width, quality = 78) {
  const src = path.join(dir, name);
  const dest = path.join(dir, name.slice(0, -4) + '.webp');
  if (src === dest) throw new Error('bad dest for ' + name);
  const before = fs.statSync(src).size;
  await sharp(src).rotate().resize({ width, withoutEnlargement: true }).webp({ quality, effort: 6 }).toFile(dest);
  const after = fs.statSync(dest).size;
  console.log(name, '->', path.basename(dest), Math.round(before / 1024) + 'KB =>', Math.round(after / 1024) + 'KB');
}

(async () => {
  await toWebp('kane.png', 720, 80);
  await toWebp('mbappe.png', 720, 80);
  await toWebp('beige-coat.png', 256, 78);
  await toWebp('puffer-jacket.png', 256, 78);
  await toWebp('omni-markets-logo.png', 192, 82);
  await toWebp('adidas-store-logo.png', 192, 82);
  await toWebp('pulse-finance-icon.png', 192, 82);
  await toWebp('pixel-forge-logo.png', 192, 82);
  await toWebp('tendr-logo.png', 256, 82);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
