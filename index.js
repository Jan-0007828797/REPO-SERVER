const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { bindSocketToPlayer, attachReconnectToken, getReconnectToken, findPlayerIdByReconnectToken } = require("./session/player-session");
const core = require("./game/core");
const { registerSocketHandlers } = require("./game/socket-handlers");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get("/", (req,res)=> res.status(200).send("Kryptopoly server OK"));
app.get("/health", (req,res)=> res.json({ ok:true, ts: Date.now() }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ["GET","POST"] } });

const socketBindings = new Map();

registerSocketHandlers({ io, socketBindings, bindSocketToPlayer, attachReconnectToken, getReconnectToken, findPlayerIdByReconnectToken, core });

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
