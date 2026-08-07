import { Game } from "./game.js";

const canvas = document.getElementById("game");
const game = new Game(canvas);
await game.start();

const resetBtn = document.getElementById("resetBtn");
resetBtn?.addEventListener("click", () => {
    game.resetRound();
});

// Expose a tiny API for page-level buttons (audio/menu/fullscreen helpers)
window.__GAME_API__ = {
    toggleAudio() {
        game.audio.toggleEnabled();
        if (game.audio.enabled) {
            game.unlockAudioIfNeeded();
            if (game.audio.enabled) game.audio.playMusic();
        } else {
            game.audio.stopMusic();
        }
    },
    isAudioEnabled() {
        return !!game.audio.enabled;
    },
    resetRound() {
        game.resetRound();
    }
};