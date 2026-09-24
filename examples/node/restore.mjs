#!/usr/bin/env node
// Rejoin a split GotYouBro backup (Node.js 18+, no dependencies).
//
// Download all parts (and the .manifest.json) from Telegram into one folder, then:
//
//   node restore.mjs ./downloads                 # → postgres-20260924T030000Z.sql.gz
//   node restore.mjs ./downloads --extract       # → postgres-20260924T030000Z.sql
//   node restore.mjs a.part001 a.part002 --out backup.sql.gz
//
// With a manifest every part and the joined file are verified with SHA-256.
// Without one, files named *.partNNN are joined in order.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';

const PART_RE = /^(.*)\.part(\d{3,})$/;

function collectFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    if (fs.statSync(input).isDirectory()) {
      for (const name of fs.readdirSync(input)) files.push(path.join(input, name));
    } else {
      files.push(input);
    }
  }
  return files;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, extract: { type: 'boolean', default: false } },
  });
  if (!positionals.length) {
    console.error('Usage: node restore.mjs <folder | files...> [--out file.gz] [--extract]');
    process.exit(2);
  }

  const files = collectFiles(positionals);
  const manifestPath = files.find((f) => f.endsWith('.manifest.json'));
  let parts;
  let outName;
  let manifest;

  if (manifestPath) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const dir = path.dirname(manifestPath);
    parts = manifest.parts.map((p) => ({ ...p, path: files.find((f) => path.basename(f) === p.file) ?? path.join(dir, p.file) }));
    outName = manifest.file;
  } else {
    parts = files
      .map((f) => ({ path: f, match: PART_RE.exec(path.basename(f)) }))
      .filter((p) => p.match)
      .sort((a, b) => Number(a.match[2]) - Number(b.match[2]));
    if (!parts.length) throw new Error('No *.partNNN files or manifest found');
    outName = parts[0].match[1];
  }

  const out = values.out ?? outName;
  console.log(`Joining ${parts.length} part(s) → ${out}`);

  // Verify and concatenate.
  const total = createHash('sha256');
  const output = fs.createWriteStream(out);
  for (const [i, part] of parts.entries()) {
    if (!fs.existsSync(part.path)) throw new Error(`Missing part: ${path.basename(part.path)}`);
    if (part.sha256 && (await sha256(part.path)) !== part.sha256) {
      throw new Error(`Checksum mismatch in ${path.basename(part.path)} — download it again`);
    }
    for await (const chunk of fs.createReadStream(part.path)) {
      total.update(chunk);
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
    }
    console.log(`  ✓ ${i + 1}/${parts.length} ${path.basename(part.path)}`);
  }
  await new Promise((resolve, reject) => output.end((err) => (err ? reject(err) : resolve())));

  if (manifest && total.digest('hex') !== manifest.sha256) throw new Error('Checksum of the joined file does not match the manifest');
  if (manifest) console.log('Checksums verified.');

  if (values.extract) {
    const extracted = out.replace(/\.gz$/, '') || `${out}.out`;
    await pipeline(fs.createReadStream(out), createGunzip(), fs.createWriteStream(extracted));
    console.log(`Extracted → ${extracted}`);
  }
  if (manifest?.restore) console.log(`\nRestore with:\n  ${manifest.restore.split('&& ').pop()}`);
}

main().catch((err) => {
  console.error(`Restore failed: ${err.message}`);
  process.exit(1);
});
