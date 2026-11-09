const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public');
const files = [
  'index.html',
  'login-success.html',
  'registration-success.html',
  'dashboard.html',
  'library.html',
  'book.html',
  'style.css',
  'workspace-theme.css',
  'library.css',
  'library-visuals.css',
  'book-detail.css',
  'script.js',
  'library.js',
  'book-detail.js',
];

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const relativePath of files) {
  fs.copyFileSync(path.join(root, relativePath), path.join(output, relativePath));
}

for (const directory of ['assets', 'fonts']) {
  fs.cpSync(path.join(root, directory), path.join(output, directory), { recursive: true });
}

console.log(`Prepared ${files.length} frontend files and assets for Vercel.`);
