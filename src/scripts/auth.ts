import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createInterface } from 'readline';
import 'dotenv/config';

const rl = createInterface({ input: process.stdin, output: process.stdout });

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiId || !apiHash) {
    console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first.');
    process.exit(1);
  }

  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: () => prompt('Phone number: '),
    password: () => prompt('2FA password (if enabled): '),
    phoneCode: () => prompt('Code from Telegram: '),
    onError: (err) => console.error('Auth error:', err.message),
  });

  console.log('\nAuthentication successful!');
  console.log('\nAdd this to your .env file:');
  console.log(`TELEGRAM_SESSION=${client.session.save()}`);

  rl.close();
  await client.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
