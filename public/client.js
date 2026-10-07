const status = document.querySelector('#connection-status');
const error = document.querySelector('#form-error');
const nameInput = document.querySelector('#display-name');
const codeInput = document.querySelector('#room-code');
const homeScreen = document.querySelector('#home-screen');
const lobbyScreen = document.querySelector('#lobby-screen');
const lobbyError = document.querySelector('#lobby-error');
const playerList = document.querySelector('#player-list');
const startButton = document.querySelector('#start-game');
let connection;
let roomState;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  connection = new WebSocket(`${protocol}//${location.host}/ws`);
  connection.addEventListener('open', () => {
    status.textContent = 'Connected to the studio.';
    status.dataset.state = 'connected';
  });
  connection.addEventListener('close', () => {
    status.textContent = 'Connection lost. Reconnecting…';
    status.dataset.state = 'disconnected';
    window.setTimeout(connect, 1200);
  });
  connection.addEventListener('error', () => {
    status.textContent = 'Unable to reach the studio. Retrying…';
    status.dataset.state = 'disconnected';
  });
  connection.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      showError('The studio sent an unreadable response. Please reconnect.');
      return;
    }

    if (message.type === 'error') {
      showError(message.message ?? 'Something went wrong. Please try again.');
      return;
    }
    if (message.type === 'connected') {
      status.textContent = 'Connected to the studio.';
      status.dataset.state = 'connected';
    }
    if (message.type === 'room') {
      roomState = message.room;
      renderLobby(message.room);
    }
  });
}

function send(message) {
  if (connection?.readyState !== WebSocket.OPEN) {
    showError('The studio connection is still warming up. Try again in a moment.');
    return false;
  }
  connection.send(JSON.stringify(message));
  return true;
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

function clearError() {
  error.textContent = '';
  error.hidden = true;
  lobbyError.textContent = '';
  lobbyError.hidden = true;
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
  if (!code) {
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

function renderLobby(room) {
  homeScreen.hidden = true;
  lobbyScreen.hidden = false;
  document.querySelector('#lobby-room-code').textContent = room.code ?? '------';
  const players = room.players ?? [];
  document.querySelector('#player-count').textContent = `${players.length} / 8`;
  playerList.replaceChildren(...players.map((player) => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    const badge = document.createElement('span');
    name.textContent = player.name;
    badge.className = 'player-badge';
    badge.textContent = player.connected === false ? 'OFFLINE' : (player.host ? 'HOST' : 'READY');
    item.append(name, badge);
    return item;
  }));
  startButton.disabled = !room.canStart;
  document.querySelector('#lobby-message').textContent = players.length < 2
    ? 'Invite at least one more contestant.'
    : (room.canStart ? 'All contestants are in. The host can start.' : 'Waiting for the host to start…');
  lobbyError.textContent = '';
  lobbyError.hidden = true;
}

connect();
