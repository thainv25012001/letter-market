const status = document.querySelector('#connection-status');
const error = document.querySelector('#form-error');
const nameInput = document.querySelector('#display-name');
const codeInput = document.querySelector('#room-code');
const homeScreen = document.querySelector('#home-screen');
const lobbyScreen = document.querySelector('#lobby-screen');
const gameScreen = document.querySelector('#game-screen');
const intermissionScreen = document.querySelector('#intermission-screen');
const resultScreen = document.querySelector('#result-screen');
const lobbyError = document.querySelector('#lobby-error');
const auctionError = document.querySelector('#auction-error');
const playerList = document.querySelector('#player-list');
const startButton = document.querySelector('#start-game');
const resumeKey = 'midnight-letter-market-seat';
let connection;
let reconnectTimer;
let roomState;
let reconnecting = false;

function readResume() {
  try {
    return JSON.parse(sessionStorage.getItem(resumeKey) ?? 'null');
  } catch {
    sessionStorage.removeItem(resumeKey);
    return null;
  }
}

function connect() {
  if (connection && (connection.readyState === WebSocket.CONNECTING || connection.readyState === WebSocket.OPEN)) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  connection = socket;
  socket.addEventListener('open', () => {
    if (connection !== socket) return;
    status.textContent = 'Connected to the studio.';
    status.dataset.state = 'connected';
    const resume = readResume();
    if (resume?.code && resume?.token) {
      reconnecting = true;
      socket.send(JSON.stringify({ type: 'reconnect', code: resume.code, token: resume.token }));
    }
  });
  socket.addEventListener('close', () => {
    if (connection !== socket) return;
    status.textContent = 'Connection lost. Reconnecting…';
    status.dataset.state = 'disconnected';
    updateConnectionChip(false);
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, 1200);
  });
  socket.addEventListener('error', () => {
    status.textContent = 'Unable to reach the studio. Retrying…';
    status.dataset.state = 'disconnected';
    updateConnectionChip(false);
  });
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      showError('The studio sent an unreadable response. Please reconnect.');
      return;
    }

    if (message.type === 'error') {
      if (reconnecting) {
        sessionStorage.removeItem(resumeKey);
        reconnecting = false;
        roomState = null;
        showScreen(homeScreen);
      }
      showError(message.message ?? 'Something went wrong. Please try again.');
      return;
    }
    if (message.type === 'connected') {
      status.textContent = 'Connected to the studio.';
      status.dataset.state = 'connected';
      updateConnectionChip(true);
    }
    if (message.type === 'room') {
      reconnecting = false;
      if (message.token) {
        sessionStorage.setItem(resumeKey, JSON.stringify({ code: message.room.code, token: message.token }));
      }
      roomState = message.room;
      renderRoom(message.room);
    }
  });
}

function send(message) {
  if (connection?.readyState !== WebSocket.OPEN) {
    showError('The studio connection is still warming up. Try again in a moment.');
    return false;
  }
  clearError();
  connection.send(JSON.stringify(message));
  return true;
}

function showError(message) {
  const destination = !homeScreen.hidden ? error : (!gameScreen.hidden ? auctionError : lobbyError);
  destination.textContent = message;
  destination.hidden = false;
}

function clearError() {
  for (const element of [error, lobbyError, auctionError]) {
    element.textContent = '';
    element.hidden = true;
  }
}

function displayName() {
  const value = nameInput.value.trim();
  if (!value) {
    nameInput.focus();
    showError('Add an on-air name to join the show.');
    return null;
  }
  return value;
}

function showScreen(active) {
  for (const screen of [homeScreen, lobbyScreen, gameScreen, intermissionScreen, resultScreen]) {
    screen.hidden = screen !== active;
  }
}

function renderRoom(room) {
  clearError();
  if (room.phase === 'lobby') {
    renderLobby(room);
  } else if (room.phase === 'auction' || room.phase === 'offer') {
    renderGame(room);
  } else if (room.phase === 'intermission') {
    renderIntermission(room);
  } else {
    renderResults(room);
  }
}

