import { createServer } from 'node:http';
import { createGateway } from '../api/gateway.js';

if (!process.env.CLOUDFLARE_WORKER_URL || !process.env.SESSION_SECRET) {
  console.error('Set CLOUDFLARE_WORKER_URL and SESSION_SECRET before running npm run dev.');
  process.exit(1);
}
const port = Number(process.env.PORT || 3000);
createServer(createGateway({ local: true })).listen(port, '127.0.0.1', () => {
  console.log('Vercel entrance preview: http://localhost:' + port);
});
