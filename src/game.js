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
    const target = [...shared, pickLetter(random), pickLetter(random), pickLetter(random), pickLetter(random)];
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
      inventory: [],
      cash: STARTING_CASH,
      spent: 0,
      completionOrder: null,
    };
  });
}

function remainingLetters(game) {
  return game.players.flatMap((player) => player.target.filter((letter, index) => !player.matched[index]));
}

export function surplusLetters(game, playerId) {
  const player = findPlayer(game, playerId);
  if (!player) return [];
  const needed = new Map();
  const owned = new Map();
  for (const letter of player.target) needed.set(letter, (needed.get(letter) ?? 0) + 1);
  for (const letter of player.inventory) owned.set(letter, (owned.get(letter) ?? 0) + 1);
  return [...owned].flatMap(([letter, count]) => Array.from({ length: Math.max(0, count - (needed.get(letter) ?? 0)) }, () => letter));
}

function findPlayer(game, playerId) {
  return game.players.find((player) => player.id === playerId);
}

function currentTurn(game) {
  return game.auction ?? game.offer;
}

function currentPlayerId(turn) {
  return turn?.turnOrder[turn.turnIndex] ?? null;
}

function setNextTurn(game, afterPlayerId, now) {
  const turn = currentTurn(game);
  if (!turn) return;
  const currentIndex = turn.turnOrder.indexOf(afterPlayerId);
  for (let step = 1; step <= turn.turnOrder.length; step += 1) {
    const nextIndex = (currentIndex + step) % turn.turnOrder.length;
    if (turn.activeIds.includes(turn.turnOrder[nextIndex])) {
      turn.turnIndex = nextIndex;
      turn.deadline = now + TURN_LENGTH_MS;
      turn.turnId += 1;
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

function awardLetter(game, player, letter) {
  player.inventory.push(letter);
  const slot = player.target.findIndex((targetLetter, index) => targetLetter === letter && !player.matched[index]);
  if (slot >= 0) {
    player.matched[slot] = true;
    rememberCompletion(game, player);
  }
  return slot >= 0;
}

function bankLot(game, now) {
  if (game.lotIndex + 1 >= game.bankLotCount || remainingLetters(game).length === 0) {
    game.phase = 'roundEnd';
    game.auction = null;
    game.offer = null;
    return;
  }

  const pool = remainingLetters(game);
  const letter = pool[Math.floor(game.random() * pool.length)];
  game.lotIndex += 1;
  game.lots.push(letter);
  const ids = [...game.roundPlayerIds];
  const startAt = (game.nextOpeningIndex + game.lotIndex) % Math.max(1, ids.length);
  const turnOrder = [...ids.slice(startAt), ...ids.slice(0, startAt)];
  game.auction = {
    id: game.nextAuctionId++,
    kind: 'bank',
    sellerId: null,
    letter,
    currentBid: 0,
    highBidderId: null,
    activeIds: [...ids],
    turnOrder,
    turnIndex: 0,
    deadline: now + TURN_LENGTH_MS,
    turnId: 1,
  };
  game.offer = null;
  game.phase = 'auction';
}

function openNextLot(game, now) {
  bankLot(game, now);
}

function offerAfterBankLot(game, now) {
  game.auction = null;
  game.offer = null;
  const count = game.marketOrder.length;
  for (let offset = 0; offset < count; offset += 1) {
    const index = (game.marketCursor + offset) % count;
    const sellerId = game.marketOrder[index];
    const seller = findPlayer(game, sellerId);
    if (game.marketOfferedIds.includes(sellerId) || !seller?.connected || surplusLetters(game, sellerId).length === 0) continue;
    game.marketCursor = (index + 1) % count;
    game.marketOfferedIds.push(sellerId);
    game.offer = {
      sellerId,
      activeIds: [sellerId],
      turnOrder: [sellerId],
      turnIndex: 0,
      deadline: now + TURN_LENGTH_MS,
      turnId: game.nextAuctionId++,
    };
    game.phase = 'offer';
    return;
  }
  openNextLot(game, now);
}

function beginMarketAuction(game, sellerId, letter, now) {
  const seller = findPlayer(game, sellerId);
  const surplus = surplusLetters(game, sellerId);
  if (!seller || !surplus.includes(letter)) return { game, error: 'You can only auction a letter you have in surplus.' };
  const ids = game.roundPlayerIds.filter((id) => id !== sellerId);
  const sellerIndex = game.roundPlayerIds.indexOf(sellerId);
  const order = [...game.roundPlayerIds.slice(sellerIndex + 1), ...game.roundPlayerIds.slice(0, sellerIndex)].filter((id) => id !== sellerId);
  game.marketLetter = letter;
  game.offer = null;
  game.auction = {
    id: game.nextAuctionId++,
    kind: 'player',
    sellerId,
    letter,
    currentBid: 0,
    highBidderId: null,
    activeIds: ids,
    turnOrder: order,
    turnIndex: 0,
    deadline: now + TURN_LENGTH_MS,
    turnId: 1,
  };
  game.phase = 'auction';
  return { game, error: null };
}

function removeSurplusLetter(game, player, letter) {
  if (!surplusLetters(game, player.id).includes(letter)) return false;
  const index = player.inventory.indexOf(letter);
  if (index < 0) return false;
  player.inventory.splice(index, 1);
  return true;
}

function settleAuction(game, now) {
  const auction = game.auction;
  if (!auction?.highBidderId) return false;
  const winner = findPlayer(game, auction.highBidderId);
  if (!winner) return false;

  const seller = auction.kind === 'player' ? findPlayer(game, auction.sellerId) : null;
  if (auction.kind === 'player' && (!seller || !removeSurplusLetter(game, seller, auction.letter))) {
    game.history.unshift({ round: game.round, letter: auction.letter, winnerId: null, sellerId: auction.sellerId, kind: 'player', bid: 0, advanced: false });
    game.history = game.history.slice(0, 12);
    openNextLot(game, now);
    return true;
  }

  winner.cash -= auction.currentBid;
  winner.spent += auction.currentBid;
  if (auction.kind === 'player') {
    seller.cash += auction.currentBid;
    const advanced = awardLetter(game, winner, auction.letter);
    game.history.unshift({ round: game.round, letter: auction.letter, winnerId: winner.id, sellerId: seller.id, kind: 'player', bid: auction.currentBid, advanced });
  } else {
    const advanced = awardLetter(game, winner, auction.letter);
    game.history.unshift({ round: game.round, letter: auction.letter, winnerId: winner.id, sellerId: null, kind: 'bank', bid: auction.currentBid, advanced });
  }
  game.history = game.history.slice(0, 12);
  if (auction.kind === 'player') openNextLot(game, now);
  else offerAfterBankLot(game, now);
  return true;
}

function finishAuctionIfResolved(game, now) {
  const auction = game.auction;
  if (!auction) return;
  if (auction.highBidderId && !findPlayer(game, auction.highBidderId)) {
    auction.highBidderId = null;
    auction.currentBid = 0;
  }
  if (auction.highBidderId && auction.activeIds.length === 1 && auction.activeIds[0] === auction.highBidderId) {
    settleAuction(game, now);
    return;
  }
  if (auction.activeIds.length === 0) {
    if (auction.highBidderId) {
      settleAuction(game, now);
      return;
    }
    game.history.unshift({ round: game.round, letter: auction.letter, winnerId: null, sellerId: auction.sellerId, kind: auction.kind, bid: 0, advanced: false });
    game.history = game.history.slice(0, 12);
    if (auction.kind === 'player') openNextLot(game, now);
    else offerAfterBankLot(game, now);
  }
}

export function createGame(players, random = Math.random) {
  return {
    phase: 'lobby',
    round: 0,
    players: buildTargets(players, random),
    roundPlayerIds: [],
    bankLotCount: 0,
    lots: [],
    lotIndex: -1,
    marketOrder: [],
    marketCursor: 0,
    marketOfferedIds: [],
    marketLetter: null,
    auction: null,
    offer: null,
    winnerIds: [],
    completionSequence: 0,
    nextAuctionId: 1,
    nextOpeningIndex: 0,
    history: [],
    random,
  };
}

export function startRound(game, random = game.random ?? Math.random, now = Date.now()) {
  if (game.phase !== 'lobby' && game.phase !== 'intermission') return { game, error: 'The next round cannot start yet.' };
  if (remainingLetters(game).length === 0) return finishRound({ ...game, phase: 'roundEnd', auction: null, offer: null });

  game.random = random;
  game.round += 1;
  game.roundPlayerIds = game.players.map((player) => player.id);
  game.bankLotCount = game.roundPlayerIds.length;
  game.lots = [];
  game.lotIndex = -1;
  const offset = (game.round - 1) % game.roundPlayerIds.length;
  game.marketOrder = [...game.roundPlayerIds.slice(offset), ...game.roundPlayerIds.slice(0, offset)];
  game.marketCursor = 0;
  game.marketOfferedIds = [];
  game.marketLetter = null;
  game.nextOpeningIndex = (game.nextOpeningIndex + (game.round > 1 ? 1 : 0)) % game.roundPlayerIds.length;
  openNextLot(game, now);
  return { game, error: null };
}

export function offerLetter(game, playerId, letter, now = Date.now()) {
  if (game.phase !== 'offer' || !game.offer) return { game, error: 'There is no surplus-letter offer turn.' };
  if (currentPlayerId(game.offer) !== playerId) return { game, error: 'It is not your turn to offer a letter.' };
  if (typeof letter !== 'string' || letter.length !== 1 || !surplusLetters(game, playerId).includes(letter)) {
    return { game, error: 'Choose one of your surplus letters.' };
  }
  return beginMarketAuction(game, playerId, letter, now);
}

export function passOffer(game, playerId, now = Date.now()) {
  if (game.phase !== 'offer' || !game.offer) return { game, error: 'There is no surplus-letter offer turn.' };
  if (currentPlayerId(game.offer) !== playerId) return { game, error: 'It is not your turn to offer a letter.' };
  openNextLot(game, now);
  return { game, error: null };
}

export function raiseBid(game, playerId, amount, now = Date.now()) {
  const auction = game.auction;
  const player = findPlayer(game, playerId);
  if (game.phase !== 'auction' || !auction) return { game, error: 'There is no active letter auction.' };
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
  if (game.phase !== 'auction' || !auction) return { game, error: 'There is no active letter auction.' };
  if (currentPlayerId(auction) !== playerId || !auction.activeIds.includes(playerId)) return { game, error: 'It is not your turn to pass.' };

  auction.activeIds = auction.activeIds.filter((id) => id !== playerId);
  if (auction.activeIds.length === 0) finishAuctionIfResolved(game, now);
  else {
    setNextTurn(game, playerId, now);
    finishAuctionIfResolved(game, now);
  }
  return { game, error: null };
}

export function expireTurn(game, now = Date.now(), expectedTurnId = currentTurn(game)?.turnId) {
  const turn = currentTurn(game);
  if (!turn || turn.turnId !== expectedTurnId || now < turn.deadline) {
    return { game, error: 'The auction turn is no longer current.' };
  }
  if (game.phase === 'offer') return passOffer(game, currentPlayerId(turn), now);
  return passTurn(game, currentPlayerId(turn), now);
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
  game.offer = null;
  return { game, error: null };
}

export const gameRules = Object.freeze({ minimumRaise: MINIMUM_RAISE, turnLengthMs: TURN_LENGTH_MS, startingCash: STARTING_CASH });
