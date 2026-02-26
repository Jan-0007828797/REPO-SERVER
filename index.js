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
app.get("/", (req, res) => res.status(200).send("Kryptopoly server OK"));
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ["GET", "POST"] } });

/**
 * Kryptopoly v4 protocol (KDC-1 + golden rule)
 * - Board is the game. App is a tool. USD cash is not tracked.
 * - GM advances phases (manual advance preserved).
 * - Every phase has one definitive commit.
 * - Privacy: offers, lobbyist intent, lawyer usage, targets are never broadcast.
 */

function now() { return Date.now(); }
function shortId() { return uuidv4().slice(0, 8); }
function clampPlayers(n) { n = Number(n); if (!Number.isFinite(n)) return 1; return Math.max(1, Math.min(6, Math.floor(n))); }
function clampYears(n) { n = Number(n); if (!Number.isFinite(n)) return 4; return (n === 5 ? 5 : 4); }
function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }
function pickRandom(arr, k) { return shuffle(arr).slice(0, k); }

const PHASES = ["ML", "MARKET_PICK", "AUCTION", "ACQUIRE", "EXCHANGE", "AUDIT"];
const CONTINENT_ORDER = ["S_AMERICA", "N_AMERICA", "EUROPE", "AFRICA", "ASIA", "OCEANIA"]; // app display order: SA, JA, EVR, AFR, ASIE, OCEANIE (JA = N_AMERICA)
const COINS = ["BTC", "ETH", "LTC", "SIA"];

const DATA_DIR = path.join(__dirname, "data");
const TREND_DEFS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "globalTrends.json"), "utf8"));

function trendById(id) { return TREND_DEFS.find(t => t.id === id); }

function buildCatalog() {
  // Minimal catalog: 48 traditional investments (AGRO/INDUSTRY/MINING distributed), 12 mining farms, 30 experts.
  // NOTE: This can be later replaced by Excel import. Keeping deterministic ids for QR.
  const types = ["AGRO", "INDUSTRY", "MINING"];
  const investments = Array.from({ length: 48 }, (_, i) => {
    const n = i + 1;
    const type = types[i % types.length];
    return {
      cardId: `TI${String(n).padStart(3, "0")}`,
      kind: "INVESTMENT",
      type,
      baseProduction: 10000 + (i % 6) * 2000, // placeholder
      continentBonusTag: null,
      globalBonusTag: null,
    };
  });
  const miningFarms = Array.from({ length: 12 }, (_, i) => ({
    cardId: `MF${String(i + 1).padStart(3, "0")}`,
    kind: "MINING_FARM",
    electricityCost: 4000 + (i % 4) * 1000,
    cryptoUnits: { BTC: 1, ETH: 1, LTC: 1, SIA: 1 } // placeholder units/year
  }));
  const experts = Array.from({ length: 30 }, (_, i) => ({
    cardId: `EX${String(i + 1).padStart(3, "0")}`,
    kind: "EXPERT",
    expertNo: i + 1,
    abilities: null // filled per game from expert table if needed
  }));

  // Markets (placeholder): per continent 2 markets each type. marketId stable.
  const markets = [];
  let idx = 1;
  for (const cont of CONTINENT_ORDER) {
    for (const type of ["AGRO", "INDUSTRY", "MINING"]) {
      markets.push({
        marketId: `M${String(idx++).padStart(2, "0")}`,
        continent: cont,
        marketType: type,
        label: `${cont}-${type}`
      });
    }
  }
  return { investments, miningFarms, experts, markets };
}
const CATALOG = buildCatalog();

function baseCostByYear(y) {
  // Used for infrastructure fee. From your examples: 5k,10k,15k,20k,25k.
  const map = { 1: 5000, 2: 10000, 3: 15000, 4: 20000, 5: 25000 };
  return map[y] || 20000;
}

function makeEmptyCrypto() { return { BTC: 0, ETH: 0, LTC: 0, SIA: 0 }; }

function makePlayer(playerId, name, role) {
  return {
    playerId,
    name: name || "Player",
    role: role || "PLAYER",
    marketId: null,
    crypto: makeEmptyCrypto(),
    cards: { investments: [], miningFarms: [], experts: [] },
    expertUsage: {}, // per expert card id: used flags
    protections: { trendCounters: {}, proofBadges: {}, lobbyistShields: 0 }, // per-year reset
    phaseLocal: {} // per-phase input/pending (private)
  };
}

