const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get("/", (req,res)=> res.status(200).send("Kryptopoly server OK"));
app.get("/health", (req,res)=> res.json({ ok:true, ts: Date.now() }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ["GET","POST"] } });

// Track socket -> player binding for presence
const socketBindings = new Map();

/**
 * Kryptopoly v3.2 (spec-aligned)
 * - GM is the only one who advances steps/phases/years.
 * - App does not decide winners for ML or Auction; it only collects bids and shows them.
 * - Server keeps the single source of truth for:
 *   - players, state (year/phase/bizStep), locks for movement, trends seed, inventories
 *   - committed flags + stored values, so clients can refresh and stay consistent
 */

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
  const types = ["AGRO","INDUSTRY","MINING","ENERGY","TECH","LOGISTICS"];
  const investments = Array.from({length:48}, (_,i)=>{
    const n=i+1;
    return {
      cardId:`TI${String(n).padStart(3,"0")}`,
      kind:"INVESTMENT",
      name:`Tradiční investice ${n}`,
      continent: continents[i % continents.length],
      market: markets12[i % markets12.length],
      type: types[i % types.length],
      usdProduction: 2 + (n % 7)
    };
  });
  // Mining farms (spec-aligned): production in units (ks) per year, electricity is USD cost per year.
  // MF001 BTC 3, MF002 ETH 6, MF003 LTC 12, MF004 SIA 24; electricity 12,000 USD each.
  const miningFarms = [
    { cardId:"MF001", kind:"MINING_FARM", name:"Mining farma BTC", crypto:"BTC", cryptoProduction:3, electricityUSD:12000 },
    { cardId:"MF002", kind:"MINING_FARM", name:"Mining farma ETH", crypto:"ETH", cryptoProduction:6, electricityUSD:12000 },
    { cardId:"MF003", kind:"MINING_FARM", name:"Mining farma LTC", crypto:"LTC", cryptoProduction:12, electricityUSD:12000 },
    { cardId:"MF004", kind:"MINING_FARM", name:"Mining farma SIA", crypto:"SIA", cryptoProduction:24, electricityUSD:12000 },
  ];
  const expertFuncs = [
    ["ANALYST","Analytik","Odhalí 3 globální trendy nejbližšího skrytého roku."],
    ["CRYPTOGURU","Kryptoguru","Odhalí kryptotrend nejbližšího skrytého roku."],
    ["LAWYER_TRENDS","Právník","Zruší negativní dopad globálních trendů (test verze)."],
    ["LOBBY_LASTCALL","Lobbista","V obálce uvidíš nabídky ostatních a dáš finální nabídku."],
    ["STEAL_BASE_PROD","Lobbista (krádež)","Přesune základní USD produkci vybrané investice (jen tento rok)."],
  ];
  const experts = Array.from({length:30}, (_,i)=>{
    const n=i+1;
    const f = expertFuncs[i % expertFuncs.length];
    return {
      cardId:`EX${String(n).padStart(3,"0")}`,
      kind:"EXPERT",
      name:`Expert ${f[1]} ${Math.floor(i/expertFuncs.length)+1}`,
      functionKey:f[0],
      functionLabel:f[1],
      functionDesc:f[2]
    };
  });

  
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


  const markets = [
    // Two markets per continent. No continent has two identical market types.
    // Types align with Bible traditional-investment types: AGRO (Zemědělství), INDUSTRY (Průmysl), MINING (Těžba).
    { marketId: "M01", label: "Trh", continent: "EUROPE", type: "AGRO" },
    { marketId: "M02", label: "Trh", continent: "ASIA", type: "INDUSTRY" },
    { marketId: "M03", label: "Trh", continent: "AFRICA", type: "MINING" },
    { marketId: "M04", label: "Trh", continent: "N_AMERICA", type: "INDUSTRY" },
    { marketId: "M05", label: "Trh", continent: "S_AMERICA", type: "AGRO" },
    { marketId: "M06", label: "Trh", continent: "OCEANIA", type: "AGRO" },

    { marketId: "M07", label: "Trh", continent: "EUROPE", type: "INDUSTRY" },
    { marketId: "M08", label: "Trh", continent: "ASIA", type: "MINING" },
    { marketId: "M09", label: "Trh", continent: "AFRICA", type: "AGRO" },
    { marketId: "M10", label: "Trh", continent: "N_AMERICA", type: "MINING" },
    { marketId: "M11", label: "Trh", continent: "S_AMERICA", type: "MINING" },
    { marketId: "M12", label: "Trh", continent: "OCEANIA", type: "INDUSTRY" },
  ];


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
    wallet: { usd: 0, crypto: { BTC:3, ETH:3, LTC:3, SIA:3 } }
  };
}

