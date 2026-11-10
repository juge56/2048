# Make 2048
A Udacity version of Gabriele Cirulli's [original 2048](http://gabrielecirulli.github.io/2048/). 

The original version is a small clone of [1024](https://play.google.com/store/apps/details?id=com.veewo.a1024), based on [Saming's 2048](http://saming.fr/p/2048/) (also a clone).

## Sidehit
[`sidehit/`](sidehit/) is a separate, self-contained game in this repo: an original 3D terrain-park snowboarding game with a built-in park editor.

- **Ride:** physics-driven carving, ollies, kickers, rollers, rails and boxes, with spins, flips, grabs and grinds feeding a combo score. Set a respawn point anywhere to session a single feature.
- **Build:** tap to place features, drag to move them, rotate and resize them, and reshape the hill (steepness, length, width, rolling terrain, light). Parks save in the browser automatically.
- **Share:** every park exports as a short JSON code that anyone can paste under Import.

It is a static page with no build step. Serve the repo root (for example `python3 -m http.server`) and open `/sidehit/`. Keyboard and touch controls are listed on the menu. It uses a vendored copy of [three.js](https://threejs.org/) (MIT).

### Notes for the Udacity version
We're using this version as the recommended fork to avoid potential learning issues as the original source changes (and the Udacity videos don't update). You can [fork the original repo as well](https://github.com/gabrielecirulli/2048)

## License
2048 is licensed under the [MIT license.](https://github.com/gabrielecirulli/2048/blob/master/LICENSE.txt)

## Donations
Gabriele made this in his spare time, and it's hosted on GitHub (which means I don't have any hosting costs), but if you enjoyed the game and feel like buying him coffee, you can donate at his BTC address: `1Ec6onfsQmoP9kkL3zkpB6c5sA4PVcXU2i`.
