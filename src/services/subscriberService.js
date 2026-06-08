const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readSubscribers() {
  try {
    if (!fs.existsSync(SUBSCRIBERS_FILE)) {
      return {};
    }

    const rawData = fs.readFileSync(SUBSCRIBERS_FILE, 'utf8');
    return JSON.parse(rawData || '{}');
  } catch (error) {
    return {};
  }
}

function writeSubscribers(subscribers) {
  ensureDataDir();
  fs.writeFileSync(SUBSCRIBERS_FILE, `${JSON.stringify(subscribers, null, 2)}\n`);
}

function getChatTitle(chat = {}, from = {}) {
  if (chat.title) {
    return chat.title;
  }

  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Sin nombre';
}

function upsertSubscriber(subscriber = {}) {
  if (!subscriber.chatId) {
    return null;
  }

  const subscribers = readSubscribers();
  const key = String(subscriber.chatId);

  subscribers[key] = {
    ...subscribers[key],
    ...subscriber,
    isActive: true,
    lastSeenAt: new Date().toISOString(),
  };

  writeSubscribers(subscribers);
  return subscribers[key];
}

function upsertSubscriberFromContext(ctx) {
  const chat = ctx.chat || ctx.callbackQuery?.message?.chat;

  if (!chat?.id) {
    return null;
  }

  return upsertSubscriber({
    chatId: chat.id,
    chatType: chat.type || '',
    title: getChatTitle(chat, ctx.from || {}),
    telegramUsername: ctx.from?.username || '',
  });
}

function getActiveSubscribers() {
  return Object.values(readSubscribers()).filter((subscriber) => subscriber.isActive !== false);
}

function updateSubscriber(chatId, updates = {}) {
  const subscribers = readSubscribers();
  const key = String(chatId);

  if (!subscribers[key]) {
    return null;
  }

  subscribers[key] = {
    ...subscribers[key],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  writeSubscribers(subscribers);
  return subscribers[key];
}

function markDailyDigestSent(chatId, digestDate) {
  return updateSubscriber(chatId, {
    lastDailyDigestDate: digestDate,
    lastDailyDigestSentAt: new Date().toISOString(),
  });
}

function deactivateSubscriber(chatId, reason = '') {
  return updateSubscriber(chatId, {
    isActive: false,
    inactiveReason: reason,
  });
}

module.exports = {
  upsertSubscriber,
  upsertSubscriberFromContext,
  getActiveSubscribers,
  markDailyDigestSent,
  deactivateSubscriber,
};
