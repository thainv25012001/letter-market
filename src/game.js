const STARTING_CASH = 100;
const MINIMUM_RAISE = 5;
const TURN_LENGTH_MS = 8_000;
const COMMON_LETTERS = ['E', 'A', 'R', 'I', 'O', 'T', 'N', 'S', 'L', 'C', 'U', 'D', 'G', 'P', 'M', 'H', 'B', 'Y', 'F', 'V', 'K', 'W', 'Z', 'X', 'J', 'Q'];

function pickLetter(random) {
  return COMMON_LETTERS[Math.floor(random() * COMMON_LETTERS.length)];
}

function buildTargets(players, random) {
  const shared = [pickLetter(random), pickLetter(random)];
  const seen = new Set();
  return players.map((player) => {
    let target = [...shared, pickLetter(random), pickLetter(random), pickLetter(random), pickLetter(random)];
    let key = [...target].sort().join('');
    if (seen.has(key)) {
      for (const candidate of COMMON_LETTERS) {
        if (!target.includes(candidate)) {
          target[5] = candidate;
          key = [...target].sort().join('');
          if (!seen.has(key)) break;
        }
      }
    }
    seen.add(key);
    return {
      id: player.id,
      name: player.name,
      connected: true,
      target,
      matched: Array(target.length).fill(false),
      cash: STARTING_CASH,
      spent: 0,
      completionOrder: null,
    };
  });
}

function remainingLetters(game) {
  return game.players.flatMap((player) => player.target.filter((letter, index) => !player.matched[index]));
}

function findPlayer(game, playerId) {
  return game.players.find((player) => player.id === playerId);
}

function currentPlayerId(auction) {
  return auction?.turnOrder[auction.turnIndex] ?? null;
}

function setNextTurn(game, afterPlayerId, now) {
  const auction = game.auction;
  if (!auction) return;
  const currentIndex = auction.turnOrder.indexOf(afterPlayerId);
  for (let step = 1; step <= auction.turnOrder.length; step += 1) {
    const nextIndex = (currentIndex + step) % auction.turnOrder.length;
    if (auction.activeIds.includes(auction.turnOrder[nextIndex])) {
      auction.turnIndex = nextIndex;
      auction.deadline = now + TURN_LENGTH_MS;
      auction.turnId += 1;
      return;
    }
  }
}

function rememberCompletion(game, player) {
  if (player.completionOrder === null && player.matched.every(Boolean)) {
    game.completionSequence += 1;
    player.completionOrder = game.completionSequence;
  }
}

function openNextLot(game, now) {
  game.lotIndex += 1;
  if (game.lotIndex >= game.lots.length) {
    game.phase = 'roundEnd';
    game.auction = null;
    return;
  }

  const letter = game.lots[game.lotIndex];
  const ids = [...game.roundPlayerIds];
  const startAt = (game.nextOpeningIndex + game.lotIndex) % Math.max(1, ids.length);
  const turnOrder = [...ids.slice(startAt), ...ids.slice(0, startAt)];
  game.auction = {
    id: game.nextAuctionId++,
    letter,
    currentBid: 0,
    highBidderId: null,
    activeIds: [...ids],
    turnOrder,
    turnIndex: 0,
    deadline: now + TURN_LENGTH_MS,
    turnId: 1,
  };
  game.phase = 'auction';
}

function awardCurrentLot(game, now) {
  const auction = game.auction;
  if (!auction || !auction.highBidderId) return false;
  const winner = findPlayer(game, auction.highBidderId);
  if (!winner) return false;

  winner.cash -= auction.currentBid;
  winner.spent += auction.currentBid;
  const slot = winner.target.findIndex((letter, index) => letter === auction.letter && !winner.matched[index]);
  if (slot >= 0) {
    winner.matched[slot] = true;
    rememberCompletion(game, winner);
  }
  game.history.unshift({
    round: game.round,
    letter: auction.letter,
    winnerId: winner.id,
    bid: auction.currentBid,
    advanced: slot >= 0,
  });
  game.history = game.history.slice(0, 12);
  openNextLot(game, now);
  return true;
}

function finishAuctionIfResolved(game, now) {
  const auction = game.auction;
  if (!auction) return;
  if (auction.highBidderId && auction.activeIds.length === 1) {
    awardCurrentLot(game, now);
    return;
  }
  if (auction.activeIds.length === 0) openNextLot(game, now);
}

