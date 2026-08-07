import { Game } from "./game.js";

const canvas = document.getElementById("game");
const game = new Game(canvas);
await game.start();

const resetBtn = document.getElementById("resetBtn");
resetBtn?.addEventListener("click", () => {
    game.resetRound();
});