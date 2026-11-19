/**
 * realtime — a module-level Socket.IO registry so non-request code
 * (scheduled jobs, services, stock sync) can emit realtime events without
 * access to the Express `app`. Set once from index.js after initSocket().
 *
 * Room conventions (already used across the app):
 *   user-{userId}   per-user
 *   store-{storeId} per-branch
 */
let _io = null;

const setIO = (io) => {
  _io = io;
};

const getIO = () => _io;

const emitToUser = (userId, event, payload) => {
  if (!_io || !userId) return;
  _io.to(`user-${userId}`).emit(event, payload);
};

const emitToStore = (storeId, event, payload) => {
  if (!_io || !storeId) return;
  _io.to(`store-${storeId}`).emit(event, payload);
};

const broadcast = (event, payload) => {
  if (!_io) return;
  _io.emit(event, payload);
};

module.exports = { setIO, getIO, emitToUser, emitToStore, broadcast };
