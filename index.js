
// Kryptopoly Server (simplified reference implementation)
// KDC‑1 compliant skeleton

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = 3001;

const games = {};

function createGame(gameId) {
  games[gameId] = {
    phase: "ML",
    year: 1,
    players: {},
    readiness: new Set(),
  };
}

function publicState(game) {
  return {
    phase: game.phase,
    year: game.year,
    players: Object.keys(game.players).map(p => ({ id: p })),
    readinessCount: game.readiness.size
  };
}

function playerState(game, playerId) {
  return {
    myId: playerId,
    myData: game.players[playerId]
  };
}

function syncGame(gameId) {
  const game = games[gameId];
  Object.entries(game.players).forEach(([playerId, player]) => {
    player.socket.emit("state_sync", {
      public: publicState(game),
      my: playerState(game, playerId)
    });
  });
}

io.on("connection", socket => {

  socket.on("join_game", ({ gameId, name }) => {
    if (!games[gameId]) createGame(gameId);

    const playerId = "P" + Math.random().toString(36).slice(2,7);

    games[gameId].players[playerId] = {
      name,
      socket,
      crypto: { BTC:0, ETH:0, LTC:0, SIA:0 }
    };

    socket.join(gameId);
    socket.emit("joined", { playerId });
    syncGame(gameId);
  });

  socket.on("commit_phase", ({ gameId, playerId }) => {
    const game = games[gameId];
    game.readiness.add(playerId);

    if (game.readiness.size === Object.keys(game.players).length) {
      const order = ["ML","MARKET_PICK","AUCTION","ACQUIRE","EXCHANGE","AUDIT"];
      const idx = order.indexOf(game.phase);
      game.phase = order[(idx+1) % order.length];
      game.readiness.clear();
    }

    syncGame(gameId);
  });

});

server.listen(PORT, () => {
  console.log("Kryptopoly server running on port", PORT);
});