function renderLobby(room) {
  showScreen(lobbyScreen);
  document.querySelector('#lobby-room-code').textContent = room.code;
  document.querySelector('#player-count').textContent = `${room.players.length} / 8`;
  playerList.replaceChildren(...room.players.map((player) => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    const badge = document.createElement('span');
    name.textContent = player.name;
    badge.className = 'player-badge';
    badge.textContent = !player.connected ? 'OFFLINE' : (player.host ? 'HOST' : 'READY');
    item.append(name, badge);
    return item;
  }));
  startButton.disabled = !room.canStart;
  document.querySelector('#lobby-message').textContent = room.players.filter((player) => player.connected).length < 2
    ? 'Invite at least one more connected contestant.'
    : (room.canStart ? 'All contestants are in. The host can start.' : 'Waiting for the host to start…');
  if (room.statusMessage) showError(room.statusMessage);
}

function renderGame(room) {
  showScreen(gameScreen);
  document.querySelector('#game-room-code').textContent = room.code;
  document.querySelector('#game-round').textContent = String(room.round).padStart(2, '0');
  document.querySelector('#lot-number').textContent = String(Math.max(1, room.lotIndex + 1));
  document.querySelector('#lot-total').textContent = String(room.totalLots);
  document.querySelector('#contestant-count').textContent = `${room.players.length} / 8`;
  const online = room.players.find((player) => player.id === room.viewerId)?.connected !== false;
  updateConnectionChip(online);
  renderContestants(room);
  renderTarget(room.self);
  renderAuction(room);
  renderHistory(room.history);
}

function renderContestants(room) {
  const list = document.querySelector('#contestant-list');
  list.replaceChildren(...room.players.map((player) => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    const badge = document.createElement('span');
    name.textContent = player.id === room.viewerId ? `YOU · ${player.name}` : player.name;
    badge.className = 'player-badge';
    badge.textContent = !player.connected ? 'OFFLINE' : (player.host ? 'HOST' : 'IN');
    item.append(name, badge);
    return item;
  }));
}

function renderTarget(self) {
  if (!self) return;
  const target = document.querySelector('#target-letters');
  target.replaceChildren(...self.target.map((letter, index) => {
    const slot = document.createElement('span');
    slot.className = `target-slot${self.matched[index] ? ' matched' : ''}`;
    slot.textContent = letter;
    slot.setAttribute('aria-label', `${letter}, ${self.matched[index] ? 'collected' : 'still needed'}`);
    return slot;
  }));
  const matchedCount = self.matched.filter(Boolean).length;
  document.querySelector('#target-progress').textContent = `${matchedCount} / ${self.target.length}`;
  document.querySelector('#player-cash').textContent = formatCash(self.cash);
  document.querySelector('#player-spent').textContent = formatCash(self.spent);
  document.querySelector('#surplus-letters').textContent = self.surplusLetters?.length ? self.surplusLetters.join(' · ') : 'NONE';
}

