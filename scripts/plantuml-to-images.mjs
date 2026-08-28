#!/usr/bin/env node
// Markdown 内の ```plantuml コードブロックを画像に変換し、Zenn の画像記法へ置き換える。
//
// 使い方:
//   node scripts/plantuml-to-images.mjs [file...] [--dry-run]
//   引数を省略した場合は articles/ と books/ 配下の .md をすべて対象にする。
//
// 環境変数:
//   PLANTUML_SERVER  レンダリングに使う PlantUML サーバー (既定: https://www.plantuml.com/plantuml)
//   PLANTUML_FORMAT  出力形式 png | jpg (既定: png、Zenn は svg 非対応)

import { deflateRawSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = (process.env.PLANTUML_SERVER ?? 'https://www.plantuml.com/plantuml').replace(/\/+$/, '');
const FORMAT = process.env.PLANTUML_FORMAT ?? 'png';
const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*(plantuml|puml|uml)[ \t]*$/i;

// PlantUML テキストエンコーディング (deflate + 独自 base64 アルファベット)
function encodePlantuml(source) {
  const deflated = deflateRawSync(Buffer.from(source, 'utf8'), { level: 9 });
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  let out = '';
  for (let i = 0; i < deflated.length; i += 3) {
    const b1 = deflated[i];
    const b2 = deflated[i + 1] ?? 0;
    const b3 = deflated[i + 2] ?? 0;
    out += alphabet[b1 >> 2];
    out += alphabet[((b1 & 0x3) << 4) | (b2 >> 4)];
    out += alphabet[((b2 & 0xf) << 2) | (b3 >> 6)];
    out += alphabet[b3 & 0x3f];
  }
  return out;
}

async function render(source) {
  const url = `${SERVER}/${FORMAT}/${encodePlantuml(source)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PlantUML サーバーがエラーを返しました (${res.status} ${res.statusText}): ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  // PlantUML はエラーも画像として返すため、ヘッダで異常を検知する
  if (res.headers.get('x-plantuml-diagram-error')) {
    throw new Error(`図の記述にエラーがあります: ${res.headers.get('x-plantuml-diagram-error')}`);
  }
  if (body.length === 0) throw new Error('空のレスポンスを受け取りました');
  return body;
}

// コードブロックを走査して {start, end, indent, source} を返す
function findBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE);
    if (!m) continue;
    const [, indent, fence] = m;
    const closer = new RegExp(`^[ \t]*${fence[0]}{${fence.length},}[ \t]*$`);
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closer.test(lines[j])) { end = j; break; }
    }
    if (end === -1) continue;
    blocks.push({ start: i, end, indent, source: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  return blocks;
}

function titleOf(source) {
  const m = source.match(/^\s*title\s+(.+?)\s*$/m);
  return m ? m[1] : '';
}

async function nextIndex(dir) {
  let max = 0;
  try {
    for (const name of await readdir(dir)) {
      const m = name.match(/^diagram-(\d+)\./);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* ディレクトリ未作成 */ }
  return max + 1;
}

async function convert(file, dryRun) {
  const abs = path.resolve(ROOT, file);
  const text = await readFile(abs, 'utf8');
  const lines = text.split('\n');
  const blocks = findBlocks(lines);
  if (blocks.length === 0) {
    console.log(`- ${file}: plantuml ブロックなし`);
    return 0;
  }

  const slug = path.basename(abs, '.md');
  const imageDir = path.join(ROOT, 'images', slug);
  const pumlDir = path.join(ROOT, 'puml', slug);
  let index = await nextIndex(imageDir);

  const results = [];
  for (const block of blocks) {
    const name = `diagram-${String(index++).padStart(2, '0')}`;
    const alt = titleOf(block.source) || name;
    const image = await render(block.source);
    results.push({ block, name, alt, image });
    console.log(`  ${name}.${FORMAT} <- ${alt} (${image.length} bytes)`);
  }

  if (dryRun) {
    console.log(`- ${file}: ${results.length} 件 (dry-run のため書き込みなし)`);
    return results.length;
  }

  await mkdir(imageDir, { recursive: true });
  await mkdir(pumlDir, { recursive: true });
  for (const { name, image, block } of results) {
    await writeFile(path.join(imageDir, `${name}.${FORMAT}`), image);
    // 再生成できるよう PlantUML のソースも残す
    await writeFile(path.join(pumlDir, `${name}.puml`), `${block.source}\n`, 'utf8');
  }

  // 後ろから置換して行番号のずれを防ぐ
  for (const { block, name, alt } of results.reverse()) {
    const link = `${block.indent}![${alt}](/images/${slug}/${name}.${FORMAT})`;
    lines.splice(block.start, block.end - block.start + 1, link);
  }
  await writeFile(abs, lines.join('\n'), 'utf8');
  console.log(`- ${file}: ${results.length} 件を画像に変換`);
  return results.length;
}

async function defaultTargets() {
  const files = [];
  for (const dir of ['articles', 'books']) {
    let entries;
    try {
      entries = await readdir(path.join(ROOT, dir), { withFileTypes: true, recursive: true });
    } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        files.push(path.relative(ROOT, path.join(e.parentPath ?? e.path, e.name)));
      }
    }
  }
  return files;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const targets = args.filter((a) => !a.startsWith('--'));
const files = targets.length > 0 ? targets : await defaultTargets();

let total = 0;
for (const file of files) total += await convert(file, dryRun);
console.log(`合計 ${total} 件の図を処理しました。`);
