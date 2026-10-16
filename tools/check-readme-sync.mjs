#!/usr/bin/env node
// The module's own README (copied into the built module by the vite config) must be the repository README.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = readFileSync(resolve(root, 'README.md'), 'utf8');
const shipped = readFileSync(resolve(root, 'packages/module/README.md'), 'utf8');

if (repo !== shipped) {
  console.error('check:readme-sync: FAILED — packages/module/README.md differs from README.md. Copy README.md over it (cp README.md packages/module/README.md).');
  process.exit(1);
}
console.log('check:readme-sync: OK — packages/module/README.md is identical to README.md.');