// Cards use "units" where 1 == 1,000 USD (confirmed by user)
const USD_UNIT = 1000;
const BONUS_BY_THRESHOLD = [
  { n: 6, usd: 50000 },
  { n: 4, usd: 25000 },
  { n: 2, usd: 10000 },
];

function bonusForCount(count){
  const c = Number(count||0);
  for(const t of BONUS_BY_THRESHOLD){
    if(c >= t.n) return t.usd;
  }
  return 0;
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
      move: {},        // pid -> { marketId:null|string, committed:boolean }
      marketLocks: {}, // marketId -> pid|null
      auction: {
        entries: {},        // pid -> { bidUsd:null|number, committed, usedLobbyist, finalBidUsd, finalCommitted }
        lobbyistPhaseActive: false,
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
      // New audit flow:
      // PREVIEW -> players choose secret actions -> STARTED (ready) -> FINAL -> PAID (amount-only lock)
      stage: "PREVIEW",
      entries: {},  // pid -> { started:boolean, finalUsd:number|null, finalBreakdown:Array|null, paid:boolean }
      pending: {},  // pid -> { lawyer:null|{mode,trendKey?}, lobby:[{type,targetPid}] }
      // NOTE: legacy "effects" removed; audit effects are derived from pending+inventories when all started.
    }
  };

  // init reveal state
  game.reveals[gm.playerId] = { globalYearsRevealed: [], cryptoYearsRevealed: [] };

  games.set(gameId, game);
  return { game, gm };
}

function gameView(game, viewerPlayerId){
  // Player-specific view to preserve secrecy (audit pending actions, intel, etc.)
  const pid = viewerPlayerId;
  const settleEntries = {};
  for(const p of game.players){
    const e = game.settle?.entries?.[p.playerId] || null;
    if(!e){ continue; }
    if(p.playerId===pid){
      settleEntries[p.playerId] = e;
    }else{
      settleEntries[p.playerId] = { started: !!e.started, paid: !!e.paid, finalUsd: null, finalBreakdown: null };
    }
  }
  const settlePending = pid ? (game.settle?.pending?.[pid] || { lawyer:null, lobby:[] }) : { lawyer:null, lobby:[] };

  return {
    gameId: game.gameId,
    status: game.status,
    config: game.config,
    year: game.year,
    phase: game.phase,
    bizStep: game.bizStep,
    players: game.players.map(p=>({ playerId:p.playerId, name:p.name, role:p.role, seatIndex:p.seatIndex, connected: !!p.connected, marketId:p.marketId, wallet:p.wallet })),
    trends: game.trends,
    reveals: game.reveals,
    lawyer: game.lawyer,
    inventory: game.inventory,
    available: {
      investments: Array.from(game.availableCards.investments),
      miningFarms: Array.from(game.availableCards.miningFarms),
      experts: Array.from(game.availableCards.experts),
    },
    catalog: {
      markets: CATALOG.markets,
    },
    biz: game.biz,
    crypto: game.crypto,
    settle: {
      stage: game.settle?.stage || "PREVIEW",
      entries: settleEntries,
      pending: { [pid]: settlePending }
    }
  };
}

