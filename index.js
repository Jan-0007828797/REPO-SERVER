
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get("/", (req,res)=> res.status(200).send("Kryptopoly server OK"));
app.get("/health", (req,res)=> res.json({ ok:true, ts: Date.now() }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ["GET","POST"] } });

const games = new Map();

function now(){ return Date.now(); }
function shortId(){ return uuidv4().slice(0,8); }
function clampPlayers(n){ n=Number(n); if(!Number.isFinite(n)) return 1; return Math.max(1, Math.min(6, Math.floor(n))); }
function clampYears(n){ n=Number(n); if(!Number.isFinite(n)) return 4; return (n===5?5:4); }
function initialPrices(){ return { BTC:100, ETH:50, LTC:20, SIA:5 }; }
function shuffle(arr){ const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

const CATALOG = (() => {
  const continents = ["EUROPE","ASIA","AFRICA","N_AMERICA","S_AMERICA","OCEANIA"];
  const markets12 = Array.from({length:12}, (_,i)=>`M${String(i+1).padStart(2,"0")}`);
  const types = ["AGRO","INDUSTRY","MINING","ENERGY","TECH","LOGISTICS"];
  const investments = Array.from({length:48}, (_,i)=>{
    const n=i+1;
    return { cardId:`TI${String(n).padStart(3,"0")}`, name:`Tradiční investice ${n}`, continent: continents[i % continents.length], market: markets12[i % markets12.length], type: types[i % types.length], usdProduction: 2 + (n % 7) };
  });
  const crypto = ["BTC","ETH","LTC","SIA"];
  const miningFarms = Array.from({length:4}, (_,i)=>{
    const n=i+1;
    return { cardId:`MF${String(n).padStart(3,"0")}`, name:`Mining farma ${n}`, crypto: crypto[i], cryptoProduction: 1 + (n%2), electricityUSD: 2 + n };
  });
  const expertFuncs = [
    ["ANALYST","Analytik","Odhalí 3 globální trendy nejbližšího skrytého roku."],
    ["CRYPTOGURU","Kryptoguru","Odhalí kryptotrend nejbližšího skrytého roku."],
    ["LAWYER_TRENDS","Právník","Zruší negativní dopad globálních trendů (test verze)."],
    ["LOBBY_LASTCALL","Lobbista","V obálce uvidíš nabídky ostatních a dáš finální nabídku."]
  ];
  const experts = Array.from({length:30}, (_,i)=>{
    const n=i+1;
    const f = expertFuncs[i % expertFuncs.length];
    return { cardId:`EX${String(n).padStart(3,"0")}`, name:`Expert ${f[1]} ${Math.floor(i/expertFuncs.length)+1}`, function:f[0], functionLabel:f[1], functionDesc:f[2] };
  });
  const globalTrends = [
    { key:"ENERGY_CRISIS", name:"Energetická krize", effect:{ type:"ELECTRICITY_MULT", params:{ mult:1.5 } } },
    { key:"GREEN_SUBSIDY", name:"Zelené dotace", effect:{ type:"ALL_USD_BONUS", params:{ usd:1 } } },
    { key:"INFLATION", name:"Inflace", effect:{ type:"ALL_USD_PENALTY", params:{ usd:-1 } } },
    { key:"INVESTOR_FRENZY", name:"Investorská euforie", effect:{ type:"ALL_USD_BONUS", params:{ usd:2 } } },
    { key:"BANK_TIGHTEN", name:"Utahování politiky", effect:{ type:"ALL_USD_PENALTY", params:{ usd:-2 } } },
    { key:"DROUGHT", name:"Sucho", effect:{ type:"AGRO_PENALTY", params:{ usd:-2 } } },
  ];
  const regionalTrends = Object.fromEntries(continents.map(c=>[c, [
    { key:`${c}_GROWTH`, name:"Regionální růst", effect:{ type:"REGION_BONUS", params:{ usd:2 } } },
    { key:`${c}_SLOW`, name:"Regionální zpomalení", effect:{ type:"REGION_PENALTY", params:{ usd:-2 } } },
    { key:`${c}_INFRA`, name:"Infrastruktura", effect:{ type:"REGION_BONUS", params:{ usd:1 } } },
    { key:`${c}_CRISIS`, name:"Regionální krize", effect:{ type:"REGION_PENALTY", params:{ usd:-1 } } },
  ]]));
  const cryptoTrends = [
    { key:"UP", name:"Krypto roste" },
    { key:"DOWN", name:"Krypto padá" },
    { key:"FLAT", name:"Krypto stagnuje" },
  ];
  return { investments, miningFarms, experts, globalTrends, regionalTrends, cryptoTrends, continents, markets12 };
})();

function pickRandom(arr, k){ return shuffle(arr).slice(0,k); }
function generateSeed(yearsTotal){
  const years = [];
  for(let y=1;y<=yearsTotal;y++){
    const globals = pickRandom(CATALOG.globalTrends, 3).map(t=>({ ...t, trendId: uuidv4(), year:y, kind:"GLOBAL", revealed: y===1 }));
    const crypto = pickRandom(CATALOG.cryptoTrends, 1)[0];
    const cryptoObj = { ...crypto, trendId: uuidv4(), year:y, kind:"CRYPTO", revealed: y===1 };
    const regionals = Object.entries(CATALOG.regionalTrends).map(([continent, list])=>{
      const t = pickRandom(list, 1)[0];
      return { ...t, trendId: uuidv4(), year:y, kind:"REGIONAL", region:continent, revealed: y===1 };
    });
    years.push({ year:y, globals, crypto: cryptoObj, regionals });
  }
  return { years };
}
function applyCryptoTrend(prices, t){
  const key = t?.key || "FLAT";
  const mult = key==="UP" ? 1.2 : key==="DOWN" ? 0.8 : 1.0;
  const out = {};
  for(const k of Object.keys(prices)){ out[k] = Math.max(1, Math.round(prices[k]*mult)); }
  return out;
}
function defaultClockSeconds(){ return 60; }
function publicGameState(game){
  return { gameId: game.gameId, config: game.config, status: game.status, fsm: game.fsm,
    players: game.players.map(p=>({ playerId:p.playerId, name:p.name, role:p.role, market:p.market, wallet:p.wallet })),
    seed: game.seed, assets: game.assets, prices: game.prices, stepData: game.stepData || {} };
}
function broadcast(game){ io.to(`game:${game.gameId}`).emit("game_state", publicGameState(game)); }
function setStep(game, phase, step){ game.fsm.phase=phase; game.fsm.step=step; game.fsm.stepStartedAt=now(); game.fsm.timerEndsAt=null; game.stepData={}; }
function startTimer(game, seconds){ game.fsm.timerEndsAt = now() + seconds*1000; }
function timerLeft(game){ if(!game.fsm.timerEndsAt) return null; return Math.max(0, Math.ceil((game.fsm.timerEndsAt - now())/1000)); }

function resolveTimer(game){
  if(timerLeft(game)!==0) return;
  const step = game.fsm.step;
  if(step==="F1_ML_BID"){ for(const p of game.players){ if(game.stepData.mlBids?.[p.playerId]==null) game.stepData.mlBids[p.playerId]={bid:null,ts:now()}; } resolveML(game); }
  if(step==="F1_MOVE"){ for(const p of game.players){ if(game.stepData.moves?.[p.playerId]==null) game.stepData.moves[p.playerId]={marketId:p.market?.marketId||null,continent:p.market?.continent||null,ts:now()}; } resolveMoves(game); }
  if(step==="F1_ENVELOPE"){ for(const p of game.players){ if(game.stepData.envelope?.[p.playerId]==null) game.stepData.envelope[p.playerId]={bid:null,usedLobby:false,ts:now(),finalBid:null}; } resolveEnvelope(game); }
  if(step==="F1_LOBBY_LASTCALL"){ resolveEnvelope(game); }
  if(step==="F2_CRYPTO"){ for(const p of game.players){ if(game.stepData.crypto?.[p.playerId]==null) game.stepData.crypto[p.playerId]={trades:{},confirm:true,ts:now()}; } resolveCrypto(game); }
  if(step==="F3_CLOSE"){ for(const p of game.players){ if(game.stepData.close?.[p.playerId]==null) game.stepData.close[p.playerId]={confirm:true,ts:now()}; } resolveSettlement(game); }
}

function resolveML(game){
  const bids = Object.entries(game.stepData.mlBids||{}).map(([pid,v])=>({ pid, bid: v.bid==null ? -1 : Number(v.bid), ts: v.ts }));
  bids.sort((a,b)=> (b.bid-a.bid) || (a.ts-b.ts));
  const winner = bids[0];
  game.meta.currentML = (winner && winner.bid>=0) ? winner.pid : game.players.find(p=>p.role==="GM")?.playerId;
  setStep(game, 1, "F1_MOVE"); game.stepData.moves={}; startTimer(game, defaultClockSeconds()); broadcast(game);
}
function resolveMoves(game){ setStep(game, 1, "F1_ENVELOPE"); game.stepData.envelope={}; startTimer(game, defaultClockSeconds()); broadcast(game); }

function resolveEnvelope(game){
  const pool = game.meta.deckInvestments;
  const item = game.stepData.currentAuctionItem || pool.shift();
  game.stepData.currentAuctionItem = item;
  const bids = game.stepData.envelope || {};
  let best = null;
  for(const [pid, v] of Object.entries(bids)){
    const offer = v.usedLobby ? (v.finalBid==null? v.bid : v.finalBid) : v.bid;
    const bid = offer==null ? -1 : Number(offer);
    const ts = v.ts || now();
    if(best==null || bid>best.bid || (bid===best.bid && ts<best.ts) || (bid===best.bid && pid===game.meta.currentML)){ best = { pid, bid, ts }; }
  }
  game.stepData.auctionResult = { card: item, wonBy: (best && best.bid>=0) ? best.pid : null, bid: (best && best.bid>=0)? best.bid : null };
  setStep(game, 1, "F1_SCAN"); game.stepData.scan={open:true}; broadcast(game);
}

function resolveCrypto(game){
  const yearObj = game.seed.years.find(y=>y.year===game.fsm.year);
  game.prices = applyCryptoTrend(game.prices, yearObj.crypto);
  for(const p of game.players){
    const entry = game.stepData.crypto[p.playerId] || { trades:{}, confirm:true };
    for(const sym of Object.keys(game.prices)){
      const delta = Number(entry.trades?.[sym]||0);
      if(delta<0){ const sell = Math.min(p.wallet[sym]||0, Math.abs(delta)); p.wallet[sym]=(p.wallet[sym]||0)-sell; }
      else if(delta>0){ const buy = Math.min(10, delta); p.wallet[sym]=(p.wallet[sym]||0)+buy; }
    }
  }
  setStep(game, 3, "F3_CLOSE"); game.fsm.phase=3; game.stepData.close={}; startTimer(game, defaultClockSeconds()); broadcast(game);
}

function computeSettlement(game, playerId){
  const p = game.players.find(x=>x.playerId===playerId);
  const ownedInv = game.assets.filter(a=>a.type==="TRADITIONAL_INVESTMENT" && a.owner?.playerId===playerId);
  const farms = game.assets.filter(a=>a.type==="MINING_FARM" && a.owner?.playerId===playerId);
  const yearObj = game.seed.years.find(y=>y.year===game.fsm.year);
  let base = ownedInv.reduce((s,a)=>s + Number(a.rules.usdProduction||0), 0);
  let global = 0; let regional = 0;
  let electricity = farms.reduce((s,a)=> s + Number(a.rules.electricityUSD||0) * Number(a.owner.quantity||1), 0);
  let elecMult = 1.0;
  for(const t of yearObj.globals){
    const eff=t.effect;
    if(eff.type==="ALL_USD_BONUS") global += Number(eff.params.usd||0);
    if(eff.type==="ALL_USD_PENALTY") global += Number(eff.params.usd||0);
    if(eff.type==="ELECTRICITY_MULT") elecMult *= Number(eff.params.mult||1);
  }
  electricity = Math.round(electricity * elecMult);
  const r = yearObj.regionals.find(x=>x.region===p.market?.continent);
  if(r){ regional += Number(r.effect.params.usd||0); }
  const total = base + global + regional - electricity;
  const cryptoValue = Object.keys(game.prices).reduce((s,k)=> s + (p.wallet[k]||0)*game.prices[k], 0);
  return { baseUSD: base, globalUSD: global, regionalUSD: regional, electricityUSD: electricity, totalUSD: total, cryptoValueUSD: cryptoValue, prices: game.prices };
}

function resolveSettlement(game){
  game.stepData.settlement = {};
  for(const p of game.players){ game.stepData.settlement[p.playerId] = computeSettlement(game, p.playerId); }
  setStep(game, 3, "F3_RESULT"); broadcast(game);
  if(game.fsm.year >= game.config.yearsTotal){ game.status="ENDED"; game.fsm.step="ENDED"; broadcast(game); return; }
  game.fsm.year += 1; game.fsm.phase=1; setStep(game, 1, "F1_ML_BID"); game.stepData.mlBids={}; startTimer(game, defaultClockSeconds()); broadcast(game);
}

io.on("connection", (socket)=>{

  socket.on("create_game", (payload, cb)=>{
    try{
      const gameId = shortId();
      const maxPlayers = clampPlayers(payload?.maxPlayers);
      const yearsTotal = clampYears(payload?.yearsTotal);
      const title = String(payload?.title || "Kryptopoly").slice(0,60);

      const gm = { playerId: uuidv4(), name: String(payload?.gmName||"GM").slice(0,24), role:"GM", market:{continent:null, marketId:null}, wallet:{BTC:0,ETH:0,LTC:0,SIA:0} };

      const game = {
        gameId,
        config: { title, maxPlayers, yearsTotal, createdAt: now() },
        status: "LOBBY",
        seed: generateSeed(yearsTotal),
        players: [gm],
        assets: [],
        prices: initialPrices(),
        fsm: { year: 1, phase: 1, step:"LOBBY", stepStartedAt: now(), timerEndsAt: null },
        stepData: {},
        meta: { currentML: null, deckInvestments: shuffle(CATALOG.investments) }
      };

      games.set(gameId, game);
      cb && cb({ ok:true, gameId, gmPlayerId: gm.playerId });
      io.to(`lobby:${gameId}`).emit("lobby_update", { gameId, config: game.config, players: game.players });
    }catch(e){ cb && cb({ ok:false, error: String(e?.message||e) }); }
  });

  socket.on("join_game", ({ gameId, name }, cb)=>{
    const game = games.get(gameId);
    if(!game) return cb && cb({ ok:false, error:"Hra nenalezena." });
    if(game.status!=="LOBBY") return cb && cb({ ok:false, error:"Hra už běží." });
    if(game.players.length >= game.config.maxPlayers) return cb && cb({ ok:false, error:"Hra je plná." });
    const clean = String(name||"").trim().slice(0,24);
    if(!clean) return cb && cb({ ok:false, error:"Zadej jméno." });
    if(game.players.some(p=>p.name.toLowerCase()===clean.toLowerCase())) return cb && cb({ ok:false, error:"Jméno už existuje." });
    const p = { playerId: uuidv4(), name: clean, role:"PLAYER", market:{continent:null, marketId:null}, wallet:{BTC:0,ETH:0,LTC:0,SIA:0} };
    game.players.push(p);
    cb && cb({ ok:true, playerId: p.playerId });
    io.to(`lobby:${gameId}`).emit("lobby_update", { gameId, config: game.config, players: game.players });
  });

  socket.on("watch_lobby", ({ gameId }, cb)=>{
    const game = games.get(gameId);
    if(!game) return cb && cb({ ok:false, error:"Lobby nenalezeno." });
    socket.join(`lobby:${gameId}`);
    cb && cb({ ok:true });
    socket.emit("lobby_update", { gameId, config: game.config, players: game.players });
  });

  socket.on("watch_game", ({ gameId }, cb)=>{
    const game = games.get(gameId);
    if(!game) return cb && cb({ ok:false, error:"Hra nenalezena." });
    socket.join(`game:${gameId}`);
    cb && cb({ ok:true });
    socket.emit("game_state", publicGameState(game));
  });

  socket.on("start_game", ({ gameId }, cb)=>{
    const game = games.get(gameId);
    if(!game) return cb && cb({ ok:false, error:"Hra nenalezena." });
    game.status="RUNNING";
    game.fsm.year=1; game.fsm.phase=1;
    setStep(game, 1, "F1_ML_BID");
    game.stepData.mlBids={};
    startTimer(game, defaultClockSeconds());
    cb && cb({ ok:true });
    io.to(`lobby:${gameId}`).emit("game_started", { gameId });
    broadcast(game);
  });

  socket.on("tick", ({ gameId })=>{
    const game = games.get(gameId);
    if(!game || game.status!=="RUNNING") return;
    resolveTimer(game);
  });

  socket.on("submit_action", ({ gameId, playerId, actionType, data }, cb)=>{
    const game = games.get(gameId);
    if(!game) return cb && cb({ ok:false, error:"Hra nenalezena." });
    const p = game.players.find(x=>x.playerId===playerId);
    if(!p) return cb && cb({ ok:false, error:"Hráč nenalezen." });
    const step = game.fsm.step;

    try{
      if(step==="F1_ML_BID" && actionType==="ML_BID"){
        game.stepData.mlBids = game.stepData.mlBids || {};
        const want = data?.want===true;
        const bid = want ? Math.max(0, Number(data?.bid||0)) : null;
        game.stepData.mlBids[playerId] = { bid, ts: now() };
        if(Object.keys(game.stepData.mlBids).length === game.players.length) resolveML(game);
        else broadcast(game);
        return cb && cb({ ok:true });
      }
      if(step==="F1_MOVE" && actionType==="MOVE_SELECT"){
        game.stepData.moves = game.stepData.moves || {};
        const marketId = String(data?.marketId||"").trim();
        const continent = String(data?.continent||"EUROPE").trim();
        const taken = new Set(Object.values(game.stepData.moves).map(v=>v.marketId).filter(Boolean));
        if(taken.has(marketId) && game.stepData.moves[playerId]?.marketId !== marketId) return cb && cb({ ok:false, error:"Trh obsazen." });
        game.stepData.moves[playerId] = { marketId, continent, ts: now() };
        p.market = { marketId, continent };
        if(Object.keys(game.stepData.moves).length === game.players.length) resolveMoves(game);
        else broadcast(game);
        return cb && cb({ ok:true });
      }
      if(step==="F1_ENVELOPE" && actionType==="ENVELOPE_BID"){
        game.stepData.envelope = game.stepData.envelope || {};
        const want = data?.want===true;
        const bid = want ? Math.max(0, Number(data?.bid||0)) : null;
        const useLobby = data?.useLobby===true;
        game.stepData.envelope[playerId] = { bid, usedLobby: useLobby, ts: now(), finalBid: null };
        broadcast(game);
        if(Object.keys(game.stepData.envelope).length === game.players.length){
          const anyLobby = Object.values(game.stepData.envelope).some(v=>v.usedLobby);
          if(anyLobby){
            setStep(game, 1, "F1_LOBBY_LASTCALL");
            game.stepData.lastCall = { pending: Object.fromEntries(Object.entries(game.stepData.envelope).filter(([_,v])=>v.usedLobby)) };
            startTimer(game, 20);
            broadcast(game);
          } else { resolveEnvelope(game); }
        }
        return cb && cb({ ok:true });
      }
      if(step==="F1_LOBBY_LASTCALL" && actionType==="LOBBY_FINAL_BID"){
        const entry = game.stepData.envelope?.[playerId];
        if(!entry?.usedLobby) return cb && cb({ ok:false, error:"Lobbista není aktivní." });
        entry.finalBid = Math.max(0, Number(data?.finalBid||0));
        entry.ts = now();
        broadcast(game);
        const pending = Object.entries(game.stepData.envelope).filter(([_,v])=>v.usedLobby);
        const allFinal = pending.every(([_,v])=>v.finalBid!=null);
        if(allFinal) resolveEnvelope(game);
        return cb && cb({ ok:true });
      }
      if(step==="F1_SCAN" && actionType==="SCAN_CARD"){
        const cardId = String(data?.cardId||"").trim();
        if(!cardId) return cb && cb({ ok:false, error:"Chybí cardId." });
        const inv = CATALOG.investments.find(x=>x.cardId===cardId);
        const mf  = CATALOG.miningFarms.find(x=>x.cardId===cardId);
        const ex  = CATALOG.experts.find(x=>x.cardId===cardId);
        let type=null, card=null;
        if(inv){ type="TRADITIONAL_INVESTMENT"; card=inv; }
        else if(mf){ type="MINING_FARM"; card=mf; }
        else if(ex){ type="EXPERT"; card=ex; }
        else return cb && cb({ ok:false, error:"Neznámá karta." });

        if(type!=="MINING_FARM"){
          if(game.assets.some(a=>a.cardId===cardId)) return cb && cb({ ok:false, error:"Karta už je ve hře." });
        }
        if(type==="MINING_FARM"){
          const existing = game.assets.find(a=>a.cardId===cardId && a.owner?.playerId===playerId);
          if(existing) existing.owner.quantity += 1;
          else game.assets.push({ assetId: uuidv4(), type, cardId, name: card.name, rules:{ electricityUSD: card.electricityUSD }, owner:{ playerId, quantity: 1 }});
        }
        if(type==="TRADITIONAL_INVESTMENT"){
          game.assets.push({ assetId: uuidv4(), type, cardId, name: card.name, rules:{ usdProduction: card.usdProduction, type: card.type }, owner:{ playerId, quantity: 1 }});
        }
        if(type==="EXPERT"){
          game.assets.push({ assetId: uuidv4(), type, cardId, name: card.name, rules:{ function: card.function, functionLabel: card.functionLabel }, owner:{ playerId, quantity: 1 }});
        }
        broadcast(game);
        return cb && cb({ ok:true });
      }
      if(step==="F1_SCAN" && actionType==="NEXT_PHASE"){
        if(p.role!=="GM") return cb && cb({ ok:false, error:"Pouze GM." });
        setStep(game, 2, "F2_CRYPTO");
        game.fsm.phase = 2;
        game.stepData.crypto = {};
        startTimer(game, defaultClockSeconds());
        broadcast(game);
        return cb && cb({ ok:true });
      }
      if(step==="F2_CRYPTO" && actionType==="CRYPTO_SET"){
        game.stepData.crypto = game.stepData.crypto || {};
        const sym = String(data?.sym||"");
        const delta = Number(data?.delta||0);
        if(!["BTC","ETH","LTC","SIA"].includes(sym)) return cb && cb({ ok:false, error:"Neznámé krypto." });
        const entry = game.stepData.crypto[playerId] || { trades:{}, confirm:false, ts: now() };
        entry.trades[sym] = Math.max(-10, Math.min(10, delta));
        entry.ts = now();
        game.stepData.crypto[playerId] = entry;
        broadcast(game);
        return cb && cb({ ok:true });
      }
      if(step==="F2_CRYPTO" && actionType==="CRYPTO_CONFIRM"){
        game.stepData.crypto = game.stepData.crypto || {};
        const entry = game.stepData.crypto[playerId] || { trades:{}, confirm:false, ts: now() };
        entry.confirm = true;
        entry.ts = now();
        game.stepData.crypto[playerId] = entry;
        broadcast(game);
        const all = game.players.every(pp=> game.stepData.crypto?.[pp.playerId]?.confirm===true);
        if(all) resolveCrypto(game);
        return cb && cb({ ok:true });
      }
      if(step==="F3_CLOSE" && actionType==="F3_SUBMIT"){
        game.stepData.close = game.stepData.close || {};
        game.stepData.close[playerId] = { confirm: true, ts: now() };
        broadcast(game);
        const all = game.players.every(pp=> game.stepData.close?.[pp.playerId]?.confirm===true);
        if(all) resolveSettlement(game);
        return cb && cb({ ok:true });
      }
      return cb && cb({ ok:false, error:"Akce není dostupná v tomto kroku." });
    }catch(e){ return cb && cb({ ok:false, error:String(e?.message||e) }); }
  });

});

setInterval(()=>{ for(const g of games.values()){ if(g.status==="RUNNING") resolveTimer(g); } }, 500);
const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log("Kryptopoly server listening on", PORT));
