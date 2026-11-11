# Clean Sweep Squad
The McDaniel family chore game. Live at https://chores.mcdanielnet.com
Hosted on Cloudflare Pages, deployed from this GitHub repo.

- `index.html` is the game.
- `functions/api/[[path]].js` is the small server that keeps every device in sync. It saves to a Cloudflare D1 database connected to the Pages project with the variable name `DB`.

If both parents forget their PINs: in Cloudflare, open the D1 database, go to Console, run `DELETE FROM kv WHERE k = 'users';`, then open the site and set up again. Stars and missions are kept.

## Demo mode

`chores.mcdanielnet.com/demo` (which forwards to `/?demo`) is a try-it-out copy for sharing.
The whole game runs in the visitor's browser on throwaway data, with a sample family
(Ava, Grace, Sam; PINs: parents 1111, kids 2222). It never calls the real server, never
touches the family database, and never uses this device's saved login. Reloading or
"Start over" brings back a fresh sample family.

- `demo.js` holds the in-memory database and the sample family.
- `demo-engine.js` is an exact copy of `functions/api/[[path]].js`. Whenever the server
  file changes, copy it over `demo-engine.js` so the demo keeps matching the real site.
