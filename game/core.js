const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { PHASES, BIZ_STEPS, CRYPTO_COINS } = require("../config/game-config");
const { nextPhaseState, previousPhaseState, currentPhaseKey } = require("../engine/phase-machine");
const { ensureActionRegistry, markCommitted, resetCurrentPhaseActions } = require("../engine/action-registry");
const { issueReconnectToken, resolveSocketPlayerId } = require("../session/player-session");

const COUNTDOWN_DURATION_MS = 45000;
const COUNTDOWN_TICK_MS = 1000;

function now(){ return Date.now(); }
function shortId(){ return uuidv4().slice(0,8); }
function clampPlayers(n){ n=Number(n); if(!Number.isFinite(n)) return 1; return Math.max(1, Math.min(6, Math.floor(n))); }
function clampYears(n){ n=Number(n); if(!Number.isFinite(n)) return 4; return (n===5?5:4); }
function shuffle(arr){ const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function pickRandom(arr, k){ return shuffle(arr).slice(0,k); }

const continents = ["EUROPE","ASIA","AFRICA","N_AMERICA","S_AMERICA","OCEANIA"];
const markets12 = Array.from({length:12}, (_,i)=>`M${String(i+1).padStart(2,"0")}`);

// Simple catalog (test) – cards are identified by QR payload == cardId
const CATALOG = (() => {
  function loadJson(name, fallback){
    try{
      const raw = fs.readFileSync(path.join(__dirname, "data", name), "utf-8");
      const arr = JSON.parse(raw);
      if(Array.isArray(arr) && arr.length) return arr;
    }catch(e){}
    return fallback;
  }

  const investments = loadJson("traditionalInvestments.json", []);
  const miningFarms = loadJson("miningFarms.json", []);
  const experts = loadJson("experts.json", []);

function loadGlobalTrends(){
  try{
    const p = path.join(__dirname, "data", "globalTrends.json");
    const raw = fs.readFileSync(p, "utf-8");
    const arr = JSON.parse(raw);
    if(Array.isArray(arr) && arr.length>0) return arr;
  }catch(e){}
  // Fallback (should not happen in deploy)
  return [
    { key:"ENERGY_CRISIS", name:"Energetická krize", icon:"⚡", desc:"Rychlý růst ceny energie." }
  ];
}

function loadCryptoTrends(){
  try{
    const p = path.join(__dirname, "data", "cryptoTrends.json");
    const raw = fs.readFileSync(p, "utf-8");
    const arr = JSON.parse(raw);
    if(Array.isArray(arr) && arr.length>0) return arr;
  }catch(e){}
  return [
    { key:"CRYPTO_TREND_1", name:"Kryptotrend 1", coeff:{ BTC:1, ETH:1, LTC:1, SIA:1 } }
  ];
}

// Trends pool (minimal for test)
  const globalTrends = loadGlobalTrends();

  // Regionální trendy – 4 možnosti dle pravidel:
  // - Investiční boom: do dražební položky lze přidat +1 Tradiční investici
  // - Vysoká vzdělanost: do dražební položky lze přidat +1 Experta
  // - Stabilita: bez vlivu
  // - Daně: při vstupu na kontinent hráč platí 3× cenová hladina (lze chránit Právníkem v MOVE)
  // Pozn.: pro test appky jsou zde trendy primárně informační (hráči vyhodnocují mimo aplikaci),
  // ale poskytujeme popis a možnost ochrany (Daně) pro konzistentní UX.
  const regionalBase = [
    {
      key:"REG_INVESTMENT_BOOM",
      name:"Investiční boom",
      icon:"📈",
      desc:"Do dražební položky může hráč přidat o jednu Tradiční investici navíc z balíčku.",
      lawyer:{ allowed:false }
    },
    {
      key:"REG_HIGH_EDUCATION",
      name:"Vysoká vzdělanost",
      icon:"🎓",
      desc:"Do dražební položky může hráč přidat o jednoho Experta navíc z balíčku.",
      lawyer:{ allowed:false }
    },
    {
      key:"REG_STABILITY",
      name:"Stabilita",
      icon:"🛡️",
      desc:"Nejsou žádné vlivy.",
      lawyer:{ allowed:false }
    },
    {
      key:"REG_TAXES",
      name:"Daně",
      icon:"💸",
      desc:"Hráč, který skončí svůj pohyb na daném kontinentu, zaplatí okamžitě trojnásobek cenové hladiny dle aktuální cenové hladiny. Účinku se lze vyhnout funkcí Právníka.",
      lawyer:{ allowed:true, phase:"BIZ_MOVE_ONLY" }
    }
  ];
  const regionalTrends = Object.fromEntries(
    continents.map(c=>[c, regionalBase.map(t=>({ ...t, key:`${c}_${t.key}` }))])
  );
  const cryptoTrends = loadCryptoTrends();


  const markets = [];
  // Variant A: 6 continents × 2 markets (Bible mapping)
  const CONTINENT_MARKET_TYPES = {
    N_AMERICA: ["INDUSTRY","MINING"],
    S_AMERICA: ["MINING","AGRO"],
    EUROPE: ["INDUSTRY","AGRO"],
    AFRICA: ["MINING","AGRO"],
    ASIA: ["INDUSTRY","MINING"],
    OCEANIA: ["INDUSTRY","AGRO"],
  };
  const mkMarketId = (continent, type) => `${continent}_${type}`;

  for (const continent of continents){
    const types = CONTINENT_MARKET_TYPES[continent] || [];
    for (const type of types){
      markets.push({
        marketId: mkMarketId(continent, type),
        name: `${continent} ${type}`,
        continent,
        type, // "INDUSTRY" | "MINING" | "AGRO"
        kind: "MARKET",
      });
    }
  }

  // 3 mining farm board slots (not on a continent)
  for (let i=1;i<=3;i++){
    markets.push({
      marketId: `FARM_${i}`,
      name: `Farma ${i}`,
      continent: null,
      type: "FARM",
      kind: "FARM",
      slot: i,
    });
  }

  return { investments, miningFarms, experts, globalTrends, regionalTrends, cryptoTrends, continents, markets };
})();

function generateTrends(yearsTotal){
  const years = {};
  for(let y=1;y<=yearsTotal;y++){
    const globals = pickRandom(CATALOG.globalTrends, 3).map(t=>({ ...t, trendId: uuidv4(), year:y, kind:"GLOBAL" }));
    const crypto = { ...pickRandom(CATALOG.cryptoTrends, 1)[0], trendId: uuidv4(), year:y, kind:"CRYPTO" };
    const regional = {};
    for(const [continent, list] of Object.entries(CATALOG.regionalTrends)){
      regional[continent] = { ...pickRandom(list,1)[0], trendId: uuidv4(), year:y, kind:"REGIONAL", continent };
    }
    years[String(y)] = { year:y, globals, crypto, regional };
  }
  return { seed: uuidv4(), yearsTotal, byYear: years };
}

// Game store
const games = new Map();

function makePlayer(name, role, seatIndex){
  return {
    playerId: shortId(),
    name: String(name||"").trim().slice(0,32) || "Hráč",
    role,
    seatIndex: (typeof seatIndex==="number" ? seatIndex : null),
    connected: false,
    joinedAt: now(),
    marketId: null,
    wallet: { usd: 0, crypto: { BTC:3, ETH:3, LTC:3, SIA:3 } },
    reconnectToken: issueReconnectToken()
  };
}

function blankInventory(){
  return { investments: [], miningFarms: [], experts: [] };
}


function normName(n){ return String(n||"").trim().toLowerCase(); }
function isNameTaken(game, name){
  const nn = normName(name);
  return game.players.some(p => normName(p.name)===nn);
}
function nextFreeSeatIndex(game){
  // seats: GM=0, players=1..5 (max 6 incl GM)
  const used = new Set(game.players.map(p=>p.seatIndex).filter(v=>typeof v==="number"));
  for(let i=1;i<=5;i++){
    if(!used.has(i)) return i;
  }
  return null;
}

function newGame({ gmName, yearsTotal, maxPlayers }){
  const gameId = shortId();
  const gm = makePlayer(gmName, "GM", 0);

  const game = {
    gameId,
    status: "LOBBY",
    config: { yearsTotal: clampYears(yearsTotal), maxPlayers: clampPlayers(maxPlayers) },
    createdAt: now(),
    players: [gm],

    trends: null,
    reveals: {},

    lawyer: { protections: {}, notices: {} },

    inventory: { [gm.playerId]: blankInventory() },
    availableCards: {
      investments: new Set(CATALOG.investments.map(c=>c.cardId)),
      miningFarms: new Set(CATALOG.miningFarms.map(c=>c.cardId)),
      experts: new Set(CATALOG.experts.map(c=>c.cardId)),
    },

    year: 0,
    phase: null,      // "BIZ"|"CRYPTO"|"SETTLE"
    bizStep: null,    // "ML_BID"|"MOVE"|"AUCTION_ENVELOPE"|"ACQUIRE"

    // committed values – purely for display & consistency
    biz: {
      mlBids: {},      // pid -> { amountUsd:null|number, committed:boolean }
      mlResult: null,
      move: {},        // pid -> { marketId:null|string, committed:boolean }
      marketLocks: {}, // marketId -> pid|null
      auction: {
        entries: {},        // pid -> { bidUsd:null|number, committed, usedLobbyist, finalBidUsd, finalCommitted }
        lobbyistPhaseActive: false,
        result: null,
      }
      ,
      acquire: {
        entries: {} // pid -> { committed:boolean, gotCard:boolean }
      }
    },

    crypto: {
      rates: { BTC:8000, ETH:4000, LTC:2000, SIA:1000 },
      ratesFrozen: true,
      entries: {} // pid -> { deltas:{}, deltaUsd:number, committed:boolean }
    },

    settle: {
      entries: {},  // pid -> { settlementUsd:number, committed:boolean, breakdown:[{label,usd}] }
      effects: []   // applied expert effects for this year
    },

    reconnectTokens: {},
    phaseActions: {},
    countdown: { active:false, phaseKey:null, endsAt:null }
  };

  // init reveal state
  game.reveals[gm.playerId] = { globalYearsRevealed: [], cryptoYearsRevealed: [] };
  attachReconnectToken(game, gm.playerId, gm.reconnectToken);
  ensureActionRegistry(game);

  games.set(gameId, game);
  return { game, gm };
}

function getActivePlayerIds(game){
  return (game.players||[]).map(p=>p.playerId);
}

function timedPhaseKey(game){
  if(!game) return null;
  if(game.phase==="BIZ" && ["ML_BID","MOVE","AUCTION_ENVELOPE"].includes(game.bizStep)) return `${game.phase}:${game.bizStep}`;
  if(game.phase==="CRYPTO") return `${game.phase}`;
  return null;
}

function currentReadiness(game){
  const pidList = getActivePlayerIds(game);
  const phase = game?.phase;
  const step = game?.bizStep;
  function committedFor(pid){
    if(phase==="BIZ" && step==="ML_BID") return !!game?.biz?.mlBids?.[pid]?.committed;
    if(phase==="BIZ" && step==="MOVE") return !!game?.biz?.move?.[pid]?.committed;
    if(phase==="BIZ" && step==="AUCTION_ENVELOPE"){
      const e = game?.biz?.auction?.entries?.[pid];
      if(!game?.biz?.auction?.lobbyistPhaseActive) return !!e?.committed;
      if(!e?.usedLobbyist) return true;
      return !!e?.finalCommitted;
    }
    if(phase==="BIZ" && step==="ACQUIRE") return !!game?.biz?.acquire?.entries?.[pid]?.committed;
    if(phase==="CRYPTO") return !!game?.crypto?.entries?.[pid]?.committed;
    if(phase==="SETTLE") return !!game?.settle?.entries?.[pid]?.committed;
    return false;
  }
  let totalIds = pidList;
  if(phase==="BIZ" && step==="AUCTION_ENVELOPE" && game?.biz?.auction?.lobbyistPhaseActive){
    const entries = game?.biz?.auction?.entries || {};
    totalIds = pidList.filter(pid=>!!entries[pid]?.usedLobbyist);
    if(totalIds.length===0) totalIds = pidList;
  }
  const ready = totalIds.filter(pid=>committedFor(pid)).length;
  const total = totalIds.length;
  return { ready, total, isGreen: total>0 && ready===total, totalIds };
}

function currentPresence(game){
  const players = game?.players || [];
  const connected = players.filter(p=>!!p.connected).length;
  return { connected, total: players.length };
}

function ensureCountdownStore(game){
  if(!game.countdown) game.countdown = { active:false, phaseKey:null, endsAt:null };
}

function stopCountdown(game){
  ensureCountdownStore(game);
  game.countdown.active = false;
  game.countdown.phaseKey = null;
  game.countdown.endsAt = null;
}

function startCountdown(game){
  const phaseKey = timedPhaseKey(game);
  if(!phaseKey) return;
  ensureCountdownStore(game);
  if(game.countdown.active && game.countdown.phaseKey===phaseKey) return;
  game.countdown.active = true;
  game.countdown.phaseKey = phaseKey;
  game.countdown.endsAt = now() + COUNTDOWN_DURATION_MS;
}

function countdownPublic(game){
  ensureCountdownStore(game);
  const remainingMs = game.countdown.active ? Math.max(0, Number(game.countdown.endsAt||0) - now()) : 0;
  return { active: !!game.countdown.active, phaseKey: game.countdown.phaseKey, endsAt: game.countdown.endsAt, remainingMs };
}

function updateCountdown(game){
  const phaseKey = timedPhaseKey(game);
  if(!phaseKey){ stopCountdown(game); return; }
  const r = currentReadiness(game);
  if(r.total>0 && r.ready===r.total){ stopCountdown(game); return; }
  if(r.ready>0 && r.ready<r.total){ startCountdown(game); return; }
  stopCountdown(game);
}

function ensureMlRanking(game){
  const rows = (game.players||[]).map(p=>{
    const bid = game.biz?.mlBids?.[p.playerId] || {};
    const amountUsd = Number.isFinite(Number(bid.amountUsd)) ? Number(bid.amountUsd) : -1;
    const ts = Number(bid.ts || Number.MAX_SAFE_INTEGER);
    return { playerId:p.playerId, name:p.name, amountUsd, ts };
  });
  rows.sort((a,b)=> (b.amountUsd-a.amountUsd) || (a.ts-b.ts) || a.name.localeCompare(b.name));
  game.biz.mlRanking = rows.map((r, idx)=>({ rank: idx+1, playerId:r.playerId, name:r.name }));
  game.biz.mlRankingVisible = true;
}

function ensureAuctionRanking(game){
  const rows = (game.players||[]).map(p=>{
    const entry = game.biz?.auction?.entries?.[p.playerId] || {};
    const raw = effectiveAuctionBid(entry);
    const amountUsd = Number.isFinite(Number(raw)) ? Number(raw) : -1;
    const ts = Number(entry.ts || Number.MAX_SAFE_INTEGER);
    return { playerId:p.playerId, name:p.name, amountUsd, ts };
  });
  rows.sort((a,b)=> (b.amountUsd-a.amountUsd) || (a.ts-b.ts) || a.name.localeCompare(b.name));
  game.biz.auction.ranking = rows.map((r, idx)=>({ rank: idx+1, playerId:r.playerId, name:r.name }));
  game.biz.auction.rankingVisible = true;
}

function autoCommitTimedOutPlayers(game){
  const r = currentReadiness(game);
  for(const pid of r.totalIds){
    if(game.phase==="BIZ" && game.bizStep==="ML_BID"){
      if(!game.biz.mlBids[pid]?.committed){
        game.biz.mlBids[pid] = { amountUsd:null, committed:true, ts: now() };
        markCommitted(game, pid, { kind: "ML_BID_TIMEOUT" });
      }
    } else if(game.phase==="BIZ" && game.bizStep==="MOVE"){
      if(!game.biz.move[pid]?.committed){
        const p = getPlayer(game, pid);
        game.biz.move[pid] = { marketId: p?.marketId || null, committed:true, ts: now() };
        markCommitted(game, pid, { kind: "MOVE_TIMEOUT", marketId: p?.marketId || null });
      }
    } else if(game.phase==="BIZ" && game.bizStep==="AUCTION_ENVELOPE"){
      const entry = game.biz.auction.entries[pid] || {};
      if(!game.biz.auction.lobbyistPhaseActive){
        if(!entry.committed){
          game.biz.auction.entries[pid] = { bidUsd:null, committed:true, usedLobbyist:false, finalBidUsd:null, finalCommitted:false, ts: now() };
          markCommitted(game, pid, { kind: "AUCTION_TIMEOUT" });
        }
      } else if(entry.usedLobbyist && !entry.finalCommitted){
        entry.finalBidUsd = entry.bidUsd ?? null;
        entry.finalCommitted = true;
        markCommitted(game, pid, { kind: "AUCTION_FINAL_TIMEOUT" });
      }
    } else if(game.phase==="CRYPTO"){
      if(!game.crypto.entries[pid]?.committed){
        game.crypto.entries[pid] = { deltas:{ BTC:0, ETH:0, LTC:0, SIA:0 }, deltaUsd:0, committed:true, ts: now() };
        markCommitted(game, pid, { kind: "CRYPTO_TIMEOUT" });
      }
    }
  }

  if(game.phase==="BIZ" && game.bizStep==="ML_BID") ensureMlRanking(game);
  if(game.phase==="BIZ" && game.bizStep==="AUCTION_ENVELOPE"){
    const entries = game.biz.auction.entries || {};
    const allCommitted = game.players.every(p=>entries[p.playerId]?.committed);
    const anyLobby = Object.values(entries).some(v=>v?.usedLobbyist);
    if(allCommitted && anyLobby) game.biz.auction.lobbyistPhaseActive = true;
    const finalReady = currentReadiness(game);
    if(finalReady.ready===finalReady.total) ensureAuctionRanking(game);
  }
  updateCountdown(game);
}

function finalizeMlResult(game){
  const players = getActivePlayerIds(game);
  const bids = players.map(pid => ({ playerId: pid, ...(game.biz.mlBids[pid]||{}) })).filter(x => x.committed && Number.isFinite(x.amountUsd));
  if(!players.length || bids.length!==players.length) return null;
  bids.sort((a,b)=> (Number(b.amountUsd||0)-Number(a.amountUsd||0)) || (Number(a.ts||0)-Number(b.ts||0)));
  const win = bids[0];
  game.biz.mlResult = { winnerPlayerId: win.playerId, amountUsd: Number(win.amountUsd||0), ts: Number(win.ts||0) };
  return game.biz.mlResult;
}

function effectiveAuctionBid(entry){
  if(!entry) return null;
  if(entry.usedLobbyist && entry.finalCommitted) return entry.finalBidUsd==null ? null : Number(entry.finalBidUsd);
  if(entry.usedLobbyist) return null;
  return entry.bidUsd==null ? null : Number(entry.bidUsd);
}

function finalizeAuctionResult(game){
  const players = getActivePlayerIds(game);
  const entries = game.biz?.auction?.entries || {};
  const allCommitted = players.every(pid => entries[pid]?.committed);
  if(!allCommitted) return null;
  const needFinal = players.filter(pid => entries[pid]?.usedLobbyist);
  const allFinal = needFinal.every(pid => entries[pid]?.finalCommitted);
  if(needFinal.length && !allFinal) return null;
  const bids = players.map(pid=>{
    const entry = entries[pid]||{};
    const amountUsd = effectiveAuctionBid(entry);
    return { playerId: pid, amountUsd, ts: Number(entry.ts||0), usedLobbyist: !!entry.usedLobbyist };
  }).filter(x => Number.isFinite(x.amountUsd));
  if(!bids.length){
    game.biz.auction.result = { winnerPlayerId: null, amountUsd: null, reason: "NO_BID" };
    return game.biz.auction.result;
  }
  bids.sort((a,b)=> (Number(b.amountUsd||0)-Number(a.amountUsd||0)) || (Number(a.ts||0)-Number(b.ts||0)));
  const win = bids[0];
  game.biz.auction.result = { winnerPlayerId: win.playerId, amountUsd: Number(win.amountUsd||0), ts: Number(win.ts||0) };
  return game.biz.auction.result;
}

function gamePublic(game, viewerPlayerId){
  const myInventory = game.inventory?.[viewerPlayerId] || blankInventory();
  const myReveals = game.reveals?.[viewerPlayerId] || { globalYearsRevealed: [], cryptoYearsRevealed: [] };
  const myLawyer = {
    protections: viewerPlayerId ? { [viewerPlayerId]: game.lawyer?.protections?.[viewerPlayerId] || {} } : {},
    notices: viewerPlayerId ? { [viewerPlayerId]: game.lawyer?.notices?.[viewerPlayerId] || [] } : {},
    auditShield: viewerPlayerId ? { [viewerPlayerId]: game.lawyer?.auditShield?.[viewerPlayerId] || {} } : {},
  };
  const settleEntries = {};
  for(const p of (game.players||[])){
    const entry = game.settle?.entries?.[p.playerId];
    if(!entry) continue;
    if(p.playerId===viewerPlayerId){
      settleEntries[p.playerId] = entry;
    } else {
      settleEntries[p.playerId] = { committed: !!entry.committed, settlementUsd: Number(entry.settlementUsd||0), ts: entry.ts || null };
    }
  }
  const auctionEntries = {};
  for(const p of (game.players||[])){
    const entry = game.biz?.auction?.entries?.[p.playerId];
    if(!entry) continue;
    const canSeeRoundOne = game.biz?.auction?.lobbyistPhaseActive;
    if(p.playerId===viewerPlayerId || canSeeRoundOne){
      auctionEntries[p.playerId] = entry;
    } else {
      auctionEntries[p.playerId] = { committed: !!entry.committed, usedLobbyist: !!entry.usedLobbyist, finalCommitted: !!entry.finalCommitted, ts: entry.ts || null };
    }
  }
  return {
    gameId: game.gameId,
    status: game.status,
    config: game.config,
    year: game.year,
    phase: game.phase,
    bizStep: game.bizStep,
    players: game.players.map(p=>({
      playerId:p.playerId, name:p.name, role:p.role, seatIndex:p.seatIndex, connected: !!p.connected, marketId:p.marketId,
      wallet: p.playerId===viewerPlayerId ? p.wallet : undefined
    })),
    trends: game.trends,
    reveals: viewerPlayerId ? { [viewerPlayerId]: myReveals } : {},
    lawyer: myLawyer,
    inventory: viewerPlayerId ? { [viewerPlayerId]: myInventory } : {},
    available: {
      investments: Array.from(game.availableCards.investments),
      miningFarms: Array.from(game.availableCards.miningFarms),
      experts: Array.from(game.availableCards.experts),
    },
    catalog: {
      markets: CATALOG.markets,
    },
    biz: {
      ...game.biz,
      mlBids: viewerPlayerId && game.biz.mlBids?.[viewerPlayerId] ? { [viewerPlayerId]: game.biz.mlBids[viewerPlayerId] } : {},
      auction: { ...(game.biz.auction||{}), entries: auctionEntries },
    },
    crypto: {
      ...game.crypto,
      entries: viewerPlayerId && game.crypto.entries?.[viewerPlayerId] ? { [viewerPlayerId]: game.crypto.entries[viewerPlayerId] } : {},
    },
    settle: { ...game.settle, entries: settleEntries },
    meta: { currentPhaseKey: currentPhaseKey(game), readiness: currentReadiness(game), presence: currentPresence(game), countdown: countdownPublic(game) }
  };
}

function broadcast(game){
  const room = io.sockets.adapter.rooms.get(`game:${game.gameId}`);
  if(!room){ return; }
  for(const socketId of room){
    const viewerPlayerId = resolveSocketPlayerId(socketBindings, socketId, game.gameId);
    io.to(socketId).emit("game_state", gamePublic(game, viewerPlayerId));
  }
}

function ackOk(cb, payload){ if(typeof cb==="function") cb({ ok:true, ...(payload||{}) }); }
function ackErr(cb, error, code){ if(typeof cb==="function") cb({ ok:false, error, code }); }

function getGame(gameId){
  const g = games.get(gameId);
  return g || null;
}
function getPlayer(game, playerId){
  return game.players.find(p=>p.playerId===playerId) || null;
}
function isGM(game, playerId){
  const p = getPlayer(game, playerId);
  return p && p.role==="GM";
}

function resolveActorPlayerId(socket, game, payloadPlayerId){
  const bound = resolveSocketPlayerId(socketBindings, socket.id, game?.gameId);
  if(bound && getPlayer(game, bound)) return bound;
  if(payloadPlayerId && getPlayer(game, payloadPlayerId) && game.status==="LOBBY") return payloadPlayerId;
  return null;
}

function bindPresence(socket, game, playerId){
  const p = getPlayer(game, playerId);
  if(!p) return null;
  p.connected = true;
  bindSocketToPlayer(socketBindings, socket.id, game.gameId, p.playerId);
  return p;
}

function currentYearCrypto(game){
  const y = game.year || 1;
  return (game.trends?.byYear?.[String(y)]?.crypto) || null;
}

function currentYearGlobals(game){
  const y = game.year || 1;
  return (game.trends?.byYear?.[String(y)]?.globals) || [];
}

function ensureLawyerStore(game, playerId){
  if(!game.lawyer) game.lawyer = { protections:{}, notices:{} };
  if(!game.lawyer.protections[playerId]) game.lawyer.protections[playerId] = {};
  if(!game.lawyer.protections[playerId][String(game.year||1)]) game.lawyer.protections[playerId][String(game.year||1)] = {};
  if(!game.lawyer.notices[playerId]) game.lawyer.notices[playerId] = [];
}

function isProtectedFrom(game, playerId, trendKey){
  const y = String(game.year||1);
  return !!game.lawyer?.protections?.[playerId]?.[y]?.[trendKey];
}

function addNotice(game, playerId, trendKey, message){
  ensureLawyerStore(game, playerId);
  game.lawyer.notices[playerId].push({ year: game.year||1, trendKey, message, ts: now() });
}

function canUseLawyerNow(game, trend){
  const phase = game.phase;
  const biz = game.bizStep;
  const req = trend?.lawyer?.phase;
  if(!trend?.lawyer?.allowed) return false;
  // "TRENDS" step was removed; treat it as the start-of-year window during Market Leader.
  if(req==="BIZ_TRENDS_ONLY") return phase==="BIZ" && biz==="ML_BID";
  if(req==="BIZ_MOVE_ONLY") return phase==="BIZ" && biz==="MOVE";
  if(req==="AUDIT_ANYTIME_BEFORE_CLOSE") return phase==="SETTLE";
  return false;
}

function applyTrendTriggers_OnTrendsToML(game){
  const globals = currentYearGlobals(game);
  const cryptoTrend = currentYearCrypto(game);
  const has = (k)=> globals.some(t=>t.key===k);

  // Apply crypto trend coefficients to exchange rates at the moment new trends activate for the year
  if(cryptoTrend && cryptoTrend.coeff){
    for(const sym of ["BTC","ETH","LTC","SIA"]){
      const coef = Number(cryptoTrend.coeff[sym] ?? 1);
      const prev = Number(game.crypto?.rates?.[sym] ?? 1);
      const next = Math.max(1, prev * coef);
      game.crypto.rates[sym] = next;
    }
  }

  // For each player apply in this exact order:
  // 1) Exchange hack (halve all) – negative, lawyer can protect
  // 2) Forks – positive
  // 3) Hyperinflation – not applied by app, only notice if protected
  for(const p of game.players){
    const pid = p.playerId;

    if(has("EXCHANGE_HACK") && !isProtectedFrom(game, pid, "EXCHANGE_HACK")){
      for(const sym of ["BTC","ETH","LTC","SIA"]){
        const v = Math.floor(Number(p.wallet?.crypto?.[sym]||0) / 2);
        p.wallet.crypto[sym] = v;
      }
    } else if(has("EXCHANGE_HACK") && isProtectedFrom(game, pid, "EXCHANGE_HACK")){
      addNotice(game, pid, "EXCHANGE_HACK", "Ochráněno právníkem před hackerským útokem na kryptoburzu (krypto zůstatky se nesnížily).");
    }

    if(has("FORK_BTC_ETH")){
      p.wallet.crypto.BTC = Number(p.wallet.crypto.BTC||0) * 2;
      p.wallet.crypto.ETH = Number(p.wallet.crypto.ETH||0) * 2;
    }
    if(has("FORK_LTC_SIA")){
      p.wallet.crypto.LTC = Number(p.wallet.crypto.LTC||0) * 2;
      p.wallet.crypto.SIA = Number(p.wallet.crypto.SIA||0) * 2;
    }

    if(has("HYPERINFLATION_USD_HALVE") && isProtectedFrom(game, pid, "HYPERINFLATION_USD_HALVE")){
      addNotice(game, pid, "HYPERINFLATION_USD_HALVE", "Ochráněno právníkem před Hyperinflací (tento hráč si NEodečítá 1/2 USD).");
    }
  }
}

function resetStepData(game){
  game.biz.mlBids = {};
  game.biz.mlResult = null;
  game.biz.mlRankingVisible = false;
  game.biz.mlRanking = [];
  game.biz.move = {};
  game.biz.auction = { entries:{}, lobbyistPhaseActive:false, result:null, rankingVisible:false, ranking:[] };
  game.biz.acquire = { entries:{} };
  game.settle.effects = [];
  game.settle.entries = {};
  game.crypto.entries = {};
  // market locks persist within year, but we rebuild for move step
  game.biz.marketLocks = Object.fromEntries(CATALOG.markets.map(m=>[m.marketId, null]));
}

function rebuildMarketLocksFromPositions(game){
  // Start from empty lock map, then lock current player positions.
  game.biz.marketLocks = Object.fromEntries(CATALOG.markets.map(m=>[m.marketId, null]));
  for(const p of game.players){
    const mid = p.marketId;
    if(mid && (mid in game.biz.marketLocks)){
      game.biz.marketLocks[mid] = p.playerId;
    }
  }
}

function startNewYear(game){
  resetCurrentPhaseActions(game);
  stopCountdown(game);
  game.year += 1;
  game.phase = "BIZ";
  // Trends are activated automatically at year start; players view them in ML intro modal.
  game.bizStep = "ML_BID";
  resetStepData(game);
  rebuildMarketLocksFromPositions(game);

  // Apply trend triggers at the moment the year starts (previously happened in the removed "TRENDS" step)
  applyTrendTriggers_OnTrendsToML(game);

  // initialize per-player step objects
  for(const p of game.players){
    if(!game.reveals[p.playerId]) game.reveals[p.playerId] = { globalYearsRevealed: [], cryptoYearsRevealed: [] };
    if(!game.inventory[p.playerId]) game.inventory[p.playerId] = blankInventory();
  }
}

function calcSettlementFor(game, playerId){
  // Deterministic settlement (test):
  // - base USD from investments (may be modified by global trends at AUDIT)
  // - electricity costs from mining farms (may be modified by global trends)
  // - expert effects (steal base production)

  const inv = game.inventory[playerId] || blankInventory();

  const y = game.year || 1;
  const globals = (game.trends?.byYear?.[String(y)]?.globals) || [];

  const protectedMap = (game.lawyer?.protections?.[playerId]?.[String(y)]) || {};
  const protectedSet = new Set(Object.keys(protectedMap));
  const hasTrend = (key)=> globals.some(t=>t.key===key);
  const isProtected = (key)=> protectedSet.has(key);

  // Base production
  let base = inv.investments.reduce((s,c)=>s + Number(c.usdProduction||0), 0);

  // Global trend modifiers for AUDIT (only if trend applies and player not protected)
  if(hasTrend("ECONOMIC_CRISIS_NO_TRAD_BASE") && !isProtected("ECONOMIC_CRISIS_NO_TRAD_BASE")) base = 0;
  if(hasTrend("TRAD_INV_DOUBLE_USD")) base = base * 2; // positive trend (no lawyer)

  // Electricity costs
  let electricity = inv.miningFarms.reduce((s,c)=>s + Number(c.electricityUSD||0), 0);
  if(hasTrend("EXPENSIVE_ELECTRICITY") && !isProtected("EXPENSIVE_ELECTRICITY")) electricity = electricity * 2;

  // Build breakdown
  const breakdown = [];
  breakdown.push({ label:"Základní produkce (investice)", usd: base });
  if(electricity){ breakdown.push({ label:"Elektřina (mining)", usd: -electricity }); }

  // Expert effects (steal base prod)
  let effectsDelta = 0;
  const lobbyistImpacts = [];
  for(const e of (game.settle.effects||[])){
    if(e.type==="STEAL_BASE_PRODUCTION"){
      if(e.toPlayerId===playerId){
        effectsDelta += e.usd;
        breakdown.push({ label:`Krádež produkce (${e.cardId})`, usd: +e.usd });
      }
      if(e.fromPlayerId===playerId){
        effectsDelta -= e.usd;
        breakdown.push({ label:`Ztráta produkce (${e.cardId})`, usd: -e.usd });
      }
    }

    // Audit lobbyist effects (V33): sabotage/steal
    if(e.type==="AUDIT_LOBBYIST_STEAL"){
      if(e.toPlayerId===playerId){
        effectsDelta += e.usd;
        breakdown.push({ label:`Lobbista – zloděj (+)`, usd: +e.usd });
      }
      if(e.fromPlayerId===playerId){
        effectsDelta -= e.usd;
        lobbyistImpacts.push({ usd: -e.usd, label:`Lobbista – zloděj (−)` });
      }
    }
    if(e.type==="AUDIT_LOBBYIST_SABOTAGE"){
      if(e.targetPlayerId===playerId){
        lobbyistImpacts.push({ usd: -Math.abs(Number(e.usd||0)), label:`Lobbista – sabotér (−)` });
        effectsDelta -= Math.abs(Number(e.usd||0));
      }
    }
  }

  // Single-use shield (LAWYER) against the biggest lobbyist impact in this audit.
  const shieldActive = !!(game.lawyer?.auditShield?.[playerId]?.[String(y)]);
  if(shieldActive && lobbyistImpacts.length){
    let worst = lobbyistImpacts[0];
    for(const x of lobbyistImpacts){
      if(Number(x.usd) < Number(worst.usd)) worst = x;
    }
    const refund = Math.abs(Number(worst.usd||0));
    if(refund>0){
      effectsDelta += refund;
      breakdown.push({ label:`Právník – štít (+)`, usd: +refund });
    }
  }

  const settlementUsd = base - electricity + effectsDelta;
  return { settlementUsd, breakdown };
}

function roundDownToHundreds(n){
  const x = Math.floor(Number(n||0));
  if(!Number.isFinite(x)) return 0;
  if(x < 100) return 0;
  return Math.floor(x / 100) * 100;
}

function sumTradBase(inv){
  return (inv?.investments||[]).reduce((s,c)=>s + Number(c.usdProduction||0), 0);
}

function maxTradBase(inv){
  let m = 0;
  for(const c of (inv?.investments||[])){
    const v = Number(c.usdProduction||0);
    if(v > m) m = v;
  }
  return m;
}


function canBack(game){
  // Guard: can back only if current step has no commits (for its relevant step)
  if(game.status!=="IN_PROGRESS") return false;

  if(game.phase==="BIZ"){
    if(game.bizStep==="ML_BID"){
      return !Object.values(game.biz.mlBids).some(v=>v?.committed);
    }
    if(game.bizStep==="MOVE"){
      return !Object.values(game.biz.move).some(v=>v?.committed);
    }
    if(game.bizStep==="AUCTION_ENVELOPE"){
      return !Object.values(game.biz.auction.entries).some(v=>v?.committed || v?.finalCommitted);
    }
    if(game.bizStep==="ACQUIRE"){
      return !Object.values(game.biz.acquire.entries).some(v=>v?.committed);
    }
  }
  if(game.phase==="CRYPTO"){
    return !Object.values(game.crypto.entries).some(v=>v?.committed);
  }
  if(game.phase==="SETTLE"){
    return !Object.values(game.settle.entries).some(v=>v?.committed);
  }
  return false;
}

function gmNext(game){
  resetCurrentPhaseActions(game);
  if(game.phase==="BIZ"){
    if(game.bizStep==="ML_BID"){
      game.bizStep="MOVE";
      rebuildMarketLocksFromPositions(game);
      return;
    }
    if(game.bizStep==="MOVE"){ game.bizStep="AUCTION_ENVELOPE"; return; }
    if(game.bizStep==="AUCTION_ENVELOPE"){ finalizeAuctionResult(game); game.biz.auction.lobbyistPhaseActive = false; game.bizStep="ACQUIRE"; return; }
    if(game.bizStep==="ACQUIRE"){ game.phase="CRYPTO"; game.bizStep=null; return; }
  } else if(game.phase==="CRYPTO"){
    game.phase="SETTLE"; return;
  } else if(game.phase==="SETTLE"){
    // End of year; monopoly check occurs here at start of new year (per rules) – we expose hook.
    if(game.year >= game.config.yearsTotal){
      game.status="GAME_OVER";
      game.phase=null; game.bizStep=null;
      return;
    }
    startNewYear(game);
    return;
  }
}

function gmBack(game){
  resetCurrentPhaseActions(game);
  if(game.phase==="BIZ"){
    if(game.bizStep==="MOVE"){ game.bizStep="ML_BID"; return; }
    if(game.bizStep==="AUCTION_ENVELOPE"){ game.bizStep="MOVE"; rebuildMarketLocksFromPositions(game); return; }
    if(game.bizStep==="ACQUIRE"){ game.biz.auction.lobbyistPhaseActive = false; game.bizStep="AUCTION_ENVELOPE"; return; }
  } else if(game.phase==="CRYPTO"){
    game.phase="BIZ"; game.bizStep="ACQUIRE"; return;
  } else if(game.phase==="SETTLE"){
    game.phase="CRYPTO"; return;
  }
}



module.exports = {
  COUNTDOWN_DURATION_MS, COUNTDOWN_TICK_MS, CATALOG, games,
  now, shortId, clampPlayers, clampYears, shuffle, pickRandom, generateTrends, makePlayer, blankInventory, normName, isNameTaken, nextFreeSeatIndex, newGame,
  getActivePlayerIds, timedPhaseKey, currentReadiness, currentPresence, ensureCountdownStore, stopCountdown, startCountdown, countdownPublic, updateCountdown, ensureMlRanking, ensureAuctionRanking, autoCommitTimedOutPlayers,
  finalizeMlResult, effectiveAuctionBid, finalizeAuctionResult, gamePublic, broadcast, ackOk, ackErr, getGame, getPlayer, isGM, resolveActorPlayerId, bindPresence, currentYearCrypto, currentYearGlobals, ensureLawyerStore, isProtectedFrom, addNotice,
  canUseLawyerNow, applyTrendTriggers_OnTrendsToML, resetStepData, rebuildMarketLocksFromPositions, startNewYear, calcSettlementFor, roundDownToHundreds, sumTradBase, maxTradBase, canBack, gmNext, gmBack,
  ensureActionRegistry, markCommitted, resetCurrentPhaseActions
};
