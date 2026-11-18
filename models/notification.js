// 이용자 알림 (MongoDB notifications) — 주문 이벤트를 RabbitMQ user-notifier 가 후처리로 생성
const mongo = require('../db/mongo');

async function listForUser(userId, limit = 10) {
  try {
    const c = await mongo.col('notifications');
    return await c.find({ user_id: userId }).sort({ created_at: -1 }).limit(limit).toArray();
  } catch {
    return []; // MongoDB 장애가 주문 화면을 막지 않도록
  }
}

async function unreadCount(userId) {
  try {
    return await (await mongo.col('notifications')).countDocuments({ user_id: userId, read: false });
  } catch {
    return 0;
  }
}

async function markAllRead(userId) {
  await (await mongo.col('notifications')).updateMany({ user_id: userId, read: false }, { $set: { read: true, read_at: new Date() } });
}

module.exports = { listForUser, unreadCount, markAllRead };
