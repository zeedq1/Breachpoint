# Breachpoint — Tactical Operations

A new, original browser-based tactical FPS prototype inspired by round-based objective shooters. It is **not** a remake of Counter-Strike 2 or Rainbow Six Siege and includes no official art, maps, sounds, or other proprietary assets.

## Included

- First-person 3D movement using Three.js
- Online room codes and real-time multiplayer using Socket.IO
- Teams, round wins, side switching after round 3, and first-to-five match wins
- Search-and-secure objective: attackers plant at Site A or B; defenders can defuse; the device detonates after 35 seconds
- Server-processed hitscan fire with basic server-side wall occlusion, damage, kills, and death state
- Rifle, sidearm, marksman rifle, ammo, reserve ammo, and timed reloads
- Sprint, crouch, ADS, crosshair, hitmarker, minimap, kill feed, scoreboard, and generated sound effects
- Responsive briefing screen and Render deployment configuration

This is a playable prototype, not a production-grade competitive shooter. It has a simple low-poly test map, and it does not yet include matchmaking, persistent accounts, anti-cheat, voice chat, dedicated moderation, advanced physics, destructible walls, or production network prediction/interpolation.

## Run locally

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000> in a modern browser. For two-player testing, open the site in two browser windows (or on two devices on the same network), create a room in one, and join the room code from the other. One player must click **Start Operation**.

Browsers require a click before they let a page capture the mouse. Click the game view when the match starts. Press `Esc` to pause/release the mouse; click the view to resume.

## Controls

| Key / input | Action |
|---|---|
| `W A S D` | Move |
| Mouse | Look |
| Left mouse | Fire |
| Right mouse | Aim down sights (prototype view zoom) |
| `Shift` | Sprint |
| `C` | Toggle crouch |
| `R` | Reload |
| `1 / 2 / 3` | Rifle / sidearm / marksman rifle |
| Hold `E` | Plant at a site or defuse a planted device |
| `Tab` | Scoreboard |
| `Esc` | Pause / release mouse |

## Deploy to Render

1. Create a new GitHub repository and upload the **contents** of this folder. `server.js`, `package.json`, `render.yaml`, `README.md`, and `public/` must be in the repository root.
2. In the Render dashboard, choose **New → Web Service** and connect the repository.
3. Set build command to `npm install` and start command to `npm start` (the included `render.yaml` documents the same settings).
4. Choose a plan and deploy. The game page and Socket.IO multiplayer endpoint are served from the same service.
5. Open the Render URL in two browsers. One creates a room, the other joins with its code.

Render free instances may sleep when idle, so the first connection after inactivity can take time. Active matches are kept in server memory and will be lost when the server restarts or redeploys.

## Files

- `server.js` — Express static host, Socket.IO rooms, rounds, objective and hit processing
- `public/index.html` — page structure and HUD
- `public/style.css` — briefing screen, responsive layout and game HUD
- `public/client.js` — Three.js scene, map, movement, model rendering, controls and effects
- `render.yaml` — Render service configuration
