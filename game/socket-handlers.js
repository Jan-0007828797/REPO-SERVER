const { unbindSocket } = require("../session/player-session");

function registerSocketHandlers({ io, socketBindings, bindSocketToPlayer, attachReconnectToken, getReconnectToken, findPlayerIdByReconnectToken, core }) {
  const {
    CATALOG, COUNTDOWN_TICK_MS, games, now, newGame, getGame, isNameTaken, nextFreeSeatIndex, makePlayer, blankInventory, broadcast, ackOk, ackErr, isGM, generateTrends, startNewYear,
    resolveActorPlayerId, updateCountdown, gmNext, canBack, gmBack, currentYearGlobals, ensureLawyerStore, canUseLawyerNow, addNotice, currentYearCrypto, calcSettlementFor, getPlayer,
    currentReadiness, autoCommitTimedOutPlayers, gamePublic, bindPresence, markCommitted
  } = core;

io.on("connection", (socket) => {
  socket.on("create_game", (payload, cb) => {
    try{
      const { name, yearsTotal, maxPlayers } = payload || {};
      const { game, gm } = newGame({ gmName:name, yearsTotal, maxPlayers });
      gm.connected = true;
      bindSocketToPlayer(socketBindings, socket.id, game.gameId, gm.playerId);
      socket.join(`game:${game.gameId}`);
      ackOk(cb, { gameId: game.gameId, playerId: gm.playerId, role: gm.role, reconnectToken: gm.reconnectToken });
      io.to(socket.id).emit("created_game", { gameId: game.gameId, playerId: gm.playerId, reconnectToken: gm.reconnectToken });
    }catch(e){
      ackErr(cb, "create_game failed");
    }
  });

  socket.on("join_game", (payload, cb) => {
    const { gameId, name } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Hra nenalezena", "NOT_FOUND");

    // Nové připojení povoleno jen v lobby (stabilita + férovost)
    if(game.status!=="LOBBY") return ackErr(cb, "Hra už běží. Připojit se mohou jen původní hráči.", "IN_PROGRESS");

    const n = String(name||"").trim();
    if(!n) return ackErr(cb, "Zadej přezdívku.", "NAME_REQUIRED");
    if(isNameTaken(game, n)) return ackErr(cb, "Tahle přezdívka už ve hře je. Zkus jinou.", "NAME_TAKEN");
    if(game.players.length >= game.config.maxPlayers) return ackErr(cb, "Hra je plná", "FULL");

    const seatIndex = nextFreeSeatIndex(game);
    if(seatIndex==null) return ackErr(cb, "Hra je plná", "FULL");

    const p = makePlayer(n, "PLAYER", seatIndex);
    p.connected = true;

    game.players.push(p);
    game.inventory[p.playerId] = blankInventory();
    game.reveals[p.playerId] = { globalYearsRevealed: [], cryptoYearsRevealed: [] };

    // Bind this socket to the player for presence tracking
    attachReconnectToken(game, p.playerId, p.reconnectToken);
    bindSocketToPlayer(socketBindings, socket.id, game.gameId, p.playerId);
    socket.join(`game:${game.gameId}`);

    ackOk(cb, { playerId: p.playerId, seatIndex: p.seatIndex, reconnectToken: p.reconnectToken });
    broadcast(game);
  });

  socket.on("reconnect_game", (payload, cb) => {
    const { gameId, playerId, reconnectToken } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Hra nenalezena", "NOT_FOUND");

    const tokenPid = findPlayerIdByReconnectToken(game, reconnectToken);
    const resolvedPlayerId = tokenPid || playerId;
    const p = (game.players||[]).find(x => x.playerId===resolvedPlayerId);
    if(!p) return ackErr(cb, "Profil v této hře nenalezen", "NO_PLAYER");

    bindPresence(socket, game, p.playerId);
    socket.join(`game:${game.gameId}`);

    ackOk(cb, {
      gameId: game.gameId,
      gameStatus: game.status,
      playerId: p.playerId,
      role: p.role,
      seatIndex: p.seatIndex,
      reconnectToken: getReconnectToken(game, p.playerId) || p.reconnectToken
    });
    broadcast(game);
  });


  
  socket.on("watch_lobby", (payload, cb) => {
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");

    // presence
    if(playerId){
      const p = (game.players||[]).find(x=>x.playerId===playerId);
      if(p){ bindPresence(socket, game, p.playerId); }
    }

    socket.join(`game:${gameId}`);
    ackOk(cb);
    io.to(socket.id).emit("lobby_update", {
      gameId,
      config: game.config,
      players: game.players.map(p=>({
        playerId:p.playerId,
        name:p.name,
        role:p.role,
        seatIndex:p.seatIndex,
        connected: !!p.connected
      }))
    });
    io.to(socket.id).emit("game_state", gamePublic(game, playerId));
  });

  socket.on("watch_game", (payload, cb) => {
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");

    if(playerId){
      const p = (game.players||[]).find(x=>x.playerId===playerId);
      if(p){ bindPresence(socket, game, p.playerId); }
    }

    socket.join(`game:${gameId}`);
    ackOk(cb);
    io.to(socket.id).emit("game_state", gamePublic(game, playerId));
  });

  socket.on("start_game", (payload, cb) => {
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    // allow GM start even without playerId for compatibility
    if(playerId && !isGM(game, playerId)) return ackErr(cb, "Only GM", "FORBIDDEN");
    if(game.status!=="LOBBY") return ackErr(cb, "Already started", "BAD_STATE");

    game.status="IN_PROGRESS";
    game.trends = generateTrends(game.config.yearsTotal);
    game.year = 0;
    startNewYear(game);

    ackOk(cb);
    io.to(`game:${gameId}`).emit("game_started", { gameId });
    broadcast(game);
  });

  socket.on("gm_next", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!isGM(game, playerId)) return ackErr(cb, "Only GM", "FORBIDDEN");
    gmNext(game);
    updateCountdown(game);
    updateCountdown(game);
    ackOk(cb);
    broadcast(game);
  });

  socket.on("gm_back", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!isGM(game, playerId)) return ackErr(cb, "Only GM", "FORBIDDEN");
    if(!canBack(game)) return ackErr(cb, "Nelze vrátit – už proběhly volby.", "GUARD_FAIL");
    gmBack(game);
    ackOk(cb);
    broadcast(game);
  });

  // Trends reveal (per-player, private but stored on server)
  socket.on("reveal_global_next_year", (payload, cb) => {
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.status!=="IN_PROGRESS") return ackErr(cb, "Bad state", "BAD_STATE");

    const inv = game.inventory[playerId] || blankInventory();
    const hasAnalyst = inv.experts.some(e=>e.functionKey==="ANALYST" && !e.used);
    if(!hasAnalyst) return ackErr(cb, "Nemáš Analytika.", "NO_POWER");

    const currentYear = game.year;
    const revealed = new Set(game.reveals[playerId]?.globalYearsRevealed || []);
    let target = null;
    for(let y=currentYear+1; y<=game.config.yearsTotal; y++){
      if(!revealed.has(y)){ target = y; break; }
    }
    if(!target) return ackErr(cb, "Není co odkrývat.", "NO_TARGET");

    // consume 1 analyst
    const ex = inv.experts.find(e=>e.functionKey==="ANALYST" && !e.used);
    ex.used = true;

    game.reveals[playerId].globalYearsRevealed.push(target);
    ackOk(cb, { year: target });
    broadcast(game);
  });

  socket.on("reveal_crypto_next_year", (payload, cb) => {
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.status!=="IN_PROGRESS") return ackErr(cb, "Bad state", "BAD_STATE");

    const inv = game.inventory[playerId] || blankInventory();
    const has = inv.experts.some(e=>e.functionKey==="CRYPTOGURU" && !e.used);
    if(!has) return ackErr(cb, "Nemáš Kryptoguru.", "NO_POWER");

    const currentYear = game.year;
    const revealed = new Set(game.reveals[playerId]?.cryptoYearsRevealed || []);
    let target = null;
    for(let y=currentYear+1; y<=game.config.yearsTotal; y++){
      if(!revealed.has(y)){ target = y; break; }
    }
    if(!target) return ackErr(cb, "Není co odkrývat.", "NO_TARGET");

    const ex = inv.experts.find(e=>e.functionKey==="CRYPTOGURU" && !e.used);
    ex.used = true;

    game.reveals[playerId].cryptoYearsRevealed.push(target);
    ackOk(cb, { year: target });
    broadcast(game);
  });


  // Lawyer protection against a specific global trend (per-player, per-year)
  socket.on("use_lawyer_on_trend", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId, trendKey } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!playerId) return ackErr(cb, "Unknown player", "NO_PLAYER");
    if(game.status!=="IN_PROGRESS") return ackErr(cb, "Bad state", "BAD_STATE");

    const y = String(game.year||1);
    const globals = currentYearGlobals(game);
    const trend = globals.find(t=>t.key===trendKey) || null;
    if(!trend) return ackErr(cb, "Trend není aktivní v tomto roce.", "NOT_ACTIVE");

    if(!trend.lawyer?.allowed) return ackErr(cb, "Na tento trend nelze použít Právníka.", "NO_LAWYER");
    if(!canUseLawyerNow(game, trend)) return ackErr(cb, "Právníka nyní nelze použít (špatná fáze).", "BAD_TIME");

    const inv = game.inventory[playerId] || blankInventory();
    const ex = inv.experts.find(e=>e.functionKey==="LAWYER_TRENDS" && !e.used);
    if(!ex) return ackErr(cb, "Právník není k dispozici.", "NO_POWER");

    // consume lawyer
    ex.used = true;

    ensureLawyerStore(game, playerId);
    game.lawyer.protections[playerId][y][trendKey] = true;

    // Immediate on-screen notice (player can show others)
    addNotice(game, playerId, trendKey, `Právník aktivován: ${trend.name}. Tento globální trend se na hráče v roce ${game.year||1} nevztahuje.`);

    ackOk(cb, { trendKey });
    broadcast(game);
  });

  // Commit ML bid (no winner resolution here)
  socket.on("commit_ml_bid", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId, amountUsd } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!playerId) return ackErr(cb, "Unknown player", "NO_PLAYER");
    if(game.phase!=="BIZ" || game.bizStep!=="ML_BID") return ackErr(cb, "Not ML step", "BAD_STATE");

    let val = amountUsd;
    if(val===null) val=null;
    else {
      val = Number(val);
      if(!Number.isFinite(val) || val<0) return ackErr(cb, "Invalid amount", "BAD_INPUT");
      val = Math.floor(val);
    }
    game.biz.mlBids[playerId] = { amountUsd: val, committed:true, ts: now() };
    markCommitted(game, playerId, { kind: "ML_BID" });
    finalizeMlResult(game);
    const rr = currentReadiness(game);
    if(rr.ready===rr.total) ensureMlRanking(game);
    updateCountdown(game);
    ackOk(cb, { result: game.biz.mlResult || null });
    broadcast(game);
  });

  // Move selection (locks markets)
  socket.on("pick_market", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId, marketId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!playerId) return ackErr(cb, "Unknown player", "NO_PLAYER");
    if(game.phase!=="BIZ" || game.bizStep!=="MOVE") return ackErr(cb, "Not MOVE step", "BAD_STATE");
    if(game.biz.move[playerId]?.committed) return ackErr(cb, "Already moved", "ALREADY");

    if(!(marketId in game.biz.marketLocks)) return ackErr(cb, "Unknown market", "BAD_INPUT");
    if(game.biz.marketLocks[marketId] && game.biz.marketLocks[marketId]!==playerId) return ackErr(cb, "Locked", "LOCKED");

    // release previous
    const prev = getPlayer(game, playerId)?.marketId;
    if(prev && prev in game.biz.marketLocks) game.biz.marketLocks[prev] = null;

    game.biz.marketLocks[marketId] = playerId;
    const p = getPlayer(game, playerId); if(p) p.marketId = marketId;
    game.biz.move[playerId] = { marketId, committed:true, ts: now() };
    markCommitted(game, playerId, { kind: "MOVE", marketId });

    ackOk(cb);
    broadcast(game);
  });

  // Auction (envelope) bid
  socket.on("commit_auction_bid", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId, bidUsd, usedLobbyist } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!playerId) return ackErr(cb, "Unknown player", "NO_PLAYER");
    if(game.phase!=="BIZ" || game.bizStep!=="AUCTION_ENVELOPE") return ackErr(cb, "Not AUCTION step", "BAD_STATE");

    let val = bidUsd;
    if(val===null) val=null;
    else {
      val = Number(val);
      if(!Number.isFinite(val) || val<0) return ackErr(cb, "Invalid bid", "BAD_INPUT");
      val = Math.floor(val);
    }
    markCommitted(game, playerId, { kind: "AUCTION_ENVELOPE" });
    game.biz.auction.entries[playerId] = {
      bidUsd: val,
      committed:true,
      usedLobbyist: !!usedLobbyist,
      finalBidUsd: null,
      finalCommitted:false,
      ts: now()
    };

    // Auto-start lobbyist subphase when everyone committed AND someone used lobbyist.
    // This keeps the game flowing and preserves secrecy for other players.
    try{
      const entries = game.biz.auction.entries;
      const allCommitted = game.players.every(p=>entries[p.playerId]?.committed);
      if(allCommitted){
        const anyLobby = Object.values(entries).some(v=>v?.usedLobbyist);
        if(anyLobby) game.biz.auction.lobbyistPhaseActive = true;
      }
    }catch{}

    finalizeAuctionResult(game);
    if(game.biz.auction.lobbyistPhaseActive){
      stopCountdown(game);
    } else {
      const rr = currentReadiness(game);
      if(rr.ready===rr.total) ensureAuctionRanking(game);
      updateCountdown(game);
    }
    ackOk(cb, { result: game.biz.auction?.result || null });
    broadcast(game);
  });

  socket.on("gm_open_lobbyist_window", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!isGM(game, playerId)) return ackErr(cb, "Only GM", "FORBIDDEN");
    if(game.phase!=="BIZ" || game.bizStep!=="AUCTION_ENVELOPE") return ackErr(cb, "Not AUCTION step", "BAD_STATE");

    // guard: all players committed AND someone used lobbyist
    const entries = game.biz.auction.entries;
    const allCommitted = game.players.every(p=>entries[p.playerId]?.committed);
    if(!allCommitted) return ackErr(cb, "Nejdřív všichni odešlou obálku.", "GUARD_FAIL");
    const anyLobby = Object.values(entries).some(v=>v?.usedLobbyist);
    if(!anyLobby) return ackErr(cb, "Nikdo nepoužil lobbistu.", "GUARD_FAIL");

    game.biz.auction.lobbyistPhaseActive = true;
    ackOk(cb);
    broadcast(game);
  });

  socket.on("commit_auction_final_bid", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId, finalBidUsd } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!playerId) return ackErr(cb, "Unknown player", "NO_PLAYER");
    if(game.phase!=="BIZ" || game.bizStep!=="AUCTION_ENVELOPE") return ackErr(cb, "Not AUCTION step", "BAD_STATE");
    if(!game.biz.auction.lobbyistPhaseActive) return ackErr(cb, "No lobbyist window", "BAD_STATE");

    const entry = game.biz.auction.entries[playerId];
    if(!entry?.usedLobbyist) return ackErr(cb, "Not a lobbyist user", "FORBIDDEN");

    let val = finalBidUsd;
    if(val===null) val = null;
    else {
      val = Math.floor(Number(val));
      if(!Number.isFinite(val) || val<0) return ackErr(cb, "Invalid bid", "BAD_INPUT");
    }

    entry.finalBidUsd = val;
    entry.finalCommitted = true;
    markCommitted(game, playerId, { kind: "AUCTION_FINAL" });
    finalizeAuctionResult(game);
    const rr = currentReadiness(game);
    if(rr.ready===rr.total) ensureAuctionRanking(game);
    updateCountdown(game);
    ackOk(cb, { result: game.biz.auction?.result || null });
    broadcast(game);
  });

  // Acquisition commit (definitive decision for this step)
  socket.on("commit_acquire", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId, gotCard } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!playerId) return ackErr(cb, "Unknown player", "NO_PLAYER");
    if(game.phase!=="BIZ" || game.bizStep!=="ACQUIRE") return ackErr(cb, "Not ACQUIRE step", "BAD_STATE");

    game.biz.acquire.entries[playerId] = { committed:true, gotCard: !!gotCard, ts: now() };
    markCommitted(game, playerId, { kind: "ACQUIRE", gotCard: !!gotCard });
    ackOk(cb);
    broadcast(game);
  });

  // Card scan helpers (preview vs claim)
  socket.on("scan_preview", (payload, cb) => {
    const { gameId, cardQr } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const id = String(cardQr||"").trim();
    if(!id) return ackErr(cb, "Bad QR", "BAD_INPUT");

    const card = CATALOG.investments.find(c=>c.cardId===id)
      || CATALOG.miningFarms.find(c=>c.cardId===id)
      || CATALOG.experts.find(c=>c.cardId===id);
    if(!card) return ackErr(cb, "Unknown card", "UNKNOWN");

    const sets = game.availableCards;
    const set = card.kind==="INVESTMENT" ? sets.investments : card.kind==="MINING_FARM" ? sets.miningFarms : sets.experts;
    if(!set.has(card.cardId)) return ackErr(cb, "Karta není v nabídce.", "NOT_AVAILABLE");

    ackOk(cb, { card });
  });

  socket.on("claim_card", (payload, cb) => {
    const { gameId, playerId, cardId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const id = String(cardId||"").trim();
    if(!id) return ackErr(cb, "Bad cardId", "BAD_INPUT");

    const card = CATALOG.investments.find(c=>c.cardId===id)
      || CATALOG.miningFarms.find(c=>c.cardId===id)
      || CATALOG.experts.find(c=>c.cardId===id);
    if(!card) return ackErr(cb, "Unknown card", "UNKNOWN");

    const sets = game.availableCards;
    const set = card.kind==="INVESTMENT" ? sets.investments : card.kind==="MINING_FARM" ? sets.miningFarms : sets.experts;
    if(!set.has(card.cardId)) return ackErr(cb, "Karta není v nabídce.", "NOT_AVAILABLE");

    set.delete(card.cardId);
    const inv = game.inventory[playerId] || blankInventory();
    if(card.kind==="EXPERT") inv.experts.push({ ...card, used:false });
    else if(card.kind==="INVESTMENT") inv.investments.push({ ...card });
    else inv.miningFarms.push({ ...card });
    game.inventory[playerId]=inv;

    ackOk(cb, { card });
    broadcast(game);
  });

  // Scan cards
  socket.on("scan_card", (payload, cb) => {
    const { gameId, playerId, cardQr } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const id = String(cardQr||"").trim();
    if(!id) return ackErr(cb, "Bad QR", "BAD_INPUT");

    // find in catalog
    const card = CATALOG.investments.find(c=>c.cardId===id)
      || CATALOG.miningFarms.find(c=>c.cardId===id)
      || CATALOG.experts.find(c=>c.cardId===id);
    if(!card) return ackErr(cb, "Unknown card", "UNKNOWN");

    // enforce availability sets
    const sets = game.availableCards;
    const set = card.kind==="INVESTMENT" ? sets.investments : card.kind==="MINING_FARM" ? sets.miningFarms : sets.experts;
    if(!set.has(card.cardId)) return ackErr(cb, "Karta není v nabídce.", "NOT_AVAILABLE");

    set.delete(card.cardId);
    const inv = game.inventory[playerId] || blankInventory();
    if(card.kind==="EXPERT"){
      inv.experts.push({ ...card, used:false });
    } else if(card.kind==="INVESTMENT"){
      inv.investments.push({ ...card });
    } else {
      inv.miningFarms.push({ ...card });
    }
    game.inventory[playerId]=inv;

    ackOk(cb, { card });
    broadcast(game);
  });

  socket.on("drop_card", (payload, cb) => {
    const { gameId, playerId, cardId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const id = String(cardId||"").trim();
    if(!id) return ackErr(cb, "Bad cardId", "BAD_INPUT");

    const inv = game.inventory[playerId] || blankInventory();
    let found = null;
    for(const key of ["investments","miningFarms","experts"]){
      const idx = inv[key].findIndex(c=>c.cardId===id);
      if(idx>=0){ found = inv[key][idx]; inv[key].splice(idx,1); break; }
    }
    if(!found) return ackErr(cb, "Card not owned", "NOT_OWNED");

    const sets = game.availableCards;
    const set = found.kind==="INVESTMENT" ? sets.investments : found.kind==="MINING_FARM" ? sets.miningFarms : sets.experts;
    set.add(found.cardId);

    game.inventory[playerId]=inv;
    ackOk(cb);
    broadcast(game);
  });

  // Crypto commit (server computes deltaUsd for display)
  socket.on("commit_crypto", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId, deltas } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!playerId) return ackErr(cb, "Unknown player", "NO_PLAYER");
    if(game.phase!=="CRYPTO") return ackErr(cb, "Not CRYPTO phase", "BAD_STATE");

    const clean = {};
    let deltaUsd = 0;
    for(const sym of ["BTC","ETH","LTC","SIA"]){
      const d = Math.floor(Number(deltas?.[sym]||0));
      if(!Number.isFinite(d)) return ackErr(cb, "Bad deltas", "BAD_INPUT");
      clean[sym]=d;
      deltaUsd += -d * Number(game.crypto.rates[sym]||0); // buying positive costs USD (negative delta), selling negative gives USD
    }
    game.crypto.entries[playerId] = { deltas: clean, deltaUsd, committed:true, ts: now() };
    markCommitted(game, playerId, { kind: "CRYPTO" });
    updateCountdown(game);
    ackOk(cb, { deltaUsd });
    broadcast(game);
  });

  // Apply expert effect (steal base production for this year)
  socket.on("apply_expert_effect", (payload, cb) => {
    const { gameId, playerId, effect } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.phase!=="SETTLE") return ackErr(cb, "Not SETTLE phase", "BAD_STATE");

    const type = effect?.type;
    if(type!=="STEAL_BASE_PRODUCTION") return ackErr(cb, "Unsupported effect", "BAD_INPUT");
    const targetPlayerId = effect?.targetPlayerId;
    const cardId = effect?.cardId;

    const inv = game.inventory[playerId] || blankInventory();
    const has = inv.experts.some(e=>e.functionKey==="STEAL_BASE_PROD" && !e.used);
    if(!has) return ackErr(cb, "Nemáš lobbistu (krádež).", "NO_POWER");

    // Card must belong to target (ownership does not change)
    const targetInv = game.inventory[targetPlayerId] || blankInventory();
    const card = targetInv.investments.find(c=>c.cardId===cardId);
    if(!card) return ackErr(cb, "Cíl nevlastní tuto investici.", "BAD_INPUT");

    const usd = Number(card.usdProduction||0);

    // consume expert
    const ex = inv.experts.find(e=>e.functionKey==="STEAL_BASE_PROD" && !e.used);
    ex.used=true;

    game.settle.effects.push({ type:"STEAL_BASE_PRODUCTION", fromPlayerId: targetPlayerId, toPlayerId: playerId, cardId, usd });

    // If some players already started audit, update their computed settlements so UI can show "Finální audit".
    try{
      for(const p of game.players){
        const pid = p.playerId;
        if(game.settle.entries?.[pid]?.committed){
          const { settlementUsd, breakdown } = calcSettlementFor(game, pid);
          game.settle.entries[pid] = { ...game.settle.entries[pid], settlementUsd, breakdown };
        }
      }
    }catch(e){}
    ackOk(cb);
    broadcast(game);
  });

  // V33: Audit lobbyist actions (sabotage / steal) – consumes one unused STEAL_BASE_PROD expert.
  socket.on("apply_audit_lobbyist", (payload, cb) => {
    const { gameId, playerId, action, targetPlayerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.phase!=="SETTLE") return ackErr(cb, "Not SETTLE phase", "BAD_STATE");

    const inv = game.inventory[playerId] || blankInventory();
    const ex = inv.experts.find(e=>e.functionKey==="STEAL_BASE_PROD" && !e.used);
    if(!ex) return ackErr(cb, "Nemáš lobbistu.", "NO_POWER");
    const targetInv = game.inventory[targetPlayerId] || blankInventory();

    let usd = 0;
    if(action==="AUDIT_LOBBYIST_SABOTAGE"){
      usd = roundDownToHundreds(0.5 * sumTradBase(targetInv));
      game.settle.effects.push({ type:"AUDIT_LOBBYIST_SABOTAGE", fromPlayerId: playerId, targetPlayerId, usd });
    } else if(action==="AUDIT_LOBBYIST_STEAL"){
      usd = roundDownToHundreds(maxTradBase(targetInv));
      game.settle.effects.push({ type:"AUDIT_LOBBYIST_STEAL", fromPlayerId: targetPlayerId, toPlayerId: playerId, usd });
    } else {
      return ackErr(cb, "Bad action", "BAD_INPUT");
    }

    // consume lobbyist
    ex.used = true;

    // refresh computed settlements for already committed entries
    try{
      for(const p of game.players){
        const pid = p.playerId;
        if(game.settle.entries?.[pid]?.committed){
          const { settlementUsd, breakdown } = calcSettlementFor(game, pid);
          game.settle.entries[pid] = { ...game.settle.entries[pid], settlementUsd, breakdown };
        }
      }
    }catch(e){}

    ackOk(cb, { usd });
    broadcast(game);
  });

  // V33: Activate audit shield (LAWYER) – consumes one unused LAWYER_TRENDS expert.
  socket.on("activate_audit_shield", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!playerId) return ackErr(cb, "Unknown player", "NO_PLAYER");
    if(game.phase!=="SETTLE") return ackErr(cb, "Not SETTLE phase", "BAD_STATE");

    const inv = game.inventory[playerId] || blankInventory();
    const ex = inv.experts.find(e=>e.functionKey==="LAWYER_TRENDS" && !e.used);
    if(!ex) return ackErr(cb, "Nemáš právníka.", "NO_POWER");

    const y = String(game.year||1);
    game.lawyer = game.lawyer || {};
    game.lawyer.auditShield = game.lawyer.auditShield || {};
    game.lawyer.auditShield[playerId] = game.lawyer.auditShield[playerId] || {};
    game.lawyer.auditShield[playerId][y] = true;

    ex.used = true;

    // refresh computed settlements for already committed entries
    try{
      for(const p of game.players){
        const pid = p.playerId;
        if(game.settle.entries?.[pid]?.committed){
          const { settlementUsd, breakdown } = calcSettlementFor(game, pid);
          game.settle.entries[pid] = { ...game.settle.entries[pid], settlementUsd, breakdown };
        }
      }
    }catch(e){}

    ackOk(cb);
    broadcast(game);
  });

  // Settlement commit (server computes display settlement)
  socket.on("commit_settlement_ready", (payload, cb) => {
    const { gameId, playerId: payloadPlayerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
    if(!playerId) return ackErr(cb, "Unknown player", "NO_PLAYER");
    if(game.phase!=="SETTLE") return ackErr(cb, "Not SETTLE phase", "BAD_STATE");

    const { settlementUsd, breakdown } = calcSettlementFor(game, playerId);
    game.settle.entries[playerId] = { settlementUsd, breakdown, committed:true, ts: now() };
    markCommitted(game, playerId, { kind: "SETTLE" });
    updateCountdown(game);
    ackOk(cb, { settlementUsd });
    broadcast(game);
  });

  // Preview audit (no commit) – used by "Předběžný audit" in accounting.
  socket.on("preview_audit", (payload, cb) => {
    try{
      const { gameId, playerId: payloadPlayerId } = payload || {};
      const game = games.get(gameId);
      if(!game) return ackErr(cb, "Hra neexistuje.");
      const playerId = resolveActorPlayerId(socket, game, payloadPlayerId);
      const p = game.players.find(x=>x.playerId===playerId);
      if(!p) return ackErr(cb, "Neplatný hráč.");
      const { settlementUsd, breakdown } = calcSettlementFor(game, playerId);
      return ackOk(cb, { settlementUsd, breakdown });
    }catch(e){
      return ackErr(cb, "Chyba preview auditu.");
    }
  });
  socket.on("disconnect", () => {
      const b = socketBindings.get(socket.id);
      if(!b) return;
      unbindSocket(socketBindings, socket.id);
      const game = getGame(b.gameId);
      if(!game) return;
      const p = (game.players||[]).find(x=>x.playerId===b.playerId);
      if(p){ p.connected = false; broadcast(game); }
    });


});



  setInterval(()=>{
    for(const game of games.values()){
      if(!game?.countdown?.active) continue;
      if(Number(game.countdown.endsAt||0) > now()) { broadcast(game); continue; }
      autoCommitTimedOutPlayers(game);
      broadcast(game);
    }
  }, COUNTDOWN_TICK_MS);
}

module.exports = { registerSocketHandlers };