function initGame(gameId, cfg) {
  const game = {
    gameId,
    status: "lobby",
    config: {
      yearsTotal: clampYears(cfg?.yearsTotal ?? 4),
      maxPlayers: clampPlayers(cfg?.maxPlayers ?? 1),
    },
    year: 1,
    phase: "ML",
    trendsActive: pickRandom(TREND_DEFS.map(t => t.id), 2), // default 2 trends/year (can be changed later)
    players: [],
    gmId: null,
    readiness: new Set(),
    // phase state
    marketPick: { occupiedBy: {}, locks: {} },
    auction: { status: "COLLECTING", commits1: {}, ready1: new Set(), lobbyistActivated: {}, eligible: [], commits2: {}, ready2: new Set() },
    acquire: { claimedBy: {}, done: new Set(), available: { investments: new Set(CATALOG.investments.map(c => c.cardId)), miningFarms: new Set(CATALOG.miningFarms.map(c => c.cardId)), experts: new Set(CATALOG.experts.map(c => c.cardId)) } },
    exchange: { pending: {}, committed: new Set(), prices: { BTC: 10000, ETH: 5000, LTC: 1000, SIA: 200 } },
    audit: { started: new Set(), confirmed: new Set(), lobbyistActions: [], final: {} }
  };
  return game;
}

const games = new Map(); // gameId -> game
const socketToPlayer = new Map(); // socket.id -> {gameId, playerId}

function getGame(gameId) { return games.get(gameId) || null; }
function findPlayer(game, playerId) { return game.players.find(p => p.playerId === playerId) || null; }

function isGM(game, playerId) { return game.gmId === playerId; }

function publicState(game) {
  return {
    gameId: game.gameId,
    status: game.status,
    config: game.config,
    year: game.year,
    phase: game.phase,
    trendsActive: game.trendsActive.map(id => {
      const t = trendById(id);
      return t ? { id: t.id, name: t.name, infoOnly: !!t.infoOnly } : { id };
    }),
    players: game.players.map(p => ({ playerId: p.playerId, name: p.name, role: p.role, marketId: p.marketId })),
    readiness: { count: game.readiness.size, total: game.players.length }
  };
}

function gmState(game) {
  return {
    year: game.year,
    phase: game.phase,
    readiness: { count: game.readiness.size, total: game.players.length },
    auction: {
      status: game.auction.status,
      ready1: game.auction.ready1.size,
      eligible: game.auction.eligible.length,
      ready2: game.auction.ready2.size
    },
    audit: { started: game.audit.started.size, confirmed: game.audit.confirmed.size }
  };
}

function summarizeCards(p) {
  return {
    investments: p.cards.investments.length,
    miningFarms: p.cards.miningFarms.length,
    experts: p.cards.experts.length
  };
}

function myState(game, playerId) {
  const p = findPlayer(game, playerId);
  if (!p) return null;

  const phaseLocal = p.phaseLocal?.[game.phase] || {};
  return {
    playerId: p.playerId,
    name: p.name,
    role: p.role,
    marketId: p.marketId,
    crypto: p.crypto,
    cardsSummary: summarizeCards(p),
    protections: p.protections,
    phaseLocal
  };
}

function emitState(game) {
  // Send to each player: public + my
  for (const p of game.players) {
    const sock = p._socket;
    if (!sock) continue;
    sock.emit("state_sync", { public: publicState(game), my: myState(game, p.playerId) });
    if (isGM(game, p.playerId)) {
      sock.emit("gm_state", gmState(game));
    }
  }
}

function resetPerYear(player) {
  player.protections = { trendCounters: {}, proofBadges: {}, lobbyistShields: 0 };
  player.phaseLocal = {};
}

function applyCryptoMutation(player, params) {
  if (params?.allCoinsHalveFloor) {
    for (const c of COINS) player.crypto[c] = Math.floor((player.crypto[c] || 0) / 2);
    return;
  }
  if (params?.multiplyCoins) {
    for (const [coin, mult] of Object.entries(params.multiplyCoins)) {
      player.crypto[coin] = Math.floor((player.crypto[coin] || 0) * Number(mult));
    }
  }
}

function applyTrends(game, triggerPoint) {
  for (const tid of game.trendsActive) {
    const t = trendById(tid);
    if (!t) continue;
    if (t.trigger === triggerPoint) {
      if (t.effectType === "CRYPTO_MUTATION") {
        for (const p of game.players) {
          if (p.protections.trendCounters?.[tid]) continue; // protected
          applyCryptoMutation(p, t.params);
          p._socket?.emit("crypto_mutation_applied", { trendId: tid, crypto: p.crypto });
        }
      }
    }
  }
}

