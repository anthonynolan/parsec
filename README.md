# Arcade

A tiny collection of browser games. Open the home page, pick a cabinet, and play.
New games will appear on the home page as they are added.

**Games so far:** [Parsec](parsec-game/) — a TI-99/4A style scrolling shooter.

## Screenshots (Parsec)

Title screen with high scores:

![Parsec title screen](<parsec-game/Screenshot 2026-11-08 094226.jpg>)

In flight — steer clear of the terrain and watch for enemy saucers:

![Parsec gameplay](<parsec-game/Screenshot 2026-11-08 094422.jpg>)

Paused mid-sector, with a red fuel pod flag on the ridge below:

![Parsec paused](<parsec-game/Screenshot 2026-11-08 094335.jpg>)

## Install

There is nothing to build — these are plain static files with no dependencies.

```sh
git clone <repo-url>
cd parsec
```

## Play

Serve the folder and open it in a browser:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

then open `http://127.0.0.1:8000/` and click **Parsec**.
(Any static file server works, or just open `index.html` directly.)

### Controls

| Action | Input |
| --- | --- |
| Move | Arrows / WASD (left stick or D-pad on gamepad; drag on touch screens) |
| Fire | Space / Z (gamepad A / RT, or the FIRE button) |
| Launch / restart | Enter (any gamepad button) |
| Pause | P (gamepad Start) |
| Mute | M |
| Full screen | FULLSCREEN button |

### Goal

Destroy the enemy saucers, keep an eye on your fuel gauge, and don't hit the
ground. Shoot the red fuel pods for extra fuel. Your top 10 scores are saved on
your machine.
