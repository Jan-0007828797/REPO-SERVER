const { PHASES, BIZ_STEPS } = require('../config/game-config');

function nextPhaseState(game){
  if(game.phase===PHASES.BIZ){
    if(game.bizStep===BIZ_STEPS.ML_BID) return { phase: PHASES.BIZ, bizStep: BIZ_STEPS.MOVE };
    if(game.bizStep===BIZ_STEPS.MOVE) return { phase: PHASES.BIZ, bizStep: BIZ_STEPS.AUCTION_ENVELOPE };
    if(game.bizStep===BIZ_STEPS.AUCTION_ENVELOPE) return { phase: PHASES.BIZ, bizStep: BIZ_STEPS.ACQUIRE };
    if(game.bizStep===BIZ_STEPS.ACQUIRE) return { phase: PHASES.CRYPTO, bizStep: null };
  }
  if(game.phase===PHASES.CRYPTO) return { phase: PHASES.SETTLE, bizStep: null };
  if(game.phase===PHASES.SETTLE) return { phase: null, bizStep: null, yearTransition: true };
  return null;
}

function previousPhaseState(game){
  if(game.phase===PHASES.BIZ){
    if(game.bizStep===BIZ_STEPS.MOVE) return { phase: PHASES.BIZ, bizStep: BIZ_STEPS.ML_BID };
    if(game.bizStep===BIZ_STEPS.AUCTION_ENVELOPE) return { phase: PHASES.BIZ, bizStep: BIZ_STEPS.MOVE };
    if(game.bizStep===BIZ_STEPS.ACQUIRE) return { phase: PHASES.BIZ, bizStep: BIZ_STEPS.AUCTION_ENVELOPE };
  }
  if(game.phase===PHASES.CRYPTO) return { phase: PHASES.BIZ, bizStep: BIZ_STEPS.ACQUIRE };
  if(game.phase===PHASES.SETTLE) return { phase: PHASES.CRYPTO, bizStep: null };
  return null;
}

function currentPhaseKey(game){
  return game.phase===PHASES.BIZ ? `BIZ:${game.bizStep||''}` : String(game.phase||'');
}

module.exports = { nextPhaseState, previousPhaseState, currentPhaseKey };
