# Public Room Lobby and Spectator Viewing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players discover and join waiting rooms on the same server, and watch started rooms without joining the match or seeing private player data.

**Architecture:** Extend the existing WebSocket room manager with public directory snapshots and a separate spectator subscription that never creates a player seat. Add the directory to the home screen and make the existing game views spectator-aware, preserving the current private snapshots for contestants and the current room-code join path.

**Tech Stack:** Node.js 22, `ws`, vanilla browser JavaScript, HTML, and CSS.

**Spec:** `docs/superpowers/specs/2026-10-09-public-room-lobby-design.md`

## Global Constraints

- A waiting room with an available seat can be joined directly from the list. Joining by room code remains available.
- A room whose match has started can be opened in read-only spectator mode.
- Spectators do not occupy one of the room's 2–8 contestant seats and cannot make game actions.
- Room state and the directory update in real time over the existing WebSocket connection.
- Public room and spectator data must not expose targets, balances, or other player-specific fields.
- Completed or ended rooms remain viewable while they remain in memory, using the existing results or ended state.
- Lobby occupancy uses the room's reserved player seats, including disconnected seats during the existing reconnect window.
- Directory discovery is limited to rooms in the current server process; the server clears rooms when it restarts.

## Review Focus

- **Stale room selection:** A room starts or fills after a directory snapshot; the server rejects the stale join/watch request and returns an updated directory. Manually exercise a join and watch request against a room whose phase changed after its last list update.
- **Private data in spectator payloads:** A spectator sees no target, cash, spend, surplus choices, or private progress during a live game. Inspect the received live room state while watching.
- **Spectator actions and capacity:** A spectator cannot start, bid, pass, or offer a letter and does not change room player counts or start eligibility. Try those actions from a spectator connection and compare the room roster before and after.
- **Reserved disconnected seats:** A disconnected player keeps their lobby seat during the reconnect grace period, so the directory does not offer a join that the server would reject for capacity. Inspect the list at full capacity while one contestant is temporarily disconnected.
- **Terminal and navigation states:** Empty directory, completed room, ended room, and leaving a watched show all render without stale private panels or a stuck spectator subscription. Manually visit each state and return to the directory.

---

### Task 1: Add room directory delivery and spectator subscriptions

**Files:**
- Modify: `src/room-manager.js`

**Interfaces:**
- Consumes: Existing `RoomManager.attach`, `#snapshot`, `#broadcast`, room lifecycle, and room action handlers.
- Produces: WebSocket messages `{ type: "roomDirectory", rooms: RoomSummary[] }`; `{ type: "watch", code }`; `{ type: "unwatch" }`; and spectator room messages `{ type: "room", spectator: true, room: PublicRoomSnapshot }`.
- `RoomSummary` contains `code`, `hostName`, `playerCount`, `maxPlayers: 8`, and a public `phase` string.
- `PublicRoomSnapshot` omits `viewerId` and `self`. It includes only public player fields and the existing public auction, roster, history, and post-match results fields.

- [ ] **Step 1: Track connected sockets and spectator membership.** Add private `#clients = new Set()` and `#spectatorRooms = new WeakMap()` fields. Add `spectators: new Set()` to each room record. In `attach`, add the socket to `#clients`, send the existing `connected` message and an initial directory snapshot, then on close remove it from `#clients`, remove it from its watched room if present, and run the existing player disconnect flow.
- [ ] **Step 2: Build privacy-safe directory summaries.** Add `#directorySnapshot()` returning rooms in `#rooms` insertion order with only the summary fields in the interface. Derive `hostName` from `room.players.find(player => player.id === room.hostId)?.name ?? "Contestant"`, `playerCount` from `room.players.length` so reconnect-reserved seats count, and `phase` from `room.phase === "lobby" ? "lobby" : publicPhase(room)`.
- [ ] **Step 3: Send directory changes only when summaries change.** Add `#sendDirectory(socket)` for initial delivery and `#broadcastDirectory()` for updates. Cache the last serialized directory payload; when it changes, send it only to sockets that have neither a player seat nor a spectator subscription. Call the broadcast helper from the existing room broadcast path so create, join, disconnect, expiration, start, match phase changes, and room removal are covered without sending a directory update for every bid when its summaries are unchanged.
- [ ] **Step 4: Add watch and unwatch message handling.** Handle `watch` and `unwatch` before the normal player-seat action gate. For `watch`, clean the code, reject missing rooms and lobby rooms, remove any previous spectator subscription, add the socket to `room.spectators`, and send a public-only room snapshot with `spectator: true`. For `unwatch`, remove the socket from its room's spectator set and weak map, then send its current directory snapshot. Reject create, join, or game actions while a socket is watching until it sends `unwatch`.
- [ ] **Step 5: Separate public snapshots from player snapshots.** Change `#snapshot(room, viewer)` to omit `viewerId` when `viewer` is null and omit `self` when no game viewer exists. Compute `gameViewer` as `viewer ? game?.players.find(entry => entry.id === viewer.id) : null` so a public snapshot never dereferences a missing viewer. Preserve all current player snapshot fields for normal seats. In `#broadcast(room)`, send personalized snapshots to players and `#snapshot(room, null)` to each connected spectator; do not add spectators to `room.players` or alter any player count checks.
- [ ] **Step 6: Refresh stale clients after rejected directory actions.** When an unseated, non-spectating socket receives an error from `join` or `watch`, follow the error with its latest `roomDirectory` snapshot. Keep current human-readable errors and do not alter the room on rejection.
- [ ] **Step 7: Manually inspect server state behavior.** Start two rooms and verify a new connection sees both; join one room and confirm its count updates; start it and confirm it becomes watchable; watch it and confirm the socket is not in `room.players`; unwatch and confirm it receives the directory again. Attempt watch on a lobby, join on a started room, and an action from a spectator; each must fail without changing the room.

