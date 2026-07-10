// Copies KaTeX's stylesheet + fonts into renderer/ so the app (and the
// packaged build) can load them without reaching into node_modules.
import { cpSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'katex', 'dist');
const dst = join(root, 'renderer', 'katex');

mkdirSync(dst, { recursive: true });
cpSync(join(src, 'katex.min.css'), join(dst, 'katex.min.css'));
cpSync(join(src, 'fonts'), join(dst, 'fonts'), { recursive: true });
console.log('katex assets → renderer/katex');
