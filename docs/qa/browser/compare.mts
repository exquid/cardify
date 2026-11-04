/* eslint-disable no-console -- command-line QA script */
// Pixel comparison of two screenshot folders produced by `shots.mts --fixed`.
// Usage: compare.mts <before-dir> <after-dir>. Exit code 1 if any image differs.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { playwright } from './lib.mts';

const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) throw new Error('usage: compare.mts <before-dir> <after-dir>');
const browser = await playwright.chromium.launch();
const page = await browser.newPage();
let differing = 0;
for (const name of readdirSync(beforeDir).filter((f) => f.endsWith('.png')).sort()) {
  const a = readFileSync(path.join(beforeDir, name)).toString('base64');
  const b = readFileSync(path.join(afterDir, name)).toString('base64');
  const result = await page.evaluate(async ([x, y]: string[]) => {
    const load = (src: string) =>
      new Promise<HTMLImageElement>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.src = `data:image/png;base64,${src}`;
      });
    const [i1, i2] = await Promise.all([load(x as string), load(y as string)]);
    if (i1.width !== i2.width || i1.height !== i2.height) return { size: false, diff: -1, total: 0 };
    const pixels = (img: HTMLImageElement) => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d') as CanvasRenderingContext2D;
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, img.width, img.height).data;
    };
    const p1 = pixels(i1);
    const p2 = pixels(i2);
    let diff = 0;
    for (let i = 0; i < p1.length; i += 4) {
      if (p1[i] !== p2[i] || p1[i + 1] !== p2[i + 1] || p1[i + 2] !== p2[i + 2] || p1[i + 3] !== p2[i + 3]) diff += 1;
    }
    return { size: true, diff, total: p1.length / 4 };
  }, [a, b]);
  if (!result.size || result.diff > 0) differing += 1;
  console.log(`${name}: ${result.size ? `${result.diff} of ${result.total} pixels differ` : 'different size'}`);
}
await browser.close();
process.exitCode = differing ? 1 : 0;
