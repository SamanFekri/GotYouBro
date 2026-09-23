// Send a file to GotYouBro.
// Usage: GOTYOUBRO_URL=https://your-domain.com GOTYOUBRO_TOKEN=gyb_... node examples/backup.mjs ./backup.sqlite
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';

const baseUrl = process.env.GOTYOUBRO_URL ?? 'http://localhost:6969';
const filePath = process.argv[2];
if (!filePath) throw new Error('Usage: node examples/backup.mjs <file>');

const formData = new FormData();
formData.append('file', await openAsBlob(filePath), basename(filePath));

const response = await fetch(`${baseUrl}/api/v1/backups?wait=true`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.GOTYOUBRO_TOKEN}`,
    // Retrying with the same key never creates a duplicate backup.
    'Idempotency-Key': `${basename(filePath)}-${new Date().toISOString().slice(0, 10)}`,
  },
  body: formData,
});

console.log(response.status, await response.json());
