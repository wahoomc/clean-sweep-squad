# Clean Sweep Squad
The McDaniel family chore game. Live at https://chores.mcdanielnet.com
Hosted on Cloudflare Pages, deployed from this GitHub repo.

- `index.html` is the game.
- `functions/api/[[path]].js` is the small server that keeps every device in sync. It saves to a Cloudflare D1 database connected to the Pages project with the variable name `DB`.

If both parents forget their PINs: in Cloudflare, open the D1 database, go to Console, run `DELETE FROM kv WHERE k = 'users';`, then open the site and set up again. Stars and missions are kept.