function renderAuction(room) {
  const auction = room.auction;
  const offer = room.offer;
  const offerPhase = room.phase === 'offer' && offer;
  const isMarketSale = auction?.kind === 'player';
  const seller = room.players.find((player) => player.id === (isMarketSale ? auction.sellerId : offer?.sellerId));
  const kind = document.querySelector('#auction-kind');
  const details = document.querySelector('#auction-details');
  const offerControls = document.querySelector('#offer-controls');
  const timer = document.querySelector('#turn-timer');

  kind.textContent = offerPhase || isMarketSale ? 'SURPLUS MARKET' : 'BANK LOT';
  document.querySelector('#lot-progress').hidden = Boolean(offerPhase || isMarketSale);
  details.hidden = Boolean(offerPhase);
  offerControls.hidden = !offerPhase;

  if (offerPhase) {
    const myOffer = offer.sellerId === room.viewerId;
    document.querySelector('#auction-status').textContent = myOffer
      ? 'Your turn — sell one surplus letter or pass.'
      : `${seller?.name ?? 'A contestant'} is choosing a surplus letter…`;
    document.querySelector('#auction-letter').textContent = '?';
    document.querySelector('#current-bid').textContent = '$0';
    document.querySelector('#high-bidder').textContent = '';
    document.querySelector('#offer-instructions').textContent = myOffer
      ? 'Choose one letter you do not need to put up for auction.'
      : 'The seller is deciding which surplus letter to offer.';
    const buttons = (myOffer ? [...new Set(room.self?.surplusLetters ?? [])] : []).map((letter) => {
      const button = document.createElement('button');
      button.className = 'button button-secondary';
      button.type = 'button';
      button.textContent = `SELL ${letter}`;
      button.disabled = !myOffer;
      button.addEventListener('click', () => send({ type: 'offer', letter }));
      return button;
    });
    document.querySelector('#surplus-letter-buttons').replaceChildren(...buttons);
    document.querySelector('#pass-offer').disabled = !myOffer;
    timer.textContent = String(Math.max(0, Math.ceil((offer.turnDeadline - Date.now()) / 1000)));
    return;
  }

  if (!auction) return;
  const currentPlayer = room.players.find((player) => player.id === auction.turnPlayerId);
  const leader = room.players.find((player) => player.id === auction.highBidderId);
  const myTurn = auction.turnPlayerId === room.viewerId;
  const statusText = myTurn
    ? (isMarketSale
      ? (auction.currentBid === 0 ? 'Your turn — bid for this surplus letter or pass.' : 'Your turn — raise to buy this letter or pass.')
      : (auction.currentBid === 0 ? 'Your turn — open the bidding or pass.' : 'Your turn — raise the bid or pass.'))
    : `${currentPlayer?.name ?? 'A contestant'} is choosing…`;
  const sellerText = isMarketSale ? ` · ${seller?.name ?? 'CONTESTANT'}` : '';
  kind.textContent = isMarketSale ? `SURPLUS SALE${sellerText}` : 'BANK LOT';
  document.querySelector('#auction-status').textContent = statusText;
  document.querySelector('#auction-letter').textContent = auction.letter;
  document.querySelector('#current-bid').textContent = formatCash(auction.currentBid);
  document.querySelector('#high-bidder').textContent = leader ? `LEADING: ${leader.name}` : 'NO BIDS YET';

  const cash = room.self?.cash ?? 0;
  for (const increment of [5, 10, 25]) {
    const button = document.querySelector(`#bid-${increment === 25 ? 'twenty-five' : increment === 10 ? 'ten' : 'five'}`);
    const amount = Math.max(5, auction.currentBid + increment);
    button.textContent = auction.currentBid === 0 ? `BID $${increment}` : `RAISE +$${increment}`;
    button.disabled = !myTurn || amount > cash;
    button.setAttribute('aria-label', `${auction.currentBid === 0 ? 'Bid' : 'Raise by'} $${increment}${amount > cash ? ', exceeds your balance' : ''}`);
  }
  document.querySelector('#pass-bid').disabled = !myTurn;
  timer.textContent = String(Math.max(0, Math.ceil((auction.turnDeadline - Date.now()) / 1000)));
}

function renderHistory(history = []) {
  const list = document.querySelector('#auction-history');
  if (history.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-history';
    empty.textContent = 'No lots sold yet.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...history.slice(0, 6).map((item) => {
    const row = document.createElement('li');
    const letter = document.createElement('span');
    const winner = document.createElement('span');
    const bid = document.createElement('span');
    letter.className = 'history-letter';
    winner.className = 'history-name';
    bid.className = 'history-bid';
    letter.textContent = item.letter;
    winner.textContent = item.sellerName ? `${item.sellerName} → ${item.winnerName ?? 'UNSOLD'}` : (item.winnerName ?? 'UNSOLD');
    bid.textContent = item.winnerName ? formatCash(item.bid) : '—';
    row.append(letter, winner, bid);
    return row;
  }));
}

function renderIntermission(room) {
  showScreen(intermissionScreen);
  document.querySelector('#income-cash').textContent = formatCash(room.self?.cash ?? 0);
  document.querySelector('#income-message').textContent = 'Your balance grew. Use it wisely in the next round.';
}

