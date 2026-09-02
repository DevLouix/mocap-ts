import { createDatabase } from './index.js';

const database = createDatabase();
try {
  await database.migrate();
  console.log('[mocap-db] migrations applied');
} finally {
  await database.close();
}