export function createGame(players, random = Math.random) {
  return {
    phase: 'lobby',
    round: 0,
    players: buildTargets(players, random),
    roundPlayerIds: [],
    lots: [],
    lotIndex: -1,
    auction: null,
    winnerIds: [],
    completionSequence: 0,
    nextAuctionId: 1,
    nextOpeningIndex: 0,
    history: [],
  };
}

export function startRound(game, random = Math.random, now = Date.now()) {
  if (game.phase !== 'lobby' && game.phase !== 'intermission') return { game, error: 'The next round cannot start yet.' };
  const pool = remainingLetters(game);
  if (pool.length === 0) {
    return finishRound({ ...game, phase: 'roundEnd', lots: [], auction: null });
  }

  game.round += 1;
  game.roundPlayerIds = game.players.map((player) => player.id);
  game.lots = Array.from({ length: game.roundPlayerIds.length }, () => pool[Math.floor(random() * pool.length)]);
  game.lotIndex = -1;
  game.nextOpeningIndex = (game.nextOpeningIndex + (game.round > 1 ? 1 : 0)) % game.roundPlayerIds.length;
  openNextLot(game, now);
  return { game, error: null };
}

export function raiseBid(game, playerId, amount, now = Date.now()) {
  const auction = game.auction;
  const player = findPlayer(game, playerId);
  if (game.phase !== 'auction' || !auction) return { game, error: 'There is no active auction.' };
  if (!player || currentPlayerId(auction) !== playerId || !auction.activeIds.includes(playerId)) return { game, error: 'It is not your turn to bid.' };
  if (!Number.isSafeInteger(amount) || amount < MINIMUM_RAISE || amount < auction.currentBid + MINIMUM_RAISE) {
    return { game, error: `Raise by at least $${MINIMUM_RAISE}.` };
  }
  if (amount > player.cash) return { game, error: 'That bid is higher than your balance.' };

  auction.currentBid = amount;
  auction.highBidderId = playerId;
  setNextTurn(game, playerId, now);
  finishAuctionIfResolved(game, now);
  return { game, error: null };
}

export function passTurn(game, playerId, now = Date.now()) {
  const auction = game.auction;
  if (game.phase !== 'auction' || !auction) return { game, error: 'There is no active auction.' };
  if (currentPlayerId(auction) !== playerId || !auction.activeIds.includes(playerId)) return { game, error: 'It is not your turn to pass.' };

  auction.activeIds = auction.activeIds.filter((id) => id !== playerId);
  if (auction.activeIds.length === 0) {
    game.history.unshift({ round: game.round, letter: auction.letter, winnerId: null, bid: 0, advanced: false });
    game.history = game.history.slice(0, 12);
    openNextLot(game, now);
  } else {
    setNextTurn(game, playerId, now);
    finishAuctionIfResolved(game, now);
  }
  return { game, error: null };
}

export function expireTurn(game, now = Date.now(), expectedTurnId = game.auction?.turnId) {
  const auction = game.auction;
  if (game.phase !== 'auction' || !auction || auction.turnId !== expectedTurnId || now < auction.deadline) {
    return { game, error: 'The auction turn is no longer current.' };
  }
  return passTurn(game, currentPlayerId(auction), now);
}

export function finishRound(game) {
  if (game.phase !== 'roundEnd') return { game, error: 'The round is still in progress.' };
  const completed = game.players.filter((player) => player.completionOrder !== null);
  if (completed.length > 0) {
    const highestCash = Math.max(...completed.map((player) => player.cash));
    let finalists = completed.filter((player) => player.cash === highestCash);
    const lowestSpend = Math.min(...finalists.map((player) => player.spent));
    finalists = finalists.filter((player) => player.spent === lowestSpend);
    const firstFinish = Math.min(...finalists.map((player) => player.completionOrder));
    finalists = finalists.filter((player) => player.completionOrder === firstFinish);
    game.winnerIds = finalists.map((player) => player.id);
    game.phase = 'complete';
    return { game, error: null };
  }

  for (const player of game.players) player.cash += Math.round(10 + player.cash * 0.2);
  game.phase = 'intermission';
  game.auction = null;
  return { game, error: null };
}

export const gameRules = Object.freeze({ minimumRaise: MINIMUM_RAISE, turnLengthMs: TURN_LENGTH_MS, startingCash: STARTING_CASH });
