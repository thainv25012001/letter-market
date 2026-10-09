import { randomBytes } from 'node:crypto';
import { createGame, expireTurn, finishRound, offerLetter, passOffer, passTurn, raiseBid, removePlayer, startRound, surplusLetters } from './game.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const ROUND_PAUSE_MS = 2_200;
const MAX_MESSAGE_LENGTH = 4_096;

function cleanName(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 18)
    : '';
}

function uniquePlayerName(name, players) {
  const normalized = (value) => value.normalize('NFC').toLowerCase();
  const isTaken = (candidate) => players.some((player) => normalized(player.name) === normalized(candidate));
  if (!isTaken(name)) return name;

  for (let suffix = 2; ; suffix += 1) {
    const suffixText = ` ${suffix}`;
    const base = name.slice(0, 18 - suffixText.length).trimEnd();
    const candidate = `${base}${suffixText}`;
    if (!isTaken(candidate)) return candidate;
  }
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
  #clients = new Set();
  #socketSeats = new WeakMap();
  #spectatorRooms = new WeakMap();
  #lastDirectoryPayload = null;

  attach(socket) {
    this.#clients.add(socket);
    socket.send(JSON.stringify({ type: 'connected' }));
    this.#sendDirectory(socket);
    socket.on('message', (raw) => this.handleMessage(socket, raw));
    socket.on('close', () => {
      this.#clients.delete(socket);
      const watchedRoom = this.#spectatorRooms.get(socket);
      if (watchedRoom) {
        watchedRoom.spectators.delete(socket);
        this.#spectatorRooms.delete(socket);
      }
      this.#removeSeat(socket, false);
    });
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
      spectators: new Set(),
      phase: 'lobby',
      game: null,
      turnTimer: null,
      roundTimer: null,
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

    const player = this.#newPlayer(uniquePlayerName(safeName, room.players), socket);
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

    if (message.type === 'watch') return this.#watch(message, socket);
    if (message.type === 'unwatch') return this.#unwatch(socket);
    if (message.type === 'leave') return this.#leave(socket);
    if (this.#spectatorRooms.has(socket)) return this.#sendError(socket, 'Leave the watched show before taking another seat.');

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
    if (message.type === 'reconnect') return this.#sendError(socket, 'That seat has left the room. Join again from the room list.');

    const seat = this.#socketSeats.get(socket);
    if (!seat) return this.#sendError(socket, 'Create or join a room first.');
    const { room, player } = seat;
    if (room.phase === 'ended' || room.game?.phase === 'complete') {
      return this.#sendError(socket, room.endedReason ?? 'This show has ended.');
    }

    if (message.type === 'start') return this.#start(room, player, socket);
    if (message.type === 'raise') return this.#action(room, player, socket, raiseBid, message.amount);
    if (message.type === 'pass') return this.#action(room, player, socket, passTurn);
    if (message.type === 'offer') return this.#action(room, player, socket, offerLetter, message.letter, message.startingPrice);
    if (message.type === 'passOffer') return this.#action(room, player, socket, passOffer);
    this.#sendError(socket, 'That action is not available in the studio.');
  }

  #newPlayer(name, socket) {
    return {
      id: randomBytes(8).toString('hex'),
      token: makeToken(),
      name,
      connected: true,
      socket,
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

    room.players = connectedPlayers;

    room.game = createGame(connectedPlayers.map(({ id, name }) => ({ id, name })));
    room.phase = 'game';
    const started = startRound(room.game);
    if (started.error) return this.#sendError(socket, started.error);
    room.game = started.game;
    this.#afterGameChange(room);
  }

  #action(room, player, socket, transition, ...args) {
    if (!room.game) return this.#sendError(socket, 'There is no active letter auction.');
    const result = transition(room.game, player.id, ...args);
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

    if (room.game?.phase === 'auction' || room.game?.phase === 'offer') this.#scheduleTurn(room);
    this.#broadcast(room);
  }

  #scheduleTurn(room) {
    this.#clearTimer(room, 'turnTimer');
    const turn = room.game?.auction ?? room.game?.offer;
    if (!turn) return;
    const auctionId = turn.id ?? turn.turnId;
    const turnId = turn.turnId;
    const deadline = turn.deadline;
    room.turnTimer = setTimeout(() => {
      const current = room.game?.auction ?? room.game?.offer;
      if (!current || (current.id ?? current.turnId) !== auctionId || current.turnId !== turnId || current.deadline !== deadline) return;
      const result = expireTurn(room.game, Date.now(), turnId);
      if (result.error) return;
      room.game = result.game;
      this.#afterGameChange(room);
    }, Math.max(0, deadline - Date.now()));
  }

  #leave(socket) {
    if (this.#spectatorRooms.has(socket)) return this.#unwatch(socket);
    this.#removeSeat(socket, true);
  }

  #removeSeat(socket, returnToDirectory) {
    const seat = this.#socketSeats.get(socket);
    if (!seat) {
      if (returnToDirectory) this.#sendDirectory(socket);
      return;
    }
    const { room, player } = seat;
    if (player.socket !== socket) return;
    this.#socketSeats.delete(socket);
    player.connected = false;
    player.socket = null;
    room.players = room.players.filter((entry) => entry.id !== player.id);

    if (room.hostId === player.id) {
      room.hostId = room.players.find((entry) => entry.connected)?.id ?? null;
    }

    if (room.phase === 'lobby' && room.players.length === 0) this.#rooms.delete(room.code);

    if (room.game && room.game.phase !== 'complete') {
      room.game = removePlayer(room.game, player.id);
      if (room.phase !== 'lobby' && room.phase !== 'ended' && room.players.length < MIN_PLAYERS) {
        room.phase = 'ended';
        room.endedReason = 'The show ended because fewer than two contestants remained.';
        this.#clearTimer(room, 'turnTimer');
        this.#clearTimer(room, 'roundTimer');
      } else if (room.phase !== 'lobby' && room.phase !== 'ended') {
        this.#afterGameChange(room);
        return;
      }
    }

    this.#broadcast(room);
    if (returnToDirectory) this.#sendDirectory(socket);
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
    for (const socket of room.spectators) {
      if (socket.readyState !== 1) continue;
      this.#send(socket, { type: 'room', spectator: true, room: this.#snapshot(room, null) });
    }
    this.#broadcastDirectory();
  }

  #snapshot(room, viewer) {
    const game = room.game;
    const gameViewer = viewer ? game?.players.find((entry) => entry.id === viewer.id) : null;
    const auction = game?.auction;
    return {
      code: room.code,
      phase: room.phase === 'ended' ? 'ended' : publicPhase(room),
      statusMessage: room.endedReason,
      hostId: room.hostId,
      ...(viewer ? { viewerId: viewer.id } : {}),
      canStart: Boolean(viewer) && room.phase === 'lobby' && room.hostId === viewer.id && room.players.filter((player) => player.connected).length >= MIN_PLAYERS,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        connected: player.connected,
        host: player.id === room.hostId,
        letters: [...(game?.players.find((entry) => entry.id === player.id)?.inventory ?? [])],
      })),
      round: game?.round ?? 0,
      lotIndex: game?.lotIndex ?? -1,
      totalLots: game?.bankLotCount ?? 0,
      auction: auction ? {
        id: auction.id,
        kind: auction.kind,
        sellerId: auction.sellerId,
        letter: auction.letter,
        startingPrice: auction.startingPrice ?? null,
        currentBid: auction.currentBid,
        highBidderId: auction.highBidderId,
        turnPlayerId: auction.turnOrder[auction.turnIndex] ?? null,
        turnDeadline: auction.deadline,
        turnId: auction.turnId,
        activePlayerIds: [...auction.activeIds],
      } : null,
      offer: game?.offer ? {
        sellerId: game.offer.sellerId,
        turnPlayerId: game.offer.sellerId,
        turnDeadline: game.offer.deadline,
        turnId: game.offer.turnId,
      } : null,
      history: game?.history.map((item) => ({
        round: item.round,
        letter: item.letter,
        winnerId: item.winnerId,
        winnerName: room.players.find((player) => player.id === item.winnerId)?.name ?? null,
        sellerName: room.players.find((player) => player.id === item.sellerId)?.name ?? null,
        bid: item.bid,
      })) ?? [],
      winners: game?.winnerIds.map((id) => ({ id, name: room.players.find((player) => player.id === id)?.name ?? 'Contestant' })) ?? [],
      results: game?.phase === 'complete' ? game.players
        .map((player) => ({
          id: player.id,
          name: player.name,
          target: [...player.target],
          matched: [...player.matched],
          cash: player.cash,
          spent: player.spent,
          winner: game.winnerIds.includes(player.id),
          completionOrder: player.completionOrder,
        }))
        .sort((left, right) => Number(right.winner) - Number(left.winner) || right.cash - left.cash || left.spent - right.spent) : null,
      ...(viewer ? {
        self: gameViewer ? {
          target: [...gameViewer.target],
          matched: [...gameViewer.matched],
          surplusLetters: surplusLetters(game, viewer.id),
          cash: gameViewer.cash,
          spent: gameViewer.spent,
        } : null,
      } : {}),
    };
  }

  #directorySnapshot() {
    return [...this.#rooms.values()].map((room) => ({
      code: room.code,
      hostName: room.players.find((player) => player.id === room.hostId)?.name ?? 'Contestant',
      playerCount: room.players.length,
      maxPlayers: MAX_PLAYERS,
      phase: room.phase === 'lobby' ? 'lobby' : publicPhase(room),
    }));
  }

  #sendDirectory(socket) {
    const rooms = this.#directorySnapshot();
    this.#lastDirectoryPayload = JSON.stringify(rooms);
    this.#send(socket, { type: 'roomDirectory', rooms });
  }

  #broadcastDirectory() {
    const rooms = this.#directorySnapshot();
    const payload = JSON.stringify(rooms);
    if (payload === this.#lastDirectoryPayload) return;
    this.#lastDirectoryPayload = payload;

    for (const socket of this.#clients) {
      if (this.#socketSeats.has(socket) || this.#spectatorRooms.has(socket)) continue;
      this.#send(socket, { type: 'roomDirectory', rooms });
    }
  }

  #watch(message, socket) {
    if (this.#socketSeats.has(socket)) return this.#sendError(socket, 'Contestants cannot switch to spectator mode during a show.');
    const code = cleanCode(message.code);
    const room = this.#rooms.get(code);
    if (!room) return this.#sendError(socket, 'That room was not found.');
    if (room.phase === 'lobby') return this.#sendError(socket, 'That show is still waiting for contestants. Join it to play.');

    const previousRoom = this.#spectatorRooms.get(socket);
    if (previousRoom) previousRoom.spectators.delete(socket);
    room.spectators.add(socket);
    this.#spectatorRooms.set(socket, room);
    this.#send(socket, { type: 'room', spectator: true, room: this.#snapshot(room, null) });
  }

  #unwatch(socket) {
    const room = this.#spectatorRooms.get(socket);
    if (room) room.spectators.delete(socket);
    this.#spectatorRooms.delete(socket);
    this.#sendDirectory(socket);
  }

  #sendError(socket, message) {
    this.#send(socket, { type: 'error', message });
    if (!this.#socketSeats.has(socket) && !this.#spectatorRooms.has(socket)) this.#sendDirectory(socket);
  }

  #send(socket, message) {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }

  #clearTimer(room, key) {
    if (room[key]) clearTimeout(room[key]);
    room[key] = null;
  }
}
