const status = document.querySelector('#connection-status');
const error = document.querySelector('#form-error');
const nameInput = document.querySelector('#display-name');
const codeInput = document.querySelector('#room-code');
const roomDirectoryList = document.querySelector('#room-directory');
const roomDirectoryStatus = document.querySelector('#room-directory-status');
const homeScreen = document.querySelector('#home-screen');
const lobbyScreen = document.querySelector('#lobby-screen');
const gameScreen = document.querySelector('#game-screen');
const intermissionScreen = document.querySelector('#intermission-screen');
const resultScreen = document.querySelector('#result-screen');
const lobbyError = document.querySelector('#lobby-error');
const auctionError = document.querySelector('#auction-error');
const playerList = document.querySelector('#player-list');
const startButton = document.querySelector('#start-game');
const soundToggle = document.querySelector('#sound-toggle');
const soundToggleLabel = document.querySelector('#sound-toggle-label');
const resumeKey = 'midnight-letter-market-seat';
const soundPreferenceKey = 'letter-market-sound-enabled';
let connection;
let reconnectTimer;
let roomState;
let reconnecting = false;
let roomDirectory = [];
let directoryReceived = false;
let spectating = false;
let leavingRoom = false;
let marketOfferTurnId = null;
let selectedSurplusLetter = null;
let selectedStartingPrice = 5;
let soundEnabled = readSoundPreference();
let audioContext = null;

function readSoundPreference() {
  try {
    return localStorage.getItem(soundPreferenceKey) !== 'false';
  } catch {
    return true;
  }
}

function updateSoundToggle() {
  soundToggle.setAttribute('aria-pressed', String(soundEnabled));
  soundToggle.setAttribute('aria-label', `${soundEnabled ? 'Mute' : 'Enable'} game sounds`);
  soundToggleLabel.textContent = soundEnabled ? 'SFX ON' : 'SFX OFF';
}

function playCue(name) {
  if (!soundEnabled) return;
  const AudioContextType = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextType) return;

  try {
    audioContext ??= new AudioContextType();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  } catch {
    return;
  }

  const cues = {
    toggle: [880],
    bid: [660, 880],
    sale: [523, 659, 784],
    collect: [784, 988],
    victory: [523, 659, 784, 1047],
  };
  const notes = cues[name];
  if (!notes) return;

  const start = audioContext.currentTime;
  notes.forEach((frequency, index) => {
    const noteStart = start + index * 0.075;
    const oscillator = audioContext.createOscillator();
    const volume = audioContext.createGain();
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(frequency, noteStart);
    volume.gain.setValueAtTime(0.0001, noteStart);
    volume.gain.exponentialRampToValueAtTime(0.055, noteStart + 0.012);
    volume.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.11);
    oscillator.connect(volume);
    volume.connect(audioContext.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + 0.12);
  });
}

function prepareAudio() {
  if (!soundEnabled) return;
  const AudioContextType = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextType) return;
  try {
    audioContext ??= new AudioContextType();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  } catch {
    // Audio remains available on the next supported user interaction.
  }
}