function broadcast(game){
  // Send a player-specific game view to each connected socket
  for(const [sid, b] of socketBindings.entries()){
    if(b?.gameId!==game.gameId) continue;
    io.to(sid).emit("game_state", gameView(game, b.playerId));
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
  game.biz.move = {};
  game.biz.auction = { entries:{}, lobbyistPhaseActive:false };
  game.biz.acquire = { entries:{} };
  game.settle.stage = "PREVIEW";
  game.settle.entries = {};
  game.settle.pending = {};
  game.crypto.entries = {};
  // market locks persist within year, but we rebuild for move step
  game.biz.marketLocks = Object.fromEntries(CATALOG.markets.map(m=>[m.marketId, null]));
}

function startNewYear(game){
  game.year += 1;
  game.phase = "BIZ";
  // Trends are activated automatically at year start; players view them in ML intro modal.
  game.bizStep = "ML_BID";
  resetStepData(game);

  // Apply trend triggers at the moment the year starts (previously happened in the removed "TRENDS" step)
  applyTrendTriggers_OnTrendsToML(game);

  // initialize per-player step objects
  for(const p of game.players){
    if(!game.reveals[p.playerId]) game.reveals[p.playerId] = { globalYearsRevealed: [], cryptoYearsRevealed: [] };
    if(!game.inventory[p.playerId]) game.inventory[p.playerId] = blankInventory();
  }
}

function calcSettlementFor(game, playerId){
  // Backwards compatible wrapper used by some legacy UI paths.
  // Uses the new auditPreview logic and includes player's own BLOCK_TREND choice if already set.
  const pending = game.settle?.pending?.[playerId];
  const blockedTrendKey = (pending?.lawyer && pending.lawyer.mode==="BLOCK_TREND") ? pending.lawyer.trendKey : null;
  const { usd, breakdown } = (function(){
    // auditPreview is defined inside the socket handler scope; this wrapper should not be relied upon.
    // Keep minimal safe output.
    const inv = game.inventory[playerId] || blankInventory();
    const y = game.year || 1;
    const globals = (game.trends?.byYear?.[String(y)]?.globals) || [];
    const hasTrend = (k)=> globals.some(t=>t.key===k);
    const isBlocked = (k)=> blockedTrendKey && blockedTrendKey===k;

    const tradCards = inv.investments || [];
    const tradBase = tradCards.reduce((s,c)=> s + (Number(c.usdProduction||0) * USD_UNIT), 0);
    let regionBonus = 0;
    let globalBonus = 0;
    const antiMono = hasTrend("ANTIMONOPOLY_NO_BONUSES") && !isBlocked("ANTIMONOPOLY_NO_BONUSES");
    if(!antiMono){
      const byCont = {};
      const byType = {};
      for(const c of tradCards){
        byCont[c.continent||""] = (byCont[c.continent||""]||0) + 1;
        byType[c.type||""] = (byType[c.type||""]||0) + 1;
      }
      for(const n of Object.values(byCont)) regionBonus += bonusForCount(n);
      for(const n of Object.values(byType)) globalBonus += bonusForCount(n);
    }
    let tradBaseAdj = tradBase;
    if(hasTrend("ECONOMIC_CRISIS_NO_TRAD_BASE") && !isBlocked("ECONOMIC_CRISIS_NO_TRAD_BASE")) tradBaseAdj = 0;
    if(hasTrend("TRAD_INV_DOUBLE_USD")) tradBaseAdj = tradBaseAdj * 2;

    const farms = inv.miningFarms || [];
    const units = { BTC:0, ETH:0, LTC:0, SIA:0 };
    for(const f of farms){ if(units[f.crypto]!=null) units[f.crypto] += Number(f.cryptoProduction||0); }
    if(hasTrend("LOWER_DIFFICULTY")) for(const k of Object.keys(units)) units[k] *= 2;
    let miningValueUsd = 0;
    for(const k of Object.keys(units)) miningValueUsd += units[k] * Number(game.crypto?.rates?.[k]||0);
    let electricity = farms.reduce((s,f)=> s + Number(f.electricityUSD||0), 0);
    if(hasTrend("EXPENSIVE_ELECTRICITY") && !isBlocked("EXPENSIVE_ELECTRICITY")) electricity *= 2;

    const breakdown = [];
    breakdown.push({ label:"Tradiční investice – základ", usd: tradBaseAdj });
    if(regionBonus) breakdown.push({ label:"Regionální bonusy", usd: regionBonus });
    if(globalBonus) breakdown.push({ label:"Globální bonusy", usd: globalBonus });
    if(miningValueUsd) breakdown.push({ label:"Mining – hodnota produkce", usd: miningValueUsd });
    if(electricity) breakdown.push({ label:"Elektřina (mining)", usd: -electricity });
    return { usd: tradBaseAdj + regionBonus + globalBonus + miningValueUsd - electricity, breakdown };
  })();
  return { settlementUsd: usd, breakdown };
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
    return !Object.values(game.settle.entries).some(v=>v?.started || v?.paid);
  }
  return false;
}

