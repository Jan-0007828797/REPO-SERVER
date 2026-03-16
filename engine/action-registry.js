const { currentPhaseKey } = require('./phase-machine');

function ensureActionRegistry(game){
  game.phaseActions = game.phaseActions || {};
  return game.phaseActions;
}

function markCommitted(game, playerId, meta = {}){
  const key = currentPhaseKey(game);
  const registry = ensureActionRegistry(game);
  registry[key] = registry[key] || {};
  registry[key][playerId] = { committed: true, ts: Date.now(), ...meta };
}

function resetCurrentPhaseActions(game){
  const key = currentPhaseKey(game);
  const registry = ensureActionRegistry(game);
  registry[key] = {};
}

function phaseCompletionForPlayers(game, players){
  const key = currentPhaseKey(game);
  const bucket = ensureActionRegistry(game)[key] || {};
  return players.every((playerId) => !!bucket[playerId]?.committed);
}

module.exports = { ensureActionRegistry, markCommitted, resetCurrentPhaseActions, phaseCompletionForPlayers };
