import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app.js';

const app = createApp();
const httpServer = createServer(app);
const port = process.env.PORT ? Number(process.env.PORT) : 3001;

httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