function gmNext(game){
  if(game.phase==="BIZ"){
    if(game.bizStep==="ML_BID"){ game.bizStep="MOVE"; return; }
    if(game.bizStep==="MOVE"){ game.bizStep="AUCTION_ENVELOPE"; return; }
    if(game.bizStep==="AUCTION_ENVELOPE"){ game.biz.auction.lobbyistPhaseActive = false; game.bizStep="ACQUIRE"; return; }
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
  if(game.phase==="BIZ"){
    if(game.bizStep==="MOVE"){ game.bizStep="ML_BID"; return; }
    if(game.bizStep==="AUCTION_ENVELOPE"){ game.bizStep="MOVE"; return; }
    if(game.bizStep==="ACQUIRE"){ game.biz.auction.lobbyistPhaseActive = false; game.bizStep="AUCTION_ENVELOPE"; return; }
  } else if(game.phase==="CRYPTO"){
    game.phase="BIZ"; game.bizStep="ACQUIRE"; return;
  } else if(game.phase==="SETTLE"){
    game.phase="CRYPTO"; return;
  }
}

/* Socket handlers */
io.on("connection", (socket) => {
  socket.on("create_game", (payload, cb) => {
    try{
      const { name, yearsTotal, maxPlayers } = payload || {};
      const { game, gm } = newGame({ gmName:name, yearsTotal, maxPlayers });
      gm.connected = true;
      socketBindings.set(socket.id, { gameId: game.gameId, playerId: gm.playerId });
      socket.join(`game:${game.gameId}`);
      ackOk(cb, { gameId: game.gameId, playerId: gm.playerId, role: gm.role });
      io.to(socket.id).emit("created_game", { gameId: game.gameId, playerId: gm.playerId });
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
    socketBindings.set(socket.id, { gameId: game.gameId, playerId: p.playerId });
    socket.join(`game:${game.gameId}`);

    ackOk(cb, { playerId: p.playerId, seatIndex: p.seatIndex });
    broadcast(game);
  });

  socket.on("reconnect_game", (payload, cb) => {
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Hra nenalezena", "NOT_FOUND");
    const p = (game.players||[]).find(x => x.playerId===playerId);
    if(!p) return ackErr(cb, "Profil v této hře nenalezen", "NO_PLAYER");

    p.connected = true;
    socketBindings.set(socket.id, { gameId: game.gameId, playerId: p.playerId });
    socket.join(`game:${game.gameId}`);

    ackOk(cb, {
      gameId: game.gameId,
      gameStatus: game.status,
      playerId: p.playerId,
      role: p.role,
      seatIndex: p.seatIndex
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
      if(p){ p.connected = true; socketBindings.set(socket.id, { gameId: game.gameId, playerId: p.playerId }); }
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
    io.to(socket.id).emit("game_state", gameView(game, playerId));
  });

  socket.on("watch_game", (payload, cb) => {
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");

    if(playerId){
      const p = (game.players||[]).find(x=>x.playerId===playerId);
      if(p){ p.connected = true; socketBindings.set(socket.id, { gameId: game.gameId, playerId: p.playerId }); }
    }

    socket.join(`game:${gameId}`);
    ackOk(cb);
    io.to(socket.id).emit("game_state", gameView(game, playerId));
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
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(!isGM(game, playerId)) return ackErr(cb, "Only GM", "FORBIDDEN");
    gmNext(game);
    ackOk(cb);
    broadcast(game);
  });

  socket.on("gm_back", (payload, cb) => {
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
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
    const { gameId, playerId, trendKey } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
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
    const { gameId, playerId, amountUsd } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.phase!=="BIZ" || game.bizStep!=="ML_BID") return ackErr(cb, "Not ML step", "BAD_STATE");

    let val = amountUsd;
    if(val===null) val=null;
    else {
      val = Number(val);
      if(!Number.isFinite(val) || val<0) return ackErr(cb, "Invalid amount", "BAD_INPUT");
      val = Math.floor(val);
    }
    game.biz.mlBids[playerId] = { amountUsd: val, committed:true, ts: now() };
    ackOk(cb);
    broadcast(game);
  });

  // Move selection (locks markets)
  socket.on("pick_market", (payload, cb) => {
    const { gameId, playerId, marketId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
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

    ackOk(cb);
    broadcast(game);
  });

  // Auction (envelope) bid
  socket.on("commit_auction_bid", (payload, cb) => {
    const { gameId, playerId, bidUsd, usedLobbyist } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.phase!=="BIZ" || game.bizStep!=="AUCTION_ENVELOPE") return ackErr(cb, "Not AUCTION step", "BAD_STATE");

    let val = bidUsd;
    if(val===null) val=null;
    else {
      val = Number(val);
      if(!Number.isFinite(val) || val<0) return ackErr(cb, "Invalid bid", "BAD_INPUT");
      val = Math.floor(val);
    }
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

    ackOk(cb);
    broadcast(game);
  });

  socket.on("gm_open_lobbyist_window", (payload, cb) => {
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
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
    const { gameId, playerId, finalBidUsd } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
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
    ackOk(cb);
    broadcast(game);
  });

  // Acquisition commit (definitive decision for this step)
  socket.on("commit_acquire", (payload, cb) => {
    const { gameId, playerId, gotCard } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.phase!=="BIZ" || game.bizStep!=="ACQUIRE") return ackErr(cb, "Not ACQUIRE step", "BAD_STATE");

    game.biz.acquire.entries[playerId] = { committed:true, gotCard: !!gotCard, ts: now() };
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
    const { gameId, playerId, deltas } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
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
    ackOk(cb, { deltaUsd });
    broadcast(game);
  });

  // =========================
  // AUDIT (SETTLE) – secret pending actions + start + final + pay
  // =========================

  function ensureSettlePlayer(game, pid){
    if(!game.settle.entries[pid]) game.settle.entries[pid] = { started:false, finalUsd:null, finalBreakdown:null, paid:false };
    if(!game.settle.pending[pid]) game.settle.pending[pid] = { lawyer:null, lobby:[] };
  }

  function countAvailableExperts(inv, functionKey){
    return (inv?.experts||[]).filter(e=>e.functionKey===functionKey && !e.used).length;
  }

  function auditPreview(game, pid, opts){
    const inv = game.inventory[pid] || blankInventory();
    const y = game.year || 1;
    const globals = (game.trends?.byYear?.[String(y)]?.globals) || [];
    const hasTrend = (key)=> globals.some(t=>t.key===key);

    const blockedTrendKey = opts?.blockedTrendKey || null;
    const isBlocked = (key)=> blockedTrendKey && key===blockedTrendKey;

    // Traditional base (cards are units == 1,000 USD)
    const tradCards = inv.investments || [];
    const tradBase = tradCards.reduce((s,c)=> s + (Number(c.usdProduction||0) * USD_UNIT), 0);

    // Bonuses (region + global) unless antimonopoly (can be blocked by lawyer)
    let regionBonus = 0;
    let globalBonus = 0;
    const antiMono = hasTrend("ANTIMONOPOLY_NO_BONUSES") && !isBlocked("ANTIMONOPOLY_NO_BONUSES");
    if(!antiMono){
      const byCont = {};
      const byType = {};
      for(const c of tradCards){
        const cont = c.continent || "";
        const typ = c.type || "";
        byCont[cont] = (byCont[cont]||0) + 1;
        byType[typ] = (byType[typ]||0) + 1;
      }
      for(const n of Object.values(byCont)) regionBonus += bonusForCount(n);
      for(const n of Object.values(byType)) globalBonus += bonusForCount(n);
    }

    // Trend modifiers to traditional base (base only)
    let tradBaseAdj = tradBase;
    if(hasTrend("ECONOMIC_CRISIS_NO_TRAD_BASE") && !isBlocked("ECONOMIC_CRISIS_NO_TRAD_BASE")) tradBaseAdj = 0;
    if(hasTrend("TRAD_INV_DOUBLE_USD")) tradBaseAdj = tradBaseAdj * 2;

    // Mining production value (per farms) – uses current rates already modified by crypto trend
    const farms = inv.miningFarms || [];
    const miningUnits = { BTC:0, ETH:0, LTC:0, SIA:0 };
    for(const f of farms){
      const sym = f.crypto;
      if(miningUnits[sym]==null) continue;
      miningUnits[sym] += Number(f.cryptoProduction||0);
    }
    if(hasTrend("LOWER_DIFFICULTY")){
      for(const sym of Object.keys(miningUnits)) miningUnits[sym] = miningUnits[sym] * 2;
    }
    let miningValueUsd = 0;
    for(const sym of Object.keys(miningUnits)){
      const rate = Number(game.crypto?.rates?.[sym]||0);
      miningValueUsd += miningUnits[sym] * rate;
    }

    // Electricity costs (per farms)
    let electricity = farms.reduce((s,f)=> s + Number(f.electricityUSD||0), 0);
    if(hasTrend("EXPENSIVE_ELECTRICITY") && !isBlocked("EXPENSIVE_ELECTRICITY")) electricity = electricity * 2;

    const breakdown = [];
    breakdown.push({ label:"Tradiční investice – základ", usd: tradBaseAdj });
    if(regionBonus) breakdown.push({ label:"Regionální bonusy", usd: regionBonus });
    if(globalBonus) breakdown.push({ label:"Globální bonusy", usd: globalBonus });
    if(miningValueUsd) breakdown.push({ label:"Mining – hodnota produkce", usd: miningValueUsd });
    if(electricity) breakdown.push({ label:"Elektřina (mining)", usd: -electricity });
    if(antiMono) breakdown.push({ label:"Trend: Antimonopolní úřad (bonusy 0)", usd: 0 });
    if(hasTrend("ECONOMIC_CRISIS_NO_TRAD_BASE") && !isBlocked("ECONOMIC_CRISIS_NO_TRAD_BASE")) breakdown.push({ label:"Trend: Hospodářská krize (základ 0)", usd: 0 });
    if(hasTrend("TRAD_INV_DOUBLE_USD")) breakdown.push({ label:"Trend: Mimořádné zisky (základ ×2)", usd: 0 });
    if(hasTrend("LOWER_DIFFICULTY")) breakdown.push({ label:"Trend: Nižší difficulty (mining ×2)", usd: 0 });
    if(hasTrend("EXPENSIVE_ELECTRICITY") && !isBlocked("EXPENSIVE_ELECTRICITY")) breakdown.push({ label:"Trend: Drahá elektřina (×2)", usd: 0 });
    if(blockedTrendKey) breakdown.push({ label:"Právník: blokuje trend", usd: 0, meta:{ trendKey: blockedTrendKey } });

    const usd = tradBaseAdj + regionBonus + globalBonus + miningValueUsd - electricity;
    // max base card (for STEAL damage), unmodified by trends/bonuses
    const maxTradBaseCardUsd = tradCards.reduce((m,c)=> Math.max(m, Number(c.usdProduction||0) * USD_UNIT), 0);
    return { usd, breakdown, maxTradBaseCardUsd };
  }

  function computeAuditFinalForAll(game){
    const pids = game.players.map(p=>p.playerId);
    const base = {};
    for(const pid of pids){
      ensureSettlePlayer(game, pid);
      const pending = game.settle.pending[pid] || { lawyer:null, lobby:[] };
      const blockedTrendKey = (pending.lawyer && pending.lawyer.mode==="BLOCK_TREND") ? pending.lawyer.trendKey : null;
      base[pid] = auditPreview(game, pid, { blockedTrendKey });
    }

    // Collect all lobby attacks
    const attacksByTarget = {};
    for(const fromPid of pids){
      const pend = game.settle.pending[fromPid];
      for(const a of (pend?.lobby||[])){
        if(!a?.targetPid || !a?.type) continue;
        const t = a.targetPid;
        if(!attacksByTarget[t]) attacksByTarget[t] = [];
        attacksByTarget[t].push({ fromPid, type:a.type });
      }
    }

    // Determine lawyer shield blocks (one biggest harm)
    const blockedAttack = {}; // targetPid -> index of blocked attack in attacksByTarget[target]
    for(const targetPid of pids){
      const pend = game.settle.pending[targetPid];
      if(!(pend?.lawyer && pend.lawyer.mode==="SHIELD_LOBBY")) continue;
      const list = attacksByTarget[targetPid] || [];
      if(!list.length) continue;
      const baseUsd = Number(base[targetPid].usd||0);
      let bestIdx = -1;
      let bestDmg = -1;
      for(let i=0;i<list.length;i++){
        const at = list[i];
        let dmg = 0;
        if(at.type==="STEAL") dmg = Number(base[targetPid].maxTradBaseCardUsd||0);
        else if(at.type==="SABOTAGE") dmg = Math.abs(baseUsd - Math.floor(baseUsd*0.5));
        if(dmg > bestDmg){ bestDmg = dmg; bestIdx = i; }
      }
      if(bestIdx>=0) blockedAttack[targetPid] = bestIdx;
    }

    // Start from base results
    const finalUsd = Object.fromEntries(pids.map(pid=>[pid, Number(base[pid].usd||0)]));
    const breakdown = Object.fromEntries(pids.map(pid=>[pid, [...(base[pid].breakdown||[])] ]));

    // Apply STEAL then SABOTAGE (skip blocked)
    for(const targetPid of pids){
      const list = attacksByTarget[targetPid] || [];
      for(let i=0;i<list.length;i++){
        const at = list[i];
        if(blockedAttack[targetPid]===i){
          breakdown[targetPid].push({ label:`Právník: zablokoval lobbistu (${at.type==="STEAL"?"krádež":"sabotáž"})`, usd: 0 });
          continue;
        }
        if(at.type!=="STEAL") continue;
        const x = Number(base[targetPid].maxTradBaseCardUsd||0);
        if(x<=0) continue;
        finalUsd[targetPid] -= x;
        finalUsd[at.fromPid] += x;
        breakdown[targetPid].push({ label:`Lobbista (krádež)`, usd: -x, meta:{ from: at.fromPid } });
        breakdown[at.fromPid].push({ label:`Lobbista (krádež)`, usd: +x, meta:{ target: targetPid } });
      }
    }

    for(const targetPid of pids){
      const list = attacksByTarget[targetPid] || [];
      for(let i=0;i<list.length;i++){
        const at = list[i];
        if(blockedAttack[targetPid]===i) continue;
        if(at.type!=="SABOTAGE") continue;
        const before = finalUsd[targetPid];
        const after = Math.floor(before * 0.5);
        finalUsd[targetPid] = after;
        breakdown[targetPid].push({ label:`Lobbista (sabotáž −50 %)`, usd: after-before, meta:{ from: at.fromPid } });
      }
    }

    // Store per player
    for(const pid of pids){
      ensureSettlePlayer(game, pid);
      game.settle.entries[pid].finalUsd = finalUsd[pid];
      game.settle.entries[pid].finalBreakdown = breakdown[pid];
    }
    game.settle.stage = "FINAL";
  }

  // Legacy event: expert effects are now handled via pending actions.
  socket.on("apply_expert_effect", (payload, cb) => {
    return ackErr(cb, "Expert akce jsou nově v Auditu tajné a nastavují se v Předběžném auditu.", "LEGACY");
  });

  socket.on("audit_set_pending_lawyer", (payload, cb) => {
    const { gameId, playerId, lawyer } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.phase!=="SETTLE") return ackErr(cb, "Not SETTLE phase", "BAD_STATE");
    ensureSettlePlayer(game, playerId);
    const entry = game.settle.entries[playerId];
    if(entry.started) return ackErr(cb, "Audit už byl zahájen.", "LOCKED");

    // Validate lawyer availability (functionKey LAWYER_TRENDS)
    const inv = game.inventory[playerId] || blankInventory();
    const hasLawyer = countAvailableExperts(inv, "LAWYER_TRENDS") > 0;
    if(lawyer && !hasLawyer) return ackErr(cb, "Nemáš právníka.", "NO_POWER");

    // Validate payload
    let next = null;
    if(lawyer && lawyer.mode==="BLOCK_TREND"){
      const trendKey = String(lawyer.trendKey||"").trim();
      if(!trendKey) return ackErr(cb, "Chybí trend.", "BAD_INPUT");
      // Lawyer can only block trends explicitly marked as allowed and currently active this year
      const y = game.year || 1;
      const globals = (game.trends?.byYear?.[String(y)]?.globals) || [];
      const t = globals.find(x=>x && x.key===trendKey);
      if(!t) return ackErr(cb, "Trend není aktivní.", "BAD_INPUT");
      if(!t.lawyer?.allowed) return ackErr(cb, "Tento trend nelze blokovat právníkem.", "BAD_INPUT");
      next = { mode:"BLOCK_TREND", trendKey };
    } else if(lawyer && lawyer.mode==="SHIELD_LOBBY"){
      next = { mode:"SHIELD_LOBBY" };
    } else {
      next = null;
    }
    game.settle.pending[playerId].lawyer = next;
    ackOk(cb);
    broadcast(game);
  });

  socket.on("audit_add_pending_lobby", (payload, cb) => {
    const { gameId, playerId, action } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.phase!=="SETTLE") return ackErr(cb, "Not SETTLE phase", "BAD_STATE");
    ensureSettlePlayer(game, playerId);
    const entry = game.settle.entries[playerId];
    if(entry.started) return ackErr(cb, "Audit už byl zahájen.", "LOCKED");

    const inv = game.inventory[playerId] || blankInventory();
    const available = countAvailableExperts(inv, "STEAL_BASE_PROD");
    const current = game.settle.pending[playerId].lobby.length;
    if(current >= available) return ackErr(cb, "Nemáš dalšího lobbistu.", "NO_POWER");

    const type = String(action?.type||"").toUpperCase();
    if(type!=="STEAL" && type!=="SABOTAGE") return ackErr(cb, "Neplatný typ.", "BAD_INPUT");
    const targetPid = String(action?.targetPid||"").trim();
    if(!targetPid || !game.players.some(p=>p.playerId===targetPid)) return ackErr(cb, "Neplatný cíl.", "BAD_INPUT");
    if(targetPid===playerId) return ackErr(cb, "Nemůžeš cílit sám na sebe.", "BAD_INPUT");

    game.settle.pending[playerId].lobby.push({ type, targetPid });
    ackOk(cb);
    broadcast(game);
  });

  socket.on("audit_remove_pending_lobby", (payload, cb) => {
    const { gameId, playerId, index } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.phase!=="SETTLE") return ackErr(cb, "Not SETTLE phase", "BAD_STATE");
    ensureSettlePlayer(game, playerId);
    const entry = game.settle.entries[playerId];
    if(entry.started) return ackErr(cb, "Audit už byl zahájen.", "LOCKED");
    const i = Number(index);
    if(!Number.isInteger(i)) return ackErr(cb, "Bad index", "BAD_INPUT");
    game.settle.pending[playerId].lobby.splice(i,1);
    ackOk(cb);
    broadcast(game);
  });

  // Legacy event name kept for compatibility with existing UI: "commit_settlement_ready" == "audit_start"
  socket.on("commit_settlement_ready", (payload, cb) => {
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.phase!=="SETTLE") return ackErr(cb, "Not SETTLE phase", "BAD_STATE");

    ensureSettlePlayer(game, playerId);
    const entry = game.settle.entries[playerId];
    if(entry.started) return ackOk(cb);

    // Consume selected experts on start (but keep actions secret)
    const inv = game.inventory[playerId] || blankInventory();
    const pend = game.settle.pending[playerId] || { lawyer:null, lobby:[] };

    // Validate pending lawyer BLOCK_TREND (must be active this year and allowed)
    if(pend.lawyer && pend.lawyer.mode==="BLOCK_TREND"){
      const y = game.year || 1;
      const globals = (game.trends?.byYear?.[String(y)]?.globals) || [];
      const t = globals.find(x=>x && x.key===pend.lawyer.trendKey);
      if(!t) return ackErr(cb, "Trend není aktivní.", "BAD_INPUT");
      if(!t.lawyer?.allowed) return ackErr(cb, "Tento trend nelze blokovat právníkem.", "BAD_INPUT");
    }


    if(pend.lawyer){
      const ex = inv.experts.find(e=>e.functionKey==="LAWYER_TRENDS" && !e.used);
      if(!ex) return ackErr(cb, "Nemáš právníka.", "NO_POWER");
      ex.used = true;
    }
    if((pend.lobby||[]).length){
      for(let k=0;k<pend.lobby.length;k++){
        const ex = inv.experts.find(e=>e.functionKey==="STEAL_BASE_PROD" && !e.used);
        if(!ex) return ackErr(cb, "Nemáš dost lobbistů.", "NO_POWER");
        ex.used = true;
      }
    }
    game.inventory[playerId] = inv;

    entry.started = true;
    entry.paid = false;
    ackOk(cb);

    // If all started -> compute final for all
    const allStarted = game.players.every(p=>game.settle.entries?.[p.playerId]?.started);
    if(allStarted){
      computeAuditFinalForAll(game);
    }
    broadcast(game);
  });

  socket.on("audit_pay", (payload, cb) => {
    const { gameId, playerId } = payload || {};
    const game = getGame(gameId);
    if(!game) return ackErr(cb, "Game not found", "NOT_FOUND");
    if(game.phase!=="SETTLE") return ackErr(cb, "Not SETTLE phase", "BAD_STATE");
    ensureSettlePlayer(game, playerId);
    const entry = game.settle.entries[playerId];
    if(!entry.started) return ackErr(cb, "Nejdřív zahaj audit.", "BAD_STATE");
    if(game.settle.stage!=="FINAL") return ackErr(cb, "Čekám na ostatní hráče…", "WAIT");
    entry.paid = true;
    game.settle.stage = game.players.every(p=>game.settle.entries?.[p.playerId]?.paid) ? "PAID" : game.settle.stage;
    ackOk(cb, { amountUsd: entry.finalUsd ?? 0 });
    broadcast(game);
  });

  // Preview audit (no commit) – used by "Předběžný audit" in accounting.
  socket.on("preview_audit", (payload, cb) => {
    try{
      const { gameId, playerId } = payload || {};
      const game = games.get(gameId);
      if(!game) return ackErr(cb, "Hra neexistuje.");
      const p = game.players.find(x=>x.playerId===playerId);
      if(!p) return ackErr(cb, "Neplatný hráč.");
      ensureSettlePlayer(game, playerId);
      const pending = game.settle.pending[playerId] || { lawyer:null, lobby:[] };
      const blockedTrendKey = (pending.lawyer && pending.lawyer.mode==="BLOCK_TREND") ? pending.lawyer.trendKey : null;
      const { usd, breakdown } = auditPreview(game, playerId, { blockedTrendKey });
      return ackOk(cb, { settlementUsd: usd, breakdown });
    }catch(e){
      return ackErr(cb, "Chyba preview auditu.");
    }
  });
  socket.on("disconnect", () => {
      const b = socketBindings.get(socket.id);
      if(!b) return;
      socketBindings.delete(socket.id);
      const game = getGame(b.gameId);
      if(!game) return;
      const p = (game.players||[]).find(x=>x.playerId===b.playerId);
      if(p){ p.connected = false; broadcast(game); }
    });


});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log("Server listening on", PORT));
  