function renderResults(room) {
  showScreen(resultScreen);
  const winners = room.winners ?? [];
  document.querySelector('#result-title').textContent = room.phase === 'ended' ? 'Show paused' : 'Show complete';
  document.querySelector('#result-message').textContent = room.statusMessage
    ?? (winners.length > 1 ? `It's a shared win for ${winners.map((winner) => winner.name).join(' and ')}!` : `${winners[0]?.name ?? 'A contestant'} wins the Letter Market!`);
  const results = room.results ?? [];
  document.querySelector('#final-results').replaceChildren(...results.map((result, index) => {
    const row = document.createElement('li');
    const rank = document.createElement('span');
    const contestant = document.createElement('span');
    const score = document.createElement('span');
    const name = document.createElement('strong');
    const target = document.createElement('span');
    rank.className = 'result-rank';
    contestant.className = 'result-contestant';
    target.className = 'result-target';
    score.className = 'result-score';
    rank.textContent = result.winner ? '★' : String(index + 1).padStart(2, '0');
    name.textContent = `${result.name}${result.winner ? ' · WINNER' : ''}`;
    target.textContent = `TARGET ${result.target.join('')}`;
    score.textContent = `${formatCash(result.cash)} · SPENT ${formatCash(result.spent)}`;
    contestant.append(name, target);
    row.append(rank, contestant, score);
    return row;
  }));
}

function formatCash(amount) {
  return `$${Math.round(amount ?? 0).toLocaleString('en-US')}`;
}

function updateConnectionChip(isConnected) {
  const chip = document.querySelector('#game-connection');
  if (!chip) return;
  chip.classList.toggle('offline', !isConnected);
  chip.innerHTML = `<span class="live-dot"></span> ${isConnected ? 'CONNECTED' : 'RECONNECTING'}`;
}

document.querySelector('#create-room').addEventListener('click', () => {
  clearError();
  const name = displayName();
  if (name) send({ type: 'create', name });
});

document.querySelector('#join-room').addEventListener('click', () => {
  clearError();
  const name = displayName();
  const code = codeInput.value.trim().toUpperCase();
  if (!name) return;
  if (code.length !== 6) {
    codeInput.focus();
    showError('Enter the six-character room code.');
    return;
  }
  send({ type: 'join', name, code });
});

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
});

document.querySelector('#copy-room-code').addEventListener('click', async () => {
  if (!roomState?.code) return;
  try {
    await navigator.clipboard.writeText(roomState.code);
    document.querySelector('#copy-room-code').textContent = 'COPIED';
  } catch {
    document.querySelector('#lobby-message').textContent = 'Select and copy the code above to invite players.';
  }
});

startButton.addEventListener('click', () => send({ type: 'start' }));
document.querySelector('#bid-five').addEventListener('click', () => submitBid(5));
document.querySelector('#bid-ten').addEventListener('click', () => submitBid(10));
document.querySelector('#bid-twenty-five').addEventListener('click', () => submitBid(25));
document.querySelector('#pass-bid').addEventListener('click', () => send({ type: 'pass' }));
document.querySelector('#pass-offer').addEventListener('click', () => send({ type: 'passOffer' }));

function submitBid(increment) {
  const auction = roomState?.auction;
  if (!auction) return;
  const amount = auction.currentBid === 0 ? increment : auction.currentBid + increment;
  send({ type: 'raise', amount });
}

document.querySelector('#new-room').addEventListener('click', () => {
  sessionStorage.removeItem(resumeKey);
  roomState = null;
  showScreen(homeScreen);
  if (connection?.readyState === WebSocket.OPEN) connection.close();
  status.textContent = 'Returning to the studio desk…';
});

setInterval(() => {
  if (!gameScreen.hidden && (roomState?.phase === 'auction' || roomState?.phase === 'offer')) {
    const turnDeadline = roomState.phase === 'offer' ? roomState.offer?.turnDeadline : roomState.auction?.turnDeadline;
    if (turnDeadline) document.querySelector('#turn-timer').textContent = String(Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000)));
  }
}, 250);

connect();
