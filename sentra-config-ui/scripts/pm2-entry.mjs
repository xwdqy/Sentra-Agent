process.env.NODE_ENV = process.env.NODE_ENV || 'production';

import('../server/index.ts').catch((e) => {
  console.error(e);
  process.exit(1);
});
