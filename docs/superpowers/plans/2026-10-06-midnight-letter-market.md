# Midnight Letter Market Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally runnable 2–8 player browser game with room-code joining and the agreed letter-auction loop.

**Architecture:** A single Node.js process serves the browser app and owns all live room and game state. The browser connects over WebSocket; the server validates every action and sends a public room view plus a separate private view for each player. The app uses plain browser JavaScript and CSS so it starts with one command and needs no external account.

**Tech Stack:** Node.js 22, npm, `ws` for WebSocket server support, vanilla HTML/CSS/JavaScript, Node built-in HTTP and crypto modules.

**Spec:** `docs/superpowers/specs/2026-10-06-midnight-letter-market-design.md`

## Global Constraints

- A room supports 2–8 players.
- Each player receives a private six-letter multiset target and $100.
- Each round contains one letter lot per player, based on the player count at round start.
- The first bid is at least $5; each new bid must exceed the current bid by at least $5 and cannot exceed the bidder's balance.
- Each turn has an 8-second timer; timeout counts as pass.
- Every player receives income equal to $10 plus 20% of their current cash, rounded to the nearest whole dollar.
- Opponents cannot see a player's target or exact collection, and opponent cash totals are not shown in the interface.
- One self-contained Node.js application serves the browser client and handles WebSocket messages. Rooms live in server memory and are cleared when the server restarts.
- The interface uses pixel-game styling throughout and remains readable and usable on phones.

## Review Focus

- **Out-of-turn or late bid:** the server rejects it and leaves the auction unchanged; handle in `src/room-manager.js` and attempt a bid from a non-current player plus a delayed bid after the turn advances.
- **A bid above cash or below the $5 raise:** reject it without changing balance, current bid, or turn; handle in `src/game.js` and manually enter both invalid values.
- **Repeated letters in a target:** one award fills at most one matching slot, and other unmet copies remain eligible later; handle in `src/game.js` and inspect a target containing duplicate letters.
- **Private snapshot leakage:** opponent targets, exact collections, and balances are absent from every other player's payload; handle in `src/room-manager.js` and compare the two browser views.
- **Disconnect or timeout during a turn:** the turn passes once, the next eligible player acts, and a reconnect restores the same seat; handle in `src/room-manager.js` and manually refresh one player during their turn.

## File Structure

- `package.json` — start script and the single runtime dependency.
- `package-lock.json` — exact dependency versions created by `npm install`.
- `src/server.js` — static HTTP serving, WebSocket connection setup, startup address output, and process shutdown.
- `src/game.js` — target generation, auction state transitions, cash accounting, round income, and winner/tie resolution.
- `src/room-manager.js` — room codes, player tokens, connection lifecycle, timers, per-player snapshots, and broadcasts.
- `public/index.html` — accessible screen regions and controls for home, lobby, game, and results.
- `public/client.js` — browser connection, screen rendering, local player state, and user actions.
- `public/styles.css` — pixel-art visual system, responsive layout, contrast, focus states, and touch-sized controls.
- `README.md` — local startup instructions, browser URL, room sharing on the same network, and a short play-through checklist.

---

### Task 1: Create the local app shell

**Files:**
- Create: `package.json`
- Create: `src/server.js`
- Create: `public/index.html`
- Create: `public/client.js`
- Create: `public/styles.css`

**Interfaces:**
- `npm start` runs `node src/server.js`.
- `src/server.js` serves files from `public/` and listens on `0.0.0.0`, defaulting to port `3000` or `process.env.PORT`.
- The browser opens a same-origin WebSocket at `ws://<host>/ws`.

- [ ] **Step 1: Add the package manifest.** Set `type` to `module`, add the `start` script, and add only `ws` as a runtime dependency.
- [ ] **Step 2: Create the HTTP server.** Serve `index.html`, `client.js`, and `styles.css` with correct content types; return 404 for unknown files; attach a WebSocket server at `/ws`.
- [ ] **Step 3: Add the local home screen.** Include create-room and join-by-code forms with display-name inputs, a visible 2–8 player limit, and semantic labels.
- [ ] **Step 4: Wire a basic browser connection.** Connect to the same-origin `/ws` endpoint, show a clear connecting/disconnected state, and render server errors as readable text.
- [ ] **Step 5: Start the server locally.** Run `npm install` and `npm start`; print the actual local URL and available LAN IPv4 URLs to the terminal. Confirm the home screen opens at the printed local URL.

### Task 2: Implement authoritative game rules

**Files:**
- Create: `src/game.js`

**Interfaces:**
- `createGame(players, random)` returns game state with ordered players, six-letter targets, $100 balances, zero spend, and round 1.
- `startRound(game, random)` creates one lot per player present at round start and selects its letter from currently unmet target slots.
- `raiseBid(game, playerId, amount, now)` returns `{ game, error }`; valid bids update the public bid, deduct nothing until award, and set the next turn deadline.
- `passTurn(game, playerId, now)` returns `{ game, error }`; it removes the player from the current lot and advances or resolves it.
- `expireTurn(game, now)` passes the current player only when the deadline has elapsed.
- `finishRound(game)` checks target completion, applies the agreed tie-breakers, or adds rounded income before the next round.