function marketOptionsFor(game, player) {
  const occupied = game.marketPick.occupiedBy;
  const myCurrent = player.marketId;
  const pandemicActive = game.trendsActive.includes(15);
  const hasException = !!player.protections.trendCounters?.[15];

  const myContinent = (() => {
    const m = CATALOG.markets.find(x => x.marketId === myCurrent);
    return m?.continent || null;
  })();

  return CATALOG.markets.filter(m => {
    const occ = occupied[m.marketId];
    const isMine = (myCurrent && m.marketId === myCurrent);
    const free = !occ || isMine;
    if (!free) return false;
    if (pandemicActive && !hasException && myContinent) {
      // restrict to my continent
      if (m.continent !== myContinent) return false;
    }
    return true;
  });
}

function hasExpertAbility(player, abilityKey) {
  // Minimal: any expert card grants lawyer+lobbyist (placeholder). Later replaced by expert table.
  if (!player.cards.experts.length) return false;
  // Until expert table is wired, assume experts grant lawyer and lobbyist.
  if (["LAWYER", "LOBBYIST_INTEL", "LOBBYIST_STEAL", "LOBBYIST_SABOTAGE"].includes(abilityKey)) return true;
  return false;
}

function consumeExpertAbility(player, abilityKey) {
  // Find first expert card not yet used for that abilityKey; mark used.
  for (const exId of player.cards.experts) {
    const u = player.expertUsage[exId] || {};
    if (!u[abilityKey]) {
      u[abilityKey] = true;
      player.expertUsage[exId] = u;
      return exId;
    }
  }
  return null;
}

function lawyerCounterTrend(game, player, trendId, phase) {
  const t = trendById(trendId);
  if (!t || !t.lawyer?.canCounter) return { ok: false, error: "Nelze použít právníka." };
  if (!t.lawyer.allowedPhases?.includes(phase)) return { ok: false, error: "Právník nelze použít v této fázi." };
  if (!hasExpertAbility(player, "LAWYER")) return { ok: false, error: "Nemáš právníka." };
  const consumed = consumeExpertAbility(player, "LAWYER");
  if (!consumed) return { ok: false, error: "Právník už byl použit." };

  if (t.lawyer.counterMode === "PROOF_BADGE") {
    player.protections.proofBadges[trendId] = { active: true, text: t.lawyer.uiProofText || "Ochrana aktivní", year: game.year };
  } else {
    player.protections.trendCounters[trendId] = true;
  }
  return { ok: true, consumedExpert: consumed };
}

