import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const distDir = path.resolve('dist');
const srcDir = path.resolve('src');

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function bytes(n) {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  if (n > 1024) return `${(n / 1024).toFixed(2)} KiB`;
  return `${n} B`;
}

const assets = walk(path.join(distDir, 'assets'))
  .filter((file) => /\.(js|css)$/.test(file))
  .map((file) => {
    const raw = fs.readFileSync(file);
    return {
      file: path.relative(distDir, file).replace(/\\/g, '/'),
      bytes: raw.length,
      gzipBytes: zlib.gzipSync(raw).length,
    };
  })
  .sort((a, b) => b.bytes - a.bytes);

const sourceImports = walk(srcDir)
  .filter((file) => /\.(ts|tsx)$/.test(file))
  .flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const bad = [];
    const markers = [
      { marker: 'node:', pattern: /from\s+['"]node:/ },
      { marker: 'fs', pattern: /from\s+['"](?:node:)?fs['"]/ },
      { marker: '../server', pattern: /from\s+['"].*\/server['"]/ },
      { marker: '../../x402/src/server', pattern: /from\s+['"].*x402\/src\/server['"]/ },
      { marker: '@solana/web3.js', pattern: /from\s+['"]@solana\/web3\.js['"]/ },
    ];
    for (const { marker, pattern } of markers) {
      if (pattern.test(text)) {
        bad.push({ file: path.relative(process.cwd(), file).replace(/\\/g, '/'), marker });
      }
    }
    return bad;
  });

const report = {
  generatedAt: new Date().toISOString(),
  distDir,
  assets: assets.map((asset) => ({
    ...asset,
    size: bytes(asset.bytes),
    gzipSize: bytes(asset.gzipBytes),
  })),
  largestAsset: assets[0] ?? null,
  serverOnlyImportFindings: sourceImports.filter((item) => item.marker !== '@solana/web3.js'),
  web3Imports: sourceImports.filter((item) => item.marker === '@solana/web3.js'),
};

console.log(JSON.stringify(report, null, 2));

if (report.serverOnlyImportFindings.length > 0) {
  process.exitCode = 1;
}