function playRoomCues(previousRoom, nextRoom) {
  if (!previousRoom) return;
  const previousAuction = previousRoom.auction;
  const nextAuction = nextRoom.auction;
  if (previousAuction?.id === nextAuction?.id && nextAuction?.currentBid > previousAuction.currentBid) {
    playCue('bid');
  }
  if (nextAuction?.kind === 'player' && nextAuction.id !== previousAuction?.id) {
    playCue('sale');
  }

  const inventoryChanged = nextRoom.players.some((player) => {
    const previous = previousRoom.players.find((entry) => entry.id === player.id);
    return previous && JSON.stringify(previous.letters ?? []) !== JSON.stringify(player.letters ?? []);
  });
  if (nextRoom.phase === 'complete' && previousRoom.phase !== 'complete') playCue('victory');
  else if (inventoryChanged) playCue('collect');
}

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
    roomDirectory = [];
    directoryReceived = false;
    renderDirectory();
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
    renderDirectory();
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, 1200);
  });
  socket.addEventListener('error', () => {
    status.textContent = 'Unable to reach the studio. Retrying…';
    status.dataset.state = 'disconnected';
    updateConnectionChip(false);
    renderDirectory();
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
      renderDirectory();
    }
    if (message.type === 'roomDirectory') {
      const shouldReturnToRooms = spectating || leavingRoom;
      roomDirectory = Array.isArray(message.rooms) ? message.rooms : [];
      directoryReceived = true;
      if (shouldReturnToRooms) {
        spectating = false;
        leavingRoom = false;
        roomState = null;
        showScreen(homeScreen);
      }
      renderDirectory();
    }
    if (message.type === 'room') {
      reconnecting = false;
      spectating = message.spectator === true;
      if (message.token) {
        sessionStorage.setItem(resumeKey, JSON.stringify({ code: message.room.code, token: message.token }));
      }
      const previousRoom = roomState;
      roomState = message.room;
      playRoomCues(previousRoom, roomState);
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

function renderDirectory() {
  if (!roomDirectoryList || !roomDirectoryStatus) return;
  roomDirectoryList.replaceChildren();

  if (connection?.readyState !== WebSocket.OPEN) {
    roomDirectoryStatus.textContent = connection?.readyState === WebSocket.CONNECTING
      ? 'Connecting to the studio…'
      : 'Connection lost. Reconnecting…';
    roomDirectoryStatus.dataset.state = 'disconnected';
    return;
  }

  roomDirectoryStatus.dataset.state = 'connected';
  if (!directoryReceived) {
    roomDirectoryStatus.textContent = 'Loading rooms…';
    return;
  }
  if (roomDirectory.length === 0) {
    roomDirectoryStatus.textContent = 'No rooms to join or watch yet. Create one or check back soon.';
    return;
  }

  roomDirectoryStatus.textContent = `${roomDirectory.length} ${roomDirectory.length === 1 ? 'room' : 'rooms'} to join or watch.`;
  for (const room of roomDirectory) {
    const item = document.createElement('li');
    item.className = 'room-directory-item';

    const summary = document.createElement('div');
    summary.className = 'room-directory-summary';
    const code = document.createElement('strong');
    code.className = 'room-directory-code';
    code.textContent = room.code;
    const host = document.createElement('span');
    host.className = 'room-directory-host';
    host.textContent = `HOST · ${room.hostName}`;
    const seats = document.createElement('span');
    seats.className = 'room-directory-seats';
    seats.textContent = `${room.playerCount} / ${room.maxPlayers} PLAYERS`;
    const phase = document.createElement('span');
    phase.className = 'room-directory-phase';
    phase.textContent = room.phase === 'lobby' ? 'WAITING FOR PLAYERS'
      : room.phase === 'complete' ? 'SHOW COMPLETE'
        : room.phase === 'ended' ? 'SHOW ENDED'
          : room.phase === 'intermission' ? 'BETWEEN ROUNDS' : 'LIVE SHOW';
    summary.append(code, host, seats, phase);
    item.append(summary);

    let action = null;
    let label = '';
    if (room.phase === 'lobby' && room.playerCount < room.maxPlayers) {
      action = 'join';
      label = 'JOIN';
    } else if (['auction', 'offer', 'intermission'].includes(room.phase)) {
      action = 'watch';
      label = 'WATCH';
    } else if (room.phase === 'complete') {
      action = 'watch';
      label = 'VIEW RESULTS';
    } else if (room.phase === 'ended') {
      action = 'watch';
      label = 'VIEW STATUS';
    }

    if (action) {
      const button = document.createElement('button');
      button.className = 'button button-secondary room-directory-action';
      button.type = 'button';
      button.dataset.roomAction = action;
      button.dataset.roomCode = room.code;
      button.disabled = connection.readyState !== WebSocket.OPEN;
      button.textContent = label;
      item.append(button);
    } else if (room.phase === 'lobby') {
      const full = document.createElement('span');
      full.className = 'room-directory-full';
      full.textContent = 'FULL';
      item.append(full);
    }
    roomDirectoryList.append(item);
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
  document.querySelector('#private-card').hidden = spectating;
  document.querySelector('#spectator-card').hidden = !spectating;
  document.querySelector('#spectator-home-game').hidden = false;
  document.querySelector('#game-room-code').textContent = room.code;
  document.querySelector('#game-round').textContent = String(room.round).padStart(2, '0');
  document.querySelector('#lot-number').textContent = String(Math.max(1, room.lotIndex + 1));
  document.querySelector('#lot-total').textContent = String(room.totalLots);
  document.querySelector('#contestant-count').textContent = `${room.players.length} / 8`;
  const online = room.players.find((player) => player.id === room.viewerId)?.connected !== false;
  updateConnectionChip(online);
  renderContestants(room);
  renderTarget(room.self);
  renderAuction(room, spectating);
  renderHistory(room.history);
}

function renderContestants(room) {
  const list = document.querySelector('#contestant-list');
  list.replaceChildren(...room.players.map((player) => {
    const item = document.createElement('li');
    item.className = 'contestant-row';
    const name = document.createElement('span');
    const badge = document.createElement('span');
    name.textContent = player.id === room.viewerId ? `YOU · ${player.name}` : player.name;
    badge.className = 'player-badge';
    badge.textContent = !player.connected ? 'OFFLINE' : (player.host ? 'HOST' : 'IN');
    const inventory = Array.isArray(player.letters) ? player.letters : [];
    const counts = new Map();
    for (const letter of inventory) counts.set(letter, (counts.get(letter) ?? 0) + 1);
    const hand = document.createElement('span');
    hand.className = 'contestant-inventory';
    hand.textContent = inventory.length
      ? `${inventory.length} ${inventory.length === 1 ? 'LETTER' : 'LETTERS'} · ${[...counts].sort(([left], [right]) => left.localeCompare(right)).map(([letter, count]) => count > 1 ? `${letter} ×${count}` : letter).join('  ')}`
      : '0 LETTERS';
    hand.setAttribute('aria-label', inventory.length
      ? `${inventory.length} letters owned: ${[...counts].map(([letter, count]) => count > 1 ? `${letter}, ${count} copies` : letter).join(', ')}`
      : '0 letters owned');
    item.append(name, badge, hand);
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

function renderAuction(room, readOnly = spectating) {
  const auction = room.auction;
  const offer = room.offer;
  const offerPhase = room.phase === 'offer' && offer;
  const isMarketSale = auction?.kind === 'player';
  const seller = room.players.find((player) => player.id === (isMarketSale ? auction.sellerId : offer?.sellerId));
  const kind = document.querySelector('#auction-kind');
  const details = document.querySelector('#auction-details');
  const offerControls = document.querySelector('#offer-controls');
  const bidControls = document.querySelector('.bid-controls');
  const timer = document.querySelector('#turn-timer');

  kind.textContent = offerPhase || isMarketSale ? 'SURPLUS MARKET' : 'BANK LOT';
  document.querySelector('#lot-progress').hidden = Boolean(offerPhase || isMarketSale);
  details.hidden = Boolean(offerPhase);
  offerControls.hidden = readOnly || !offerPhase;
  bidControls.hidden = readOnly;

  if (offerPhase) {
    const myOffer = offer.sellerId === room.viewerId;
    if (marketOfferTurnId !== offer.turnId) {
      marketOfferTurnId = offer.turnId;
      selectedSurplusLetter = null;
      selectedStartingPrice = 5;
    }
    document.querySelector('#auction-status').textContent = myOffer
      ? 'Choose a surplus letter, set its starting price, then list it for bids.'
      : `${seller?.name ?? 'A contestant'} is choosing a surplus letter…`;
    document.querySelector('#auction-letter').textContent = '?';
    document.querySelector('#current-bid').textContent = '$0';
    document.querySelector('#high-bidder').textContent = '';
    document.querySelector('#offer-instructions').textContent = myOffer
      ? 'Choose a letter you do not need. Raise or lower its starting price before listing.'
      : 'The seller is deciding which surplus letter to offer.';
    const buttons = (myOffer ? [...new Set(room.self?.surplusLetters ?? [])] : []).map((letter) => {
      const button = document.createElement('button');
      button.className = 'button button-secondary';
      button.type = 'button';
      button.textContent = `SELL ${letter}`;
      button.setAttribute('aria-pressed', String(selectedSurplusLetter === letter));
      button.disabled = !myOffer;
      button.addEventListener('click', () => {
        selectedSurplusLetter = letter;
        renderAuction(room);
      });
      return button;
    });
    document.querySelector('#surplus-letter-buttons').replaceChildren(...buttons);
    const priceControls = document.querySelector('#starting-price-controls');
    priceControls.hidden = !myOffer || !selectedSurplusLetter;
    document.querySelector('#starting-price').textContent = formatCash(selectedStartingPrice);
    document.querySelector('#price-decrease').disabled = selectedStartingPrice <= 5;
    document.querySelector('#price-increase').disabled = selectedStartingPrice >= 1_000_000;
    const listButton = document.querySelector('#list-surplus-letter');
    listButton.disabled = !myOffer || !selectedSurplusLetter;
    listButton.textContent = `LIST FOR ${formatCash(selectedStartingPrice)}`;
    listButton.hidden = !myOffer || !selectedSurplusLetter;
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
      ? (auction.currentBid === 0 ? `Opening price ${formatCash(auction.startingPrice)} — meet it or pass.` : 'Your turn — raise to buy this letter or pass.')
      : (auction.currentBid === 0 ? 'Your turn — open the bidding or pass.' : 'Your turn — raise the bid or pass.'))
    : `${currentPlayer?.name ?? 'A contestant'} is choosing…`;
  const sellerText = isMarketSale ? ` · ${seller?.name ?? 'CONTESTANT'}` : '';
  kind.textContent = isMarketSale ? `SURPLUS SALE${sellerText}` : 'BANK LOT';
  document.querySelector('#auction-status').textContent = statusText;
  document.querySelector('#auction-letter').textContent = auction.letter;
  const hasMarketOpeningBid = isMarketSale && auction.currentBid === 0;
  document.querySelector('#bid-label').textContent = hasMarketOpeningBid ? 'STARTING PRICE' : 'CURRENT BID';
  document.querySelector('#current-bid').textContent = formatCash(hasMarketOpeningBid ? auction.startingPrice : auction.currentBid);
  document.querySelector('#high-bidder').textContent = leader ? `LEADING: ${leader.name}` : (hasMarketOpeningBid ? 'OPENING PRICE' : 'NO BIDS YET');

  const cash = room.self?.cash ?? 0;
  const increments = [5, 10, 25];
  const amounts = hasMarketOpeningBid
    ? [auction.startingPrice, auction.startingPrice + 10, auction.startingPrice + 25]
    : increments.map((increment) => auction.currentBid === 0 ? increment : auction.currentBid + increment);
  for (const [index, increment] of increments.entries()) {
    const button = document.querySelector(`#bid-${increment === 25 ? 'twenty-five' : increment === 10 ? 'ten' : 'five'}`);
    const amount = amounts[index];
    button.textContent = auction.currentBid === 0 ? `BID ${formatCash(amount)}` : `RAISE +$${increment}`;
    button.disabled = !myTurn || amount > cash;
    button.setAttribute('aria-label', `${auction.currentBid === 0 ? `Bid ${formatCash(amount)}` : `Raise by $${increment}`}${amount > cash ? ', exceeds your balance' : ''}`);
    button.onclick = () => send({ type: 'raise', amount });
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
  const balance = document.querySelector('#income-balance');
  balance.hidden = spectating;
  document.querySelector('#spectator-home-intermission').hidden = false;
  document.querySelector('#income-cash').textContent = formatCash(room.self?.cash ?? 0);
  document.querySelector('#income-message').textContent = spectating
    ? 'The contestants are between rounds. The next auction will begin shortly.'
    : 'Your balance grew. Use it wisely in the next round.';
  document.querySelector('#intermission-status').textContent = spectating
    ? 'Live show · spectator view'
    : 'Next round starting soon…';
}

function renderResults(room) {
  showScreen(resultScreen);
  document.querySelector('#spectator-home-results').hidden = !spectating;
  document.querySelector('#new-room').hidden = spectating;
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

soundToggle.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  try {
    localStorage.setItem(soundPreferenceKey, String(soundEnabled));
  } catch {
    // Sound can still be toggled for this page session if storage is unavailable.
  }
  updateSoundToggle();
  if (soundEnabled) playCue('toggle');
});
updateSoundToggle();
document.addEventListener('pointerdown', prepareAudio, { once: true });
document.addEventListener('keydown', prepareAudio, { once: true });

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

roomDirectoryList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-room-action]');
  if (!button || !roomDirectoryList.contains(button)) return;
  if (connection?.readyState !== WebSocket.OPEN) {
    renderDirectory();
    return;
  }

  const { roomAction, roomCode } = button.dataset;
  if (roomAction === 'join') {
    const name = displayName();
    if (!name) return;
    send({ type: 'join', name, code: roomCode });
  } else if (roomAction === 'watch') {
    send({ type: 'watch', code: roomCode });
  }
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
for (const button of document.querySelectorAll('.room-exit')) {
  button.addEventListener('click', () => {
    if (spectating) {
      send({ type: 'unwatch' });
      return;
    }

    sessionStorage.removeItem(resumeKey);
    leavingRoom = true;
    if (!send({ type: 'leave' })) leavingRoom = false;
  });
}
document.querySelector('#pass-bid').addEventListener('click', () => send({ type: 'pass' }));
document.querySelector('#pass-offer').addEventListener('click', () => send({ type: 'passOffer' }));
document.querySelector('#price-decrease').addEventListener('click', () => {
  selectedStartingPrice = Math.max(5, selectedStartingPrice - 5);
  if (roomState) renderAuction(roomState);
});
document.querySelector('#price-increase').addEventListener('click', () => {
  selectedStartingPrice = Math.min(1_000_000, selectedStartingPrice + 5);
  if (roomState) renderAuction(roomState);
});
document.querySelector('#list-surplus-letter').addEventListener('click', () => {
  if (!selectedSurplusLetter) return;
  send({ type: 'offer', letter: selectedSurplusLetter, startingPrice: selectedStartingPrice });
});

setInterval(() => {
  if (!gameScreen.hidden && (roomState?.phase === 'auction' || roomState?.phase === 'offer')) {
    const turnDeadline = roomState.phase === 'offer' ? roomState.offer?.turnDeadline : roomState.auction?.turnDeadline;
    if (turnDeadline) document.querySelector('#turn-timer').textContent = String(Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000)));
  }
}, 250);

connect();