function computeAuditPreview(game, player) {
  // NOTE: USD cash not tracked. We compute "audit result" from cards.
  const active = new Set(game.trendsActive);

  // base modifiers
  let electricityMult = 1;
  let miningCryptoMult = 1;
  let tradBaseMult = 1;
  let bonusesEnabled = { regional: true, global: true };
  let tradBaseZero = false;
  let bonusUnaffected = false;

  for (const tid of active) {
    if (player.protections.trendCounters?.[tid]) continue; // countered
    const t = trendById(tid);
    if (!t || t.effectType !== "AUDIT_MOD") continue;
    const p = t.params || {};
    if (p.electricityMultiplier) electricityMult *= p.electricityMultiplier;
    if (p.miningFarmCryptoUnitsMultiplier) miningCryptoMult *= p.miningFarmCryptoUnitsMultiplier;
    if (p.traditionalBaseProductionMultiplier === 0) { tradBaseZero = true; bonusUnaffected = !!p.bonusesUnaffected; }
    if (p.traditionalBaseProductionMultiplier && p.traditionalBaseProductionMultiplier !== 0) tradBaseMult *= p.traditionalBaseProductionMultiplier;
    if (p.regionalBonusesEnabled === false) bonusesEnabled.regional = false;
    if (p.globalBonusesEnabled === false) bonusesEnabled.global = false;
  }

  // Traditional investments production
  let tradBase = 0;
  for (const id of player.cards.investments) {
    const c = CATALOG.investments.find(x => x.cardId === id);
    if (!c) continue;
    tradBase += c.baseProduction || 0;
  }
  if (tradBaseZero) tradBase = 0;
  tradBase = Math.floor(tradBase * tradBaseMult);

  // Bonuses (placeholder: not fully implemented, set to 0 if disabled)
  let tradBonuses = 0;
  if (!bonusesEnabled.regional && !bonusesEnabled.global) tradBonuses = 0;

  // Set bonuses (both tracks)
  const invCards = player.cards.investments.map(id => CATALOG.investments.find(x => x.cardId === id)).filter(Boolean);
  const byCont = {};
  for (const id of player.cards.investments) {
    const m = CATALOG.markets.find(x => x.marketId === player.marketId);
    // Continent of investment card isn't tracked in placeholder; we treat player's current continent for demo
    const cont = m?.continent || "EUROPE";
    byCont[cont] = (byCont[cont] || 0) + 1;
  }
  const byType = {};
  for (const c of invCards) byType[c.type] = (byType[c.type] || 0) + 1;

  function setBonus(count) {
    if (count >= 6) return 50000;
    if (count >= 4) return 25000;
    if (count >= 2) return 10000;
    return 0;
  }
  const contMax = Math.max(0, ...Object.values(byCont));
  const typeMax = Math.max(0, ...Object.values(byType));
  const setBonusTotal = setBonus(contMax) + setBonus(typeMax);

  // Electricity
  let electricity = 0;
  for (const id of player.cards.miningFarms) {
    const c = CATALOG.miningFarms.find(x => x.cardId === id);
    if (!c) continue;
    electricity += c.electricityCost || 0;
  }
  electricity = Math.floor(electricity * electricityMult);

  // Infrastructure fee: count other players investments on my continent * baseCostByYear
  const myCont = CATALOG.markets.find(x => x.marketId === player.marketId)?.continent;
  let foreignInvestCount = 0;
  for (const p of game.players) {
    if (p.playerId === player.playerId) continue;
    const pCont = CATALOG.markets.find(x => x.marketId === p.marketId)?.continent;
    if (!myCont || !pCont || pCont !== myCont) continue;
    foreignInvestCount += (p.cards.investments.length || 0);
  }
  const infraFee = foreignInvestCount * baseCostByYear(game.year);

  // Trend row: show net impact placeholder 0 (we already applied in other rows)
  const trendRow = 0;

  // Lobbyists row is 0 in preview (resolved only after all start)
  const lobbyRow = 0;

  const rows = [
    { key: "TRAD", label: "+ USD Tradiční investice", value: tradBase + tradBonuses },
    { key: "SET", label: "+ Set bonusy", value: setBonusTotal },
    { key: "ELEC", label: "− USD elektřina", value: -electricity },
    { key: "LOBBY", label: "± Lobbisté", value: lobbyRow },
    { key: "TRENDS", label: "± Trendy", value: trendRow },
    { key: "INFRA", label: "− Infrastruktura", value: -infraFee },
  ];
  const total = rows.reduce((s, r) => s + (r.value || 0), 0);
  return { rows, total };
}

function resolveAuditFinal(game) {
  // Compute base previews first
  const base = {};
  for (const p of game.players) base[p.playerId] = computeAuditPreview(game, p);

  // Build production totals for sabotage computation (production-only)
  const productionOnly = {};
  for (const p of game.players) {
    const rows = base[p.playerId].rows;
    const trad = rows.find(r => r.key === "TRAD")?.value || 0;
    const setb = rows.find(r => r.key === "SET")?.value || 0;
    // production-only: trad+set bonus (not subtracting costs)
    productionOnly[p.playerId] = Math.max(0, trad + setb);
  }

  // Resolve lobbyist actions with shields
  const impacts = {}; // playerId -> delta
  for (const p of game.players) impacts[p.playerId] = 0;

  // Group actions by target to allow shield blocking largest negatives
  const byTarget = {};
  for (const act of game.audit.lobbyistActions) {
    if (!byTarget[act.target]) byTarget[act.target] = [];
    byTarget[act.target].push(act);
  }

  for (const [targetId, acts] of Object.entries(byTarget)) {
    const target = findPlayer(game, targetId);
    if (!target) continue;

    // compute each action negative impact on target
    const computed = acts.map(act => {
      if (act.type === "STEAL") {
        // steal highest base production of one traditional investment
        let maxBase = 0;
        for (const invId of target.cards.investments) {
          const c = CATALOG.investments.find(x => x.cardId === invId);
          maxBase = Math.max(maxBase, c?.baseProduction || 0);
        }
        return { act, targetDelta: -maxBase, byDelta: +maxBase };
      }
      if (act.type === "SABOTAGE") {
        const amt = Math.floor(productionOnly[targetId] * 0.5);
        return { act, targetDelta: -amt, byDelta: 0 };
      }
      return { act, targetDelta: 0, byDelta: 0 };
    });

    // apply preventive shields: block largest negative actions
    const shields = target.protections.lobbyistShields || 0;
    const sorted = [...computed].sort((a, b) => a.targetDelta - b.targetDelta); // most negative first
    const blocked = new Set(sorted.slice(0, shields).map(x => x.act));

    for (const c of computed) {
      if (blocked.has(c.act)) continue;
      impacts[targetId] += c.targetDelta;
      impacts[c.act.by] += c.byDelta;
    }
  }

  // Apply impacts into final rows
  for (const p of game.players) {
    const prev = base[p.playerId];
    const rows = prev.rows.map(r => ({ ...r }));
    const lobbyRow = rows.find(r => r.key === "LOBBY");
    if (lobbyRow) lobbyRow.value = impacts[p.playerId] || 0;
    const total = rows.reduce((s, r) => s + (r.value || 0), 0);
    game.audit.final[p.playerId] = { rows, total, notes: [] };
  }
}

