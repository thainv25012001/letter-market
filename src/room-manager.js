import { randomBytes } from 'node:crypto';
import { createGame, expireTurn, finishRound, passTurn, raiseBid, startRound } from './game.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const RECONNECT_WINDOW_MS = 30_000;
const ROUND_PAUSE_MS = 2_200;
const MAX_MESSAGE_LENGTH = 4_096;

function cleanName(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 18)
    : '';
}

function cleanCode(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : '';
}

function makeRoomCode() {
  const bytes = randomBytes(6);
  return [...bytes].map((byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join('');
}

function makeToken() {
  return randomBytes(24).toString('base64url');
}

function publicPhase(room) {
  if (room.phase === 'lobby' || room.phase === 'ended') return room.phase;
  return room.game?.phase ?? room.phase;
}

export class RoomManager {
  #rooms = new Map();
  #socketSeats = new WeakMap();

  attach(socket) {
    socket.send(JSON.stringify({ type: 'connected' }));
    socket.on('message', (raw) => this.handleMessage(socket, raw));
    socket.on('close', () => this.#disconnect(socket));
  }

  createRoom(name, socket) {
    const safeName = cleanName(name);
    if (!safeName) return { error: 'Add an on-air name to create a room.' };

    let code = makeRoomCode();
    while (this.#rooms.has(code)) code = makeRoomCode();
    const player = this.#newPlayer(safeName, socket);
    const room = {
      code,
      hostId: player.id,
      players: [player],
      phase: 'lobby',
      game: null,
      turnTimer: null,
      roundTimer: null,
      reconnectTimers: new Map(),
      history: [],
      endedReason: null,
    };
    this.#rooms.set(code, room);
    this.#bindSeat(socket, room, player);
    return { code, token: player.token };
  }

  joinRoom(code, name, socket) {
    const safeName = cleanName(name);
    if (!safeName) return { error: 'Add an on-air name before joining.' };
    const roomCode = cleanCode(code);
    const room = this.#rooms.get(roomCode);
    if (!room) return { error: 'That room code was not found.' };
    if (room.phase !== 'lobby') return { error: 'That show has already started.' };
    if (room.players.length >= MAX_PLAYERS) return { error: 'This room already has eight contestants.' };

    const player = this.#newPlayer(safeName, socket);
    room.players.push(player);
    if (!room.hostId) room.hostId = player.id;
    this.#bindSeat(socket, room, player);
    return { code: room.code, token: player.token };
  }

  handleMessage(socket, raw) {
    if (Buffer.byteLength(raw) > MAX_MESSAGE_LENGTH) {
      this.#sendError(socket, 'That message was too large.');
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      this.#sendError(socket, 'The studio could not read that message.');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      this.#sendError(socket, 'The studio could not read that action.');
      return;
    }

    if (message.type === 'create') {
      const created = this.createRoom(message.name, socket);
      if (created.error) return this.#sendError(socket, created.error);
      return this.#sendRoomForSocket(socket, created.token);
    }
    if (message.type === 'join') {
      const joined = this.joinRoom(message.code, message.name, socket);
      if (joined.error) return this.#sendError(socket, joined.error);
      return this.#sendRoomForSocket(socket, joined.token);
    }
    if (message.type === 'reconnect') return this.#reconnect(message, socket);

    const seat = this.#socketSeats.get(socket);
    if (!seat) return this.#sendError(socket, 'Create or join a room first.');
    const { room, player } = seat;
    if (room.phase === 'ended' || room.game?.phase === 'complete') {
      return this.#sendError(socket, room.endedReason ?? 'This show has ended.');
    }

    if (message.type === 'start') return this.#start(room, player, socket);
    if (message.type === 'raise') return this.#action(room, player, socket, raiseBid, message.amount);
    if (message.type === 'pass') return this.#action(room, player, socket, passTurn);
    this.#sendError(socket, 'That action is not available in the studio.');
  }

  #newPlayer(name, socket) {
    return {
      id: randomBytes(8).toString('hex'),
      token: makeToken(),
      name,
      connected: true,
      socket,
      reconnectUntil: null,
    };
  }

  #bindSeat(socket, room, player) {
    this.#socketSeats.set(socket, { room, player });
    if (room.game) {
      const gamePlayer = room.game.players.find((entry) => entry.id === player.id);
      if (gamePlayer) gamePlayer.connected = true;
    }
  }

  #start(room, player, socket) {
    if (room.phase !== 'lobby' || room.game) return this.#sendError(socket, 'This room is not waiting to start.');
    if (room.hostId !== player.id) return this.#sendError(socket, 'Only the host can start the show.');
    const connectedPlayers = room.players.filter((entry) => entry.connected);
    if (connectedPlayers.length < MIN_PLAYERS || connectedPlayers.length > MAX_PLAYERS) return this.#sendError(socket, 'The show needs 2–8 connected contestants.');

    for (const player of room.players.filter((entry) => !entry.connected)) {
      const timer = room.reconnectTimers.get(player.id);
      if (timer) clearTimeout(timer);
      room.reconnectTimers.delete(player.id);
    }
    room.players = connectedPlayers;

    room.game = createGame(connectedPlayers.map(({ id, name }) => ({ id, name })));
    room.phase = 'game';
    const started = startRound(room.game);
    if (started.error) return this.#sendError(socket, started.error);
    room.game = started.game;
    this.#afterGameChange(room);
  }

  #action(room, player, socket, transition, amount) {
    if (!room.game || room.game.phase !== 'auction') return this.#sendError(socket, 'There is no active letter auction.');
    const result = transition(room.game, player.id, ...(transition === raiseBid ? [amount] : []));
    if (result.error) return this.#sendError(socket, result.error);
    room.game = result.game;
    this.#afterGameChange(room);
  }

  #afterGameChange(room) {
    this.#clearTimer(room, 'turnTimer');
    if (room.game?.phase === 'roundEnd') {
      const settled = finishRound(room.game);
      room.game = settled.game;
      if (room.game.phase === 'intermission') {
        this.#broadcast(room);
        room.roundTimer = setTimeout(() => {
          room.roundTimer = null;
          if (room.phase === 'ended' || room.game?.phase !== 'intermission') return;
          const started = startRound(room.game);
          room.game = started.game;
          this.#afterGameChange(room);
        }, ROUND_PAUSE_MS);
        return;
      }
    }

    if (room.game?.phase === 'auction') this.#scheduleTurn(room);
    this.#broadcast(room);
  }

  #scheduleTurn(room) {
    this.#clearTimer(room, 'turnTimer');
    const auction = room.game?.auction;
    if (!auction) return;
    const auctionId = auction.id;
    const turnId = auction.turnId;
    const deadline = auction.deadline;
    room.turnTimer = setTimeout(() => {
      const current = room.game?.auction;
      if (!current || current.id !== auctionId || current.turnId !== turnId || current.deadline !== deadline) return;
      const result = expireTurn(room.game, Date.now(), turnId);
      if (result.error) return;
      room.game = result.game;
      this.#afterGameChange(room);
    }, Math.max(0, deadline - Date.now()));
  }

  #disconnect(socket) {
    const seat = this.#socketSeats.get(socket);
    if (!seat) return;
    const { room, player } = seat;
    if (player.socket !== socket) return;
    player.connected = false;
    player.socket = null;
    player.reconnectUntil = Date.now() + RECONNECT_WINDOW_MS;
    if (room.game) {
      const gamePlayer = room.game.players.find((entry) => entry.id === player.id);
      if (gamePlayer) gamePlayer.connected = false;
    }

    if (room.phase === 'lobby' && room.hostId === player.id) {
      room.hostId = room.players.find((entry) => entry.connected)?.id ?? null;
    }

    const reconnectTimer = setTimeout(() => this.#expireReconnect(room, player), RECONNECT_WINDOW_MS);
    room.reconnectTimers.set(player.id, reconnectTimer);
    this.#broadcast(room);
  }

  #expireReconnect(room, player) {
    room.reconnectTimers.delete(player.id);
    if (player.connected) return;
    if (room.phase === 'lobby') {
      room.players = room.players.filter((entry) => entry.id !== player.id);
      if (room.hostId === player.id) room.hostId = room.players.find((entry) => entry.connected)?.id ?? null;
      if (room.players.length === 0) this.#rooms.delete(room.code);
    } else if (room.game && room.game.phase !== 'complete') {
      room.players = room.players.filter((entry) => entry.id !== player.id);
      room.game.players = room.game.players.filter((entry) => entry.id !== player.id);
      if (room.players.filter((entry) => entry.connected).length < MIN_PLAYERS) {
        room.phase = 'ended';
        room.endedReason = 'The show ended because fewer than two contestants remained connected.';
        this.#clearTimer(room, 'turnTimer');
        this.#clearTimer(room, 'roundTimer');
      }
    }
    this.#broadcast(room);
  }

  #reconnect(message, socket) {
    const code = cleanCode(message.code);
    const token = typeof message.token === 'string' ? message.token : '';
    const room = this.#rooms.get(code);
    const player = room?.players.find((entry) => entry.token === token);
    if (!room || !player || player.connected || player.reconnectUntil < Date.now()) {
      return this.#sendError(socket, 'That seat cannot reconnect. Create or join a room again.');
    }
    const timer = room.reconnectTimers.get(player.id);
    if (timer) clearTimeout(timer);
    room.reconnectTimers.delete(player.id);
    player.connected = true;
    player.reconnectUntil = null;
    player.socket = socket;
    this.#bindSeat(socket, room, player);
    if (room.phase === 'ended' && room.game?.phase !== 'complete') {
      room.phase = 'game';
      room.endedReason = null;
      if (room.game?.phase === 'auction') this.#scheduleTurn(room);
    }
    this.#sendRoomForSocket(socket, token);
  }

  #sendRoomForSocket(socket, token = null) {
    const seat = this.#socketSeats.get(socket);
    if (!seat) return;
    this.#send(socket, {
      type: 'room',
      room: this.#snapshot(seat.room, seat.player),
      ...(token ? { token } : {}),
    });
    this.#broadcast(seat.room, socket);
  }

  #broadcast(room, skipSocket = null) {
    for (const player of room.players) {
      const socket = player.socket;
      if (!socket || socket === skipSocket || socket.readyState !== 1) continue;
      this.#send(socket, { type: 'room', room: this.#snapshot(room, player) });
    }
  }

  #snapshot(room, viewer) {
    const game = room.game;
    const gameViewer = game?.players.find((entry) => entry.id === viewer.id);
    const auction = game?.auction;
    return {
      code: room.code,
      phase: room.phase === 'ended' ? 'ended' : publicPhase(room),
      statusMessage: room.endedReason,
      hostId: room.hostId,
      viewerId: viewer.id,
      canStart: room.phase === 'lobby' && room.hostId === viewer.id && room.players.filter((player) => player.connected).length >= MIN_PLAYERS,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        connected: player.connected,
        host: player.id === room.hostId,
      })),
      round: game?.round ?? 0,
      lotIndex: game?.lotIndex ?? -1,
      totalLots: game?.lots.length ?? 0,
      auction: auction ? {
        id: auction.id,
        letter: auction.letter,
        currentBid: auction.currentBid,
        highBidderId: auction.highBidderId,
        turnPlayerId: auction.turnOrder[auction.turnIndex] ?? null,
        turnDeadline: auction.deadline,
        turnId: auction.turnId,
        activePlayerIds: [...auction.activeIds],
      } : null,
      history: game?.history.map((item) => ({
        round: item.round,
        letter: item.letter,
        winnerId: item.winnerId,
        winnerName: room.players.find((player) => player.id === item.winnerId)?.name ?? null,
        bid: item.bid,
      })) ?? [],
      winners: game?.winnerIds.map((id) => ({ id, name: room.players.find((player) => player.id === id)?.name ?? 'Contestant' })) ?? [],
      self: gameViewer ? {
        target: [...gameViewer.target],
        matched: [...gameViewer.matched],
        cash: gameViewer.cash,
        spent: gameViewer.spent,
      } : null,
    };
  }

  #sendError(socket, message) {
    this.#send(socket, { type: 'error', message });
  }

  #send(socket, message) {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }

  #clearTimer(room, key) {
    if (room[key]) clearTimeout(room[key]);
    room[key] = null;
  }
}
