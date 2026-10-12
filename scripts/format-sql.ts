import { readdir, readFile, writeFile } from 'node:fs/promises';
import { format } from 'sql-formatter';

const folder = new URL('../packages/database/migrations/', import.meta.url);
const check = process.argv.includes('--check');

for (const file of (await readdir(folder)).filter((name) => name.endsWith('.sql'))) {
  const path = new URL(file, folder);
  const source = await readFile(path, 'utf8');
  const formatted = `${format(source, { language: 'postgresql', keywordCase: 'upper', tabWidth: 2 })}\n`;

  if (source === formatted) {
    continue;
  }

  if (check) {
    console.error(`${file} needs formatting. Run npm run format.`);
    process.exitCode = 1;
  } else {
    await writeFile(path, formatted);
    console.log(`Formatted ${file}`);
  }
}