function startNewYear(game) {
  // advance year or loop end
  game.year += 1;
  if (game.year > game.config.yearsTotal) {
    game.status = "ended";
    return;
  }
  // pick new trends for year
  game.trendsActive = pickRandom(TREND_DEFS.map(t => t.id), 2);
  game.phase = "ML";
  game.readiness.clear();

  // reset phase states
  game.auction = { status: "COLLECTING", commits1: {}, ready1: new Set(), lobbyistActivated: {}, eligible: [], commits2: {}, ready2: new Set() };
  game.acquire.done = new Set();
  game.exchange.committed = new Set();
  game.audit = { started: new Set(), confirmed: new Set(), lobbyistActions: [], final: {} };

  for (const p of game.players) resetPerYear(p);

  // apply on-enter ML trends (forks)
  applyTrends(game, "ON_ENTER_ML");
}

io.on("connection", (socket) => {
  socket.on("create_game", ({ name, yearsTotal, maxPlayers }, cb) => {
    try {
      const gameId = shortId();
      const game = initGame(gameId, { yearsTotal, maxPlayers });
      const playerId = shortId();
      const gm = makePlayer(playerId, name || "GM", "gm");
      gm._socket = socket;
      game.players.push(gm);
      game.gmId = playerId;
      games.set(gameId, game);
      socket.join(`game:${gameId}`);
      socketToPlayer.set(socket.id, { gameId, playerId });
      game.status = "lobby";
      emitState(game);
      if (typeof cb === "function") cb({ ok: true, gameId, playerId });
    } catch (e) {
      if (typeof cb === "function") cb({ ok: false, error: e?.message || "Error" });
    }
  });

  socket.on("join_game", ({ gameId, name }, cb) => {
    const game = getGame(gameId);
    if (!game) return cb?.({ ok: false, error: "Hra nenalezena" });
    if (game.players.length >= game.config.maxPlayers) return cb?.({ ok: false, error: "Hra je plná" });
    const playerId = shortId();
    const p = makePlayer(playerId, name || "Player", "PLAYER");
    p._socket = socket;
    game.players.push(p);
    socket.join(`game:${gameId}`);
    socketToPlayer.set(socket.id, { gameId, playerId });
    emitState(game);
    cb?.({ ok: true, playerId });
  });

  socket.on("watch_lobby", ({ gameId }, cb) => {
    const game = getGame(gameId);
    if (!game) return cb?.({ ok: false, error: "Hra nenalezena" });
    socket.join(`game:${gameId}`);
    socket.emit("lobby_update", publicState(game));
    cb?.({ ok: true });
  });

  socket.on("watch_game", ({ gameId, playerId }, cb) => {
    const game = getGame(gameId);
    if (!game) return cb?.({ ok: false, error: "Hra nenalezena" });
    socket.join(`game:${gameId}`);
    // bind socket to player if matches
    const p = findPlayer(game, playerId);
    if (p) {
      p._socket = socket;
      socketToPlayer.set(socket.id, { gameId, playerId });
    }
    // send initial sync
    if (p) socket.emit("state_sync", { public: publicState(game), my: myState(game, playerId) });
    if (p && isGM(game, playerId)) socket.emit("gm_state", gmState(game));
    cb?.({ ok: true });
  });

  socket.on("gm_start_game", ({ gameId, playerId }, cb) => {
    const game = getGame(gameId);
    if (!game) return cb?.({ ok: false, error: "Hra nenalezena" });
    if (!isGM(game, playerId)) return cb?.({ ok: false, error: "Jen GM" });
    game.status = "running";
    // apply on-enter ML triggers for year start
    applyTrends(game, "ON_ENTER_ML");
    io.to(`game:${gameId}`).emit("game_started", { ok: true });
    emitState(game);
    cb?.({ ok: true });
  });

  socket.on("start_game", ({ gameId }, cb) => {
    // Compatibility alias for older WEB client
    const game = getGame(gameId);
    if (!game) return cb?.({ ok: false, error: "Hra nenalezena" });

    const link = socketToPlayer.get(socket.id);
    const pid = link?.playerId || game.gmId;
    if (!isGM(game, pid)) return cb?.({ ok: false, error: "Jen GM" });

    game.status = "running";
    applyTrends(game, "ON_ENTER_ML");
    io.to(`game:${gameId}`).emit("game_started", { ok: true });
    emitState(game);
    cb?.({ ok: true });
  });


  socket.on("gm_advance_phase", ({ gameId, playerId, toPhase }, cb) => {
    const game = getGame(gameId);
    if (!game) return cb?.({ ok: false, error: "Hra nenalezena" });
    if (!isGM(game, playerId)) return cb?.({ ok: false, error: "Jen GM" });

    const currentIdx = PHASES.indexOf(game.phase);
    let next = null;
    if (toPhase && PHASES.includes(toPhase)) next = toPhase;
    else next = PHASES[Math.min(currentIdx + 1, PHASES.length - 1)];

    // trigger transitions
    if (game.phase === "ML" && next === "MARKET_PICK") {
      applyTrends(game, "ON_LEAVE_ML"); // hacker
    }
    if (next === "ML") {
      applyTrends(game, "ON_ENTER_ML"); // forks
    }

    game.phase = next;
    game.readiness.clear();
    emitState(game);
    cb?.({ ok: true });
  });

  // --- ML ---
  socket.on("ml_commit", ({ gameId, playerId, bidUsd, pass }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "ML") return cb?.({ ok: false, error: "Nejsi ve fázi ML" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });
    p.phaseLocal.ML = { bidUsd: pass ? null : Number(bidUsd || 0), pass: !!pass };
    game.readiness.add(playerId);
    emitState(game);
    cb?.({ ok: true });
  });

  // --- Trends / Lawyer ---
  socket.on("lawyer_counter_trend", ({ gameId, playerId, trendId }, cb) => {
    const game = getGame(gameId);
    if (!game) return cb?.({ ok: false, error: "Hra nenalezena" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });
    const res = lawyerCounterTrend(game, p, Number(trendId), game.phase);
    emitState(game);
    cb?.(res);
  });

  socket.on("lawyer_activate_preventive", ({ gameId, playerId }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "AUDIT") return cb?.({ ok: false, error: "Nejsi v Auditu" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });
    if (!hasExpertAbility(p, "LAWYER")) return cb?.({ ok: false, error: "Nemáš právníka" });
    const consumed = consumeExpertAbility(p, "LAWYER");
    if (!consumed) return cb?.({ ok: false, error: "Právník už byl použit" });
    p.protections.lobbyistShields += 1;
    emitState(game);
    cb?.({ ok: true, consumedExpert: consumed });
  });

  // --- MARKET PICK ---
  socket.on("market_pick_enter", ({ gameId, playerId }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "MARKET_PICK") return cb?.({ ok: false, error: "Nejsi ve fázi Výběr trhu" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });

    const opts = marketOptionsFor(game, p);
    cb?.({ ok: true, options: opts, continentOrder: CONTINENT_ORDER });
  });

  socket.on("market_pick_commit", ({ gameId, playerId, marketId }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "MARKET_PICK") return cb?.({ ok: false, error: "Nejsi ve fázi Výběr trhu" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });

    const opts = marketOptionsFor(game, p).map(o => o.marketId);
    if (!opts.includes(marketId)) return cb?.({ ok: false, error: "Trh není dostupný" });

    // reserve
    game.marketPick.occupiedBy[marketId] = playerId;
    p.marketId = marketId;
    p.phaseLocal.MARKET_PICK = { marketId };
    game.readiness.add(playerId);

    // notify others to remove
    io.to(`game:${gameId}`).emit("market_pick_update", { removedMarketIds: [marketId], readiness: { count: game.readiness.size, total: game.players.length } });
    emitState(game);
    cb?.({ ok: true });
  });

  // --- AUCTION ---
  socket.on("auction_set_lobbyist_intent", ({ gameId, playerId, enabled }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "AUCTION") return cb?.({ ok: false, error: "Nejsi ve fázi Dražba" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });
    if (!!enabled && !hasExpertAbility(p, "LOBBYIST_INTEL")) return cb?.({ ok: false, error: "Nemáš lobbistu" });
    game.auction.lobbyistActivated[playerId] = !!enabled;
    // do not broadcast anything public
    cb?.({ ok: true });
  });

  socket.on("auction_commit_initial", ({ gameId, playerId, bidUsd, pass }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "AUCTION") return cb?.({ ok: false, error: "Nejsi ve fázi Dražba" });
    if (game.auction.status !== "COLLECTING") return cb?.({ ok: false, error: "Dražba už pokračuje" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });

    game.auction.commits1[playerId] = { bidUsd: pass ? null : Number(bidUsd || 0), passed: !!pass };
    game.auction.ready1.add(playerId);
    game.readiness.add(playerId); // phase readiness shows they made a choice

    // if all ready1 => send intel
    if (game.auction.ready1.size === game.players.length) {
      game.auction.eligible = game.players
        .filter(pl => !!game.auction.lobbyistActivated[pl.playerId] && hasExpertAbility(pl, "LOBBYIST_INTEL"))
        .map(pl => pl.playerId);
      if (game.auction.eligible.length > 0) {
        game.auction.status = "INTEL";
        // send intel only to eligible players
        for (const pid of game.auction.eligible) {
          const sock = findPlayer(game, pid)?._socket;
          if (!sock) continue;
          sock.emit("auction_intel_notify", {
            soundCue: "sms_or_call",
            offers: game.players.map(pl => ({
              playerId: pl.playerId,
              name: pl.name,
              bidUsd: game.auction.commits1[pl.playerId]?.bidUsd ?? null,
              passed: !!game.auction.commits1[pl.playerId]?.passed
            }))
          });
        }
      } else {
        game.auction.status = "RESOLVED";
      }
    }

    emitState(game);
    cb?.({ ok: true });
  });

  socket.on("auction_commit_final", ({ gameId, playerId, bidUsd, pass }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "AUCTION") return cb?.({ ok: false, error: "Nejsi ve fázi Dražba" });
    if (game.auction.status !== "INTEL") return cb?.({ ok: false, error: "Intel fáze není aktivní" });
    if (!game.auction.eligible.includes(playerId)) return cb?.({ ok: false, error: "Nemáš intel" });

    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });

    // consume lobbyist intel on first final commit
    const consumed = consumeExpertAbility(p, "LOBBYIST_INTEL");
    game.auction.commits2[playerId] = { bidUsd: pass ? null : Number(bidUsd || 0), passed: !!pass };
    game.auction.ready2.add(playerId);

    if (game.auction.ready2.size === game.auction.eligible.length) {
      game.auction.status = "RESOLVED";
    }
    emitState(game);
    cb?.({ ok: true, consumedExpert: consumed });
  });

  // --- ACQUIRE / SCAN ---
  socket.on("scan_preview", ({ gameId, playerId, qrText }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "ACQUIRE") return cb?.({ ok: false, error: "Nejsi ve fázi Akvizice" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });

    const cardId = String(qrText || "").trim();
    const all = [...CATALOG.investments, ...CATALOG.miningFarms, ...CATALOG.experts];
    const card = all.find(c => c.cardId === cardId);
    if (!card) return cb?.({ ok: false, error: "Neznámý QR" });

    const pool = card.kind === "INVESTMENT" ? game.acquire.available.investments :
      card.kind === "MINING_FARM" ? game.acquire.available.miningFarms : game.acquire.available.experts;

    const available = pool.has(cardId);
    cb?.({ ok: true, card: { cardId: card.cardId, kind: card.kind, type: card.type || null }, available });
  });

  socket.on("scan_claim", ({ gameId, playerId, cardId }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "ACQUIRE") return cb?.({ ok: false, error: "Nejsi ve fázi Akvizice" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });

    const all = [...CATALOG.investments, ...CATALOG.miningFarms, ...CATALOG.experts];
    const card = all.find(c => c.cardId === cardId);
    if (!card) return cb?.({ ok: false, error: "Neznámá karta" });

    const pool = card.kind === "INVESTMENT" ? game.acquire.available.investments :
      card.kind === "MINING_FARM" ? game.acquire.available.miningFarms : game.acquire.available.experts;

    if (!pool.has(cardId)) return cb?.({ ok: false, error: "Karta už byla získána" });
    pool.delete(cardId);

    if (card.kind === "INVESTMENT") p.cards.investments.push(cardId);
    if (card.kind === "MINING_FARM") p.cards.miningFarms.push(cardId);
    if (card.kind === "EXPERT") p.cards.experts.push(cardId);

    if (!game.acquire.claimedBy[playerId]) game.acquire.claimedBy[playerId] = [];
    game.acquire.claimedBy[playerId].push(cardId);

    p._socket?.emit("acquire_claimed", { cardId, kind: card.kind });
    emitState(game);
    cb?.({ ok: true });
  });

  socket.on("acquire_no_card_commit", ({ gameId, playerId }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "ACQUIRE") return cb?.({ ok: false, error: "Nejsi ve fázi Akvizice" });
    game.readiness.add(playerId);
    game.acquire.done.add(playerId);
    emitState(game);
    cb?.({ ok: true });
  });

  socket.on("acquire_finish_commit", ({ gameId, playerId }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "ACQUIRE") return cb?.({ ok: false, error: "Nejsi ve fázi Akvizice" });
    game.readiness.add(playerId);
    game.acquire.done.add(playerId);
    emitState(game);
    cb?.({ ok: true });
  });

  // --- EXCHANGE ---
  socket.on("exchange_update_pending", ({ gameId, playerId, pending }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "EXCHANGE") return cb?.({ ok: false, error: "Nejsi ve fázi Kryptoburza" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });

    const pen = {};
    for (const c of COINS) pen[c] = Number(pending?.[c] || 0);
    for (const c of COINS) {
      if ((p.crypto[c] + pen[c]) < 0) return cb?.({ ok: false, error: "Nelze prodat více než vlastníš" });
    }
    game.exchange.pending[playerId] = pen;
    cb?.({ ok: true });
  });

  socket.on("exchange_commit", ({ gameId, playerId }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "EXCHANGE") return cb?.({ ok: false, error: "Nejsi ve fázi Kryptoburza" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });

    const pen = game.exchange.pending[playerId] || makeEmptyCrypto();
    for (const c of COINS) p.crypto[c] += Number(pen[c] || 0);
    game.exchange.pending[playerId] = makeEmptyCrypto();
    game.exchange.committed.add(playerId);
    game.readiness.add(playerId);
    emitState(game);
    cb?.({ ok: true, crypto: p.crypto });
  });

  // --- AUDIT ---
  socket.on("audit_preview", ({ gameId, playerId }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "AUDIT") return cb?.({ ok: false, error: "Nejsi ve fázi Audit" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });
    const prev = computeAuditPreview(game, p);
    cb?.({ ok: true, preview: prev });
  });

  socket.on("lobbyist_action_select", ({ gameId, playerId, action, targetPlayerId }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "AUDIT") return cb?.({ ok: false, error: "Nejsi ve fázi Audit" });
    const p = findPlayer(game, playerId);
    if (!p) return cb?.({ ok: false, error: "Hráč nenalezen" });
    if (game.audit.started.has(playerId)) return cb?.({ ok: false, error: "Audit už zahájen" });
    if (playerId === targetPlayerId) return cb?.({ ok: false, error: "Nelze na sebe" });

    const abilityKey = action === "STEAL" ? "LOBBYIST_STEAL" : "LOBBYIST_SABOTAGE";
    if (!hasExpertAbility(p, abilityKey)) return cb?.({ ok: false, error: "Nemáš lobbistu" });
    const consumed = consumeExpertAbility(p, abilityKey);
    if (!consumed) return cb?.({ ok: false, error: "Funkce už byla použita" });

    game.audit.lobbyistActions.push({ by: playerId, type: action, target: targetPlayerId });
    cb?.({ ok: true, consumedExpert: consumed });
  });

  socket.on("audit_start", ({ gameId, playerId }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "AUDIT") return cb?.({ ok: false, error: "Nejsi ve fázi Audit" });
    if (game.audit.started.has(playerId)) return cb?.({ ok: false, error: "Už zahájeno" });

    game.audit.started.add(playerId);
    game.readiness.add(playerId);
    emitState(game);

    if (game.audit.started.size === game.players.length) {
      // final calc
      resolveAuditFinal(game);
      for (const p of game.players) {
        p._socket?.emit("audit_final_ready", game.audit.final[p.playerId]);
      }
    }
    cb?.({ ok: true });
  });

  socket.on("audit_confirm", ({ gameId, playerId }, cb) => {
    const game = getGame(gameId);
    if (!game || game.phase !== "AUDIT") return cb?.({ ok: false, error: "Nejsi ve fázi Audit" });
    game.audit.confirmed.add(playerId);
    game.readiness.add(playerId);
    emitState(game);

    // when all confirmed -> end of year (GM still presses OK in UI, but server can signal)
    if (game.audit.confirmed.size === game.players.length) {
      io.to(`game:${gameId}`).emit("year_done", { ok: true });
    }
    cb?.({ ok: true });
  });

  // Optional: GM can call this after year done
  socket.on("gm_next_year", ({ gameId, playerId }, cb) => {
    const game = getGame(gameId);
    if (!game) return cb?.({ ok: false, error: "Hra nenalezena" });
    if (!isGM(game, playerId)) return cb?.({ ok: false, error: "Jen GM" });
    startNewYear(game);
    emitState(game);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const link = socketToPlayer.get(socket.id);
    socketToPlayer.delete(socket.id);
    // keep player in game; reconnect supported by watch_game
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log("Kryptopoly server listening on", PORT));
