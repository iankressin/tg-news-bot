import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { logger } from '../utils/logger.js';

export async function createMonitorClient(
  apiId: number,
  apiHash: string,
  session: string,
): Promise<TelegramClient> {
  const stringSession = new StringSession(session);

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => {
      throw new Error(
        'Session expired or missing. Run `npm run auth` to generate a new session string.',
      );
    },
    password: async () => {
      throw new Error('Session expired. Run `npm run auth` to re-authenticate.');
    },
    phoneCode: async () => {
      throw new Error('Session expired. Run `npm run auth` to re-authenticate.');
    },
    onError: (err) => {
      logger.error('GramJS auth error', { error: err.message });
    },
  });

  logger.info('GramJS client connected');
  return client;
}