### Task 2: Add a live room directory to the home screen

**Files:**
- Modify: `public/index.html`
- Modify: `public/client.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: Task 1 `roomDirectory` payloads and existing `join`/`watch` WebSocket messages.
- Produces: Home-screen room cards with Join/Watch/View Results actions; an accessible loading, empty, and connection-loss state.

- [ ] **Step 1: Add semantic directory markup.** Add a section below the home entry controls with heading “OPEN ROOMS”, a live status paragraph, and a list container with `aria-live="polite"`. Keep the existing display-name, create-room, and room-code controls unchanged.
- [ ] **Step 2: Track and render directory updates.** In `public/client.js`, add `let roomDirectory = []` and `let directoryReceived = false`. In the WebSocket message handler, handle `roomDirectory` by replacing `roomDirectory`, setting `directoryReceived`, and calling `renderDirectory()`. Render an initial connecting message until the first list arrives, then a no-open-rooms message for an empty array.
- [ ] **Step 3: Render room cards without HTML injection.** Build room card elements using `document.createElement` and assign all server values with `textContent`. Show room code, host name, player count such as `3 / 8`, and status. Add a Join button only for `phase === "lobby" && playerCount < maxPlayers`; add Watch for `auction`, `offer`, or `intermission`; add View Results for `complete`; add View Status for `ended`.
- [ ] **Step 4: Connect room actions to the existing name field and protocol.** Use one delegated click handler on the directory list. For Join, call the existing `displayName()` validation and send `{ type: "join", name, code }`. For all started/ended phases, send `{ type: "watch", code }`. Do not make list actions available when the socket is not open; show a reconnecting state instead, and call `renderDirectory()` from the existing socket `close` and `error` handlers so controls update promptly.
- [ ] **Step 5: Render an updated directory after an error.** Keep the existing error display. Because Task 1 sends a current `roomDirectory` after errors for unseated clients, let the next directory message replace the stale cards automatically.
- [ ] **Step 6: Style the directory responsively.** Add a full-width home-screen directory row beneath the two-column hero/entry area, stacked room cards, visible phase/status labels, and touch-sized action buttons. At phone width, use a single-column layout and keep status and button text readable without horizontal scrolling.
- [ ] **Step 7: Manually verify directory use.** Open two browser sessions on the same server; create a room in one and confirm it appears in the other's list; join it from the list and confirm the name and count; fill a room and confirm Join disappears; start a room and confirm Watch appears; try an empty directory and a temporarily disconnected socket.

### Task 3: Make live game and terminal screens safe for spectators

**Files:**
- Modify: `public/index.html`
- Modify: `public/client.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: Task 1 spectator room messages with `spectator: true` and public room snapshots without `viewerId` or `self`.
- Produces: Read-only game, intermission, completed-results, and ended-room views; a return-to-directory action that sends `{ type: "unwatch" }`.

- [ ] **Step 1: Track spectator mode from the server response.** Add `let spectating = false`. In the room message handler set it from `message.spectator === true`; a normal player room message sets it to false. On `roomDirectory`, first capture `const wasSpectating = spectating`; only if `wasSpectating` clear spectator mode and stale `roomState` and render the home screen. Always refresh the directory. Never infer spectator mode from a missing `self` alone, because reconnect/transition messages may arrive separately.
- [ ] **Step 2: Add a view-only panel and return controls.** Add a hidden `#spectator-card` in the game layout with a “VIEW ONLY” label. Add a hidden `#spectator-home` button to the game, intermission, and result screens. Show it only when `spectating` is true; clicking sends `{ type: "unwatch" }` and waits for the following directory message before showing the home screen.
- [ ] **Step 3: Render the auction as read-only.** In `renderGame` toggle the private card and spectator card, and pass `spectating` into `renderAuction`. In `renderAuction`, hide bid controls and offer controls while spectating, but continue rendering the current lot, bid, current turn, countdown, public roster, and history. Do not call `renderTarget` for a spectator.
- [ ] **Step 4: Render round transitions without fake private balances.** In `renderIntermission`, if spectating, hide the income balance and show a neutral “Next round starting soon” status; for a player, preserve the existing income message and balance. Keep round transitions on the same room snapshot stream.
- [ ] **Step 5: Render completed and ended rooms safely.** Keep the existing public completed results behavior. For `phase === "ended"`, show the existing end message. Ensure the spectator home control is visible on both results and ended screens and does not remove any player's `resumeKey`.
- [ ] **Step 6: Manually verify spectator privacy and navigation.** Join a room as a player and start the game; from a third session watch it. Confirm the viewer cannot see a target or cash panel, cannot find enabled bid/pass/offer controls, sees public game updates, and returns to the live directory with `unwatch`. Then watch a completed and an ended room and return from each.

### Task 4: Document discovery and read-only viewing

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: The final room-directory and spectator behavior from Tasks 1–3.
- Produces: Updated local play instructions that explain same-server discovery and how spectators differ from contestants.

- [ ] **Step 1: Update the quick play-through.** Explain that players can select a waiting room from the Open Rooms list or still enter its code; selecting a started room watches it without taking one of the eight contestant seats.
- [ ] **Step 2: State the directory scope.** Explain that room discovery covers the current server process, so LAN players using the same host see the same rooms and the directory clears when the server restarts.
- [ ] **Step 3: Manually compare documentation to the UI.** Follow the README flow with two local browser sessions and confirm its wording matches the home-screen actions and spectator privacy behavior.

## Verification boundaries

Do not add automated test files or run test commands unless the user asks. Use the manual checks listed in the task steps to confirm the observable flows, and inspect the final diff for private snapshot fields, invalid spectator action paths, and responsive markup consistency.