- [ ] **Step 1: Define the state shape.** Keep target letters and collected counts on server player records; track public bids, active bidders, turn order, lot index, round size, deadlines, cash, total spent, and completion order.
- [ ] **Step 2: Generate targets and lots.** Create six-letter targets with possible repeats and shared letter demand. Choose lots from outstanding target slots; after a decoy award, preserve the unmet demand so the letter can return in a later round.
- [ ] **Step 3: Add bid and pass transitions.** Require the current player, a bid at least $5, at least $5 above the current bid, and no more than their current balance. Deduct the winner's bid only when the lot resolves.
- [ ] **Step 4: Resolve lots and rounds.** Award a matching letter to one missing slot only; track the first completion sequence; compare same-round finishers by cash, then lower total spend, then completion sequence; declare a shared win if all comparisons tie.
- [ ] **Step 5: Add income and timer transitions.** When no target is complete, add `Math.round(10 + cash * 0.2)` to each player's cash. Reject timeout events whose recorded deadline no longer matches the current turn.
- [ ] **Step 6: Manually walk the state transitions.** In a Node REPL or temporary local harness, create two players including a target with repeated letters, play a valid raise/pass sequence, try a below-minimum and over-balance bid, trigger a stale timeout, resolve one matching letter, confirm only one repeated slot fills, and reach a round-income transition. Remove any temporary harness before committing.

### Task 3: Add room codes and real-time multiplayer

**Files:**
- Create: `src/room-manager.js`
- Modify: `src/server.js`

**Interfaces:**
- `createRoom(name, socket)` returns a room code and player token.
- `joinRoom(code, name, socket)` returns a player token or a human-readable error.
- `handleMessage(socket, message)` supports `create`, `join`, `start`, `raise`, `pass`, and `reconnect` actions.
- Every broadcast contains a public room snapshot and only the receiving player's private target, progress, and cash.

- [ ] **Step 1: Create room and player records.** Generate collision-checked six-character room codes and unguessable player tokens with Node's `crypto.randomBytes`; enforce 2–8 seats.
- [ ] **Step 2: Add lobby actions.** Allow the room creator to start only with 2–8 joined players; reject start attempts from other players and joins after the game starts.
- [ ] **Step 3: Connect game transitions.** Validate JSON shape and action types, call `src/game.js`, then broadcast snapshots after every accepted action.
- [ ] **Step 4: Add turn timers.** Schedule one timeout per active turn, cancel it on a valid action, and use a turn identifier so an old timer cannot advance a later auction.
- [ ] **Step 5: Add private snapshots and reconnect.** Store a token-to-seat mapping in browser `sessionStorage`, mark disconnected players offline, allow 30 seconds for reconnect, auto-pass a disconnected active player at timeout, restore the same seat on reconnect, transfer lobby ownership to the next connected player if the creator disconnects before start, and end an active match cleanly if fewer than two players remain connected.
- [ ] **Step 6: Manually check two live clients.** Open the local URL in two browser sessions, create and join a room, start the match, attempt an out-of-turn action, place a valid bid, pass, try a stale action after the turn changes, wait through one timeout, refresh and reconnect a player, and confirm the other session sees public state changes without receiving the player's private target, progress, or balance.

### Task 4: Build the playable phone-friendly screens

**Files:**
- Modify: `public/index.html`
- Modify: `public/client.js`
- Modify: `public/styles.css`

**Interfaces:**
- Client sends the room-manager actions using JSON WebSocket messages and renders server snapshots without predicting outcomes.
- Screens are home, lobby, game, round transition, and winner; one screen is visible at a time.

- [ ] **Step 1: Implement create and join flow.** Validate display name and room-code inputs client-side for usability; rely on the server for authority; show errors beside the relevant form.
- [ ] **Step 2: Implement the lobby.** Show the room code, copy affordance, connected player list, creator-only start button, and waiting state for fewer than two players.
- [ ] **Step 3: Implement the auction table.** Show the current letter, current bid, current turn, countdown, bid controls, pass button, and recent public wins. Disable controls when it is not the local player's turn; the server remains authoritative.
- [ ] **Step 4: Implement the private player panel.** Show only the local target, matched/missing letter slots, local balance, and local total spent. Show opponents' names and connection state without their secret target, collection, or exact balance.
- [ ] **Step 5: Implement transitions and results.** Show income after a non-winning round; reveal targets and balances only after the match ends; present the winner or shared win and a create-new-room action.
- [ ] **Step 6: Apply the pixel game style.** Use a limited high-contrast palette, pixel-style borders and decorative shapes, readable system fonts, visible focus states, and buttons at least 44 CSS pixels tall. At narrow widths, stack panels and keep the current bid and action buttons in the first viewport.
- [ ] **Step 7: Manually play a full round at phone width.** Use browser responsive mode; confirm text wraps without clipping, the timer and whose-turn indicator stay visible, and all auction controls can be tapped.

### Task 5: Document and launch the local game

**Files:**
- Create: `README.md`
- Modify: `src/server.js` if startup output or graceful shutdown needs refinement.

**Interfaces:**
- `npm install` installs dependencies and `npm start` starts the game at the printed local address.
- LAN URLs are printed when a usable private IPv4 address is available.

- [ ] **Step 1: Write local setup instructions.** Include Node.js 22+, `npm install`, `npm start`, the printed URL, how to create a room, and how another device on the same network joins using the LAN URL.
- [ ] **Step 2: Add a concise manual play-through.** List create room, join with a second player, start, bid/pass, finish a round, observe income, and complete a target.
- [ ] **Step 3: Start the final local server.** Run `npm start`, capture the printed URL, and leave the process available so the user can open and test the game.
- [ ] **Step 4: Commit the completed implementation.** Commit app source, package lock, and README with message `feat: build local letter auction party game`.
