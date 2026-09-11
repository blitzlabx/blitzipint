import { Blitzipint } from './scraper.js';

const TEST_PIN = 'https://www.pinterest.com/pin/664281013778109217/';

async function run() {
  console.log('blitzipint test – Blitz (@blitzlabx)\n');
  const client = new Blitzipint();
  console.log('version', client.version);

  const result = await client.blitzResolve(TEST_PIN);

  console.log(JSON.stringify(result, null, 2));

  if (result.ok && result.medias.length) {
    console.log('\nbest media:');
    console.log(result.best);
    console.log('\nTEST PASSED');
    process.exit(0);
  }

  console.error('\nTEST FAILED', result.error, result.code);
  process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
