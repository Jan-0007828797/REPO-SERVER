const { v4: uuidv4 } = require('uuid');

function issueReconnectToken(){
  return uuidv4();
}

function bindSocketToPlayer(socketBindings, socketId, gameId, playerId){
  socketBindings.set(socketId, { gameId, playerId, boundAt: Date.now() });
}

function unbindSocket(socketBindings, socketId){
  socketBindings.delete(socketId);
}

function resolveSocketPlayerId(socketBindings, socketId, gameId){
  const binding = socketBindings.get(socketId);
  if(!binding) return null;
  if(gameId && binding.gameId !== gameId) return null;
  return binding.playerId || null;
}

function ensureReconnectStore(game){
  if(!game.reconnectTokens) game.reconnectTokens = {};
  return game.reconnectTokens;
}

function attachReconnectToken(game, playerId, token){
  const store = ensureReconnectStore(game);
  store[playerId] = token;
}

function getReconnectToken(game, playerId){
  return ensureReconnectStore(game)[playerId] || null;
}

function findPlayerIdByReconnectToken(game, reconnectToken){
  if(!reconnectToken) return null;
  const entries = Object.entries(ensureReconnectStore(game));
  const hit = entries.find(([,token]) => token === reconnectToken);
  return hit ? hit[0] : null;
}

module.exports = {
  issueReconnectToken,
  bindSocketToPlayer,
  unbindSocket,
  resolveSocketPlayerId,
  attachReconnectToken,
  getReconnectToken,
  findPlayerIdByReconnectToken,
};
