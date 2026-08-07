import { Input } from "./input.js";
import { Ship } from "./entities/Ship.js";
import { loadPlistAtlas } from "./gfx/loadPlistAtlas.js";
import { ParallaxLayer, ParallaxSystem, loadImage } from "./gfx/parallax.js";
import { StarField, StarEmitter, loadStarEmitterConfig } from "./fx/stars.js";
import { AsteroidField } from "./entities/AsteroidField.js";
import { LaserPool } from "./entities/LaserPool.js";
import { AudioManager } from "./audio/audio.js";

function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const GameState = {
    PLAYING: "playing",
    WON: "won",
    LOST: "lost"
};

function pickMusicPath() {
    const a = document.createElement("audio");
    const canOgg = !!a.canPlayType && a.canPlayType("audio/ogg; codecs=vorbis") !== "";
    return canOgg ? "./assets/audio/music/SpaceGame.ogg" : "./assets/audio/music/SpaceGame.mp3";
}

export class Game {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.input = new Input(canvas);

        this.playerImage = null;
        this.playerW = 64;
        this.playerH = 64;
        this.ship = new Ship(canvas.width * 0.15, canvas.height * 0.5);

        this.atlas = null;
        this.lastTime = 0;
        this.worldSpeed = 220;

        this.parallax = new ParallaxSystem();
        this.starField = new StarField();
        this.asteroidField = null;
        this.lasers = null;

        this.audio = new AudioManager();
        this.audioUnlocked = false;
        this.musicLoaded = false;

        this.debug = false;
        this.initialLives = 3;
        this.lives = this.initialLives;
        this.shipInvulnUntil = 0;
        this.roundDurationSec = 30;
        this.gameEndAtSec = 0;
        this.state = GameState.PLAYING;

        this.touchActive = false;
        this.touchX = 0;
        this.touchY = 0;
        this.autoFireTimer = 0;
        this.autoFireInterval = 0.18;

        this.enemy1Image = null;
        this.enemy2Image = null;
    }

    keyPressedAny(...keys) {
        return keys.some((k) => this.input.wasPressed(k));
    }

    isFirePressed() {
        return this.keyPressedAny(" ", "space", "Space", "spacebar");
    }

    initEnemyVisuals(enemy) {
        enemy.__enemyImage = Math.random() < 0.5 ? this.enemy1Image : this.enemy2Image;
        enemy.scale = 0.6 + Math.random() * 1.4;
        enemy.__rot = Math.random() * Math.PI * 2;
        const dir = Math.random() < 0.5 ? -1 : 1;
        enemy.__rotSpeed = dir * (0.8 + Math.random() * 2.2); // radians/sec
    }

    async start() {
        const [atlas, playerImage, enemy1Image, enemy2Image, spacedust, galaxy, planetsunrise, anomaly1, anomaly2] = await Promise.all([
            loadPlistAtlas("./assets/images/sprites/spritesheet.png", "./assets/images/sprites/Sprites.plist"),
            loadImage("./assets/images/sprites/player.png"),
            loadImage("./assets/images/sprites/enemy1.png"),
            loadImage("./assets/images/sprites/enemy2.png"),
            loadImage("./assets/images/backgrounds/bg_front_spacedust.png"),
            loadImage("./assets/images/backgrounds/bg_galaxy.png"),
            loadImage("./assets/images/backgrounds/bg_planetsunrise.png"),
            loadImage("./assets/images/backgrounds/bg_spacialanomaly.png"),
            loadImage("./assets/images/backgrounds/bg_spacialanomaly2.png")
        ]);

        this.enemy1Image = enemy1Image;
        this.enemy2Image = enemy2Image;

        const [s1, s2, s3] = await Promise.all([
            loadStarEmitterConfig("./assets/particles/Stars1.plist"),
            loadStarEmitterConfig("./assets/particles/Stars2.plist"),
            loadStarEmitterConfig("./assets/particles/Stars3.plist")
        ]);

        const musicPath = pickMusicPath();
        await Promise.all([
            this.audio.loadMusic(musicPath, { volume: 0.35, loop: true }),
            this.audio.loadEffect("explosion", "./assets/audio/sfx/explosion_large.wav", { volume: 0.75, poolSize: 8 }),
            this.audio.loadEffect("laser", "./assets/audio/sfx/laser_ship.wav", { volume: 0.8, poolSize: 8 }),
            this.audio.loadEffect("shipHit", "./assets/audio/sfx/shake.wav", { volume: 0.75, poolSize: 4 })
        ]);
        this.musicLoaded = true;

        this.playerImage = playerImage;
        this.playerW = playerImage.width || 64;
        this.playerH = playerImage.height || 64;

        this.starField.addEmitter(new StarEmitter(s1, this.canvas.width, this.canvas.height));
        this.starField.addEmitter(new StarEmitter(s2, this.canvas.width, this.canvas.height));
        this.starField.addEmitter(new StarEmitter(s3, this.canvas.width, this.canvas.height));

        this.atlas = atlas;
        const keys = Object.keys(this.atlas.frames || {});
        const laserKey =
            keys.find((k) => k === "laserbeam_blue.png") ||
            keys.find((k) => /laserbeam_blue/i.test(k)) ||
            keys.find((k) => /laser/i.test(k));

        if (!laserKey) throw new Error("Laser frame not found in Sprites.plist");

        this.asteroidField = new AsteroidField({
            atlasImage: enemy1Image,
            asteroidFrame: { x: 0, y: 0, w: enemy1Image.width || 64, h: enemy1Image.height || 64 }
        });

        for (const e of this.asteroidField.pool) {
            this.initEnemyVisuals(e);
        }

        const originalSpawn = this.asteroidField.spawn?.bind(this.asteroidField);
        if (originalSpawn) {
            this.asteroidField.spawn = (...args) => {
                const beforeStates = this.asteroidField.pool.map((p) => p.active);
                originalSpawn(...args);
                for (let i = 0; i < this.asteroidField.pool.length; i++) {
                    const p = this.asteroidField.pool[i];
                    if (!beforeStates[i] && p.active) {
                        this.initEnemyVisuals(p);
                    }
                }
            };
        }

        this.lasers = new LaserPool({
            atlasImage: this.atlas.image,
            laserFrame: this.atlas.frames[laserKey],
            poolSize: 5,
            speed: this.canvas.width / 0.5
        });

        this.parallax.addLayer(new ParallaxLayer({ image: galaxy, y: this.canvas.height * 0.08, speed: 0.05, scale: 1.0, alpha: 0.75, gap: 120 }));
        this.parallax.addLayer(new ParallaxLayer({ image: planetsunrise, y: this.canvas.height * 0.52, speed: 0.06, scale: 0.95, alpha: 0.95, gap: 450 }));
        this.parallax.addLayer(new ParallaxLayer({ image: anomaly1, y: this.canvas.height * 0.22, speed: 0.07, scale: 1.0, alpha: 0.9, gap: 700 }));
        this.parallax.addLayer(new ParallaxLayer({ image: anomaly2, y: this.canvas.height * 0.70, speed: 0.075, scale: 1.0, alpha: 0.9, gap: 900 }));
        this.parallax.addLayer(new ParallaxLayer({ image: spacedust, y: (this.canvas.height - spacedust.height) / 2, speed: 0.1, scale: 1.0, alpha: 1.0, gap: 0 }));

        this.setupMobileInput();
        this.resetRound();
        requestAnimationFrame((t) => this.loop(t));
    }

    setupMobileInput() {
        const c = this.canvas;
        c.style.touchAction = "none";

        const toCanvasPos = (clientX, clientY) => {
            const rect = c.getBoundingClientRect();
            const scaleX = c.width / rect.width;
            const scaleY = c.height / rect.height;
            return {
                x: (clientX - rect.left) * scaleX,
                y: (clientY - rect.top) * scaleY
            };
        };

        c.addEventListener("pointerdown", (e) => {
            if (e.pointerType === "touch" || e.pointerType === "pen") {
                e.preventDefault();
                c.setPointerCapture?.(e.pointerId);
                const p = toCanvasPos(e.clientX, e.clientY);
                this.touchActive = true;
                this.touchX = p.x;
                this.touchY = p.y;
                this.unlockAudioIfNeeded();
            }
        }, { passive: false });

        c.addEventListener("pointermove", (e) => {
            if ((e.pointerType === "touch" || e.pointerType === "pen") && this.touchActive) {
                e.preventDefault();
                const p = toCanvasPos(e.clientX, e.clientY);
                this.touchX = p.x;
                this.touchY = p.y;
            }
        }, { passive: false });

        const endTouch = (e) => {
            if (e.pointerType === "touch" || e.pointerType === "pen") {
                e.preventDefault();
                this.touchActive = false;
                this.autoFireTimer = 0;
                c.releasePointerCapture?.(e.pointerId);
            }
        };

        c.addEventListener("pointerup", endTouch, { passive: false });
        c.addEventListener("pointercancel", endTouch, { passive: false });
    }

    unlockAudioIfNeeded() {
        if (this.audioUnlocked || !this.musicLoaded) return;
        this.audioUnlocked = true;
        this.audio.playMusic();
    }

    resetRound() {
        const nowSec = performance.now() / 1000;
        this.state = GameState.PLAYING;
        this.lives = this.initialLives;
        this.shipInvulnUntil = 0;
        this.gameEndAtSec = nowSec + this.roundDurationSec;
        this.ship.x = this.canvas.width * 0.15;
        this.ship.y = this.canvas.height * 0.5;

        if (this.asteroidField) {
            for (const e of this.asteroidField.pool) {
                e.active = false;
                this.initEnemyVisuals(e);
            }
            this.asteroidField.nextIndex = 0;
            this.asteroidField.scheduleNext(nowSec);
        }

        if (this.lasers) {
            for (const l of this.lasers.pool) l.active = false;
            this.lasers.nextIndex = 0;
        }
    }

    getShipAABB() {
        const w = this.playerW * this.ship.scale;
        const h = this.playerH * this.ship.scale;
        return {
            left: this.ship.x - w * 0.5,
            top: this.ship.y - h * 0.5,
            right: this.ship.x + w * 0.5,
            bottom: this.ship.y + h * 0.5
        };
    }

    loop(timestamp) {
        if (!Number.isFinite(this.lastTime) || this.lastTime === 0) this.lastTime = timestamp;
        const dtRaw = (timestamp - this.lastTime) / 1000;
        const dt = Math.min(Math.max(dtRaw, 0), 0.033);
        this.lastTime = timestamp;

        this.update(dt);
        this.render();

        requestAnimationFrame((t) => this.loop(t));
    }

    update(dt) {
        if (this.input.wasPressed("p")) this.debug = !this.debug;
        if (this.input.wasPressed("o")) window.__PARALLAX_SEAMS__ = !window.__PARALLAX_SEAMS__;
        if (this.input.wasPressed("k")) this.worldSpeed = Math.max(20, this.worldSpeed - 20);
        if (this.input.wasPressed("l")) this.worldSpeed = Math.min(1200, this.worldSpeed + 20);

        if (this.input.wasPressed("m")) {
            this.audio.toggleEnabled();
            if (this.audio.enabled) this.unlockAudioIfNeeded();
        }

        const firePressed = this.isFirePressed();
        const anyGesture =
            firePressed ||
            this.input.wasPressed("w") ||
            this.input.wasPressed("s") ||
            this.input.wasPressed("a") ||
            this.input.wasPressed("d") ||
            this.input.wasPressed("arrowup") ||
            this.input.wasPressed("arrowdown") ||
            this.input.wasPressed("arrowleft") ||
            this.input.wasPressed("arrowright") ||
            this.input.wasPressed("enter") ||
            this.touchActive;

        if (anyGesture) {
            this.unlockAudioIfNeeded();
            if (this.audio.enabled) this.audio.playMusic();
        }

        if (this.state !== GameState.PLAYING) {
            if (this.input.wasPressed("r") || this.input.wasPressed("enter")) this.resetRound();
            this.input.endFrame();
            return;
        }

        this.parallax.update(dt, this.worldSpeed);
        this.starField.update(dt);

        this.ship.update(dt, this.input, this.canvas.width, this.canvas.height);

        if (this.touchActive) {
            this.ship.x = Math.max(0, Math.min(this.canvas.width, this.touchX));
            this.ship.y = Math.max(0, Math.min(this.canvas.height, this.touchY));

            this.autoFireTimer += dt;
            while (this.autoFireTimer >= this.autoFireInterval) {
                this.autoFireTimer -= this.autoFireInterval;
                if (this.lasers) {
                    this.lasers.fire(this.ship.x, this.ship.y, this.ship.scale ?? 1);
                    this.audio.playEffect("laser");
                }
            }
        }

        if (this.lasers && firePressed) {
            this.lasers.fire(this.ship.x, this.ship.y, this.ship.scale ?? 1);
            this.audio.playEffect("laser");
        }

        const nowSec = performance.now() / 1000;
        if (this.asteroidField) this.asteroidField.update(dt, nowSec, this.canvas.width, this.canvas.height);
        if (this.lasers) this.lasers.update(dt, this.canvas.width);

        if (this.asteroidField) {
            for (const e of this.asteroidField.pool) {
                if (!e.active) continue;
                const spin = Number.isFinite(e.__rotSpeed) ? e.__rotSpeed : 0;
                e.__rot = (Number.isFinite(e.__rot) ? e.__rot : 0) + spin * dt;
            }
        }

        if (this.asteroidField && this.lasers) {
            const enemies = this.asteroidField.getActive();
            const lasers = this.lasers.getActive();

            for (const e of enemies) {
                if (!e.active) continue;
                const ea = e.getAABB();

                for (const l of lasers) {
                    if (!l.active) continue;
                    if (intersects(ea, l.getAABB())) {
                        e.active = false;
                        l.active = false;
                        this.audio.playEffect("explosion");
                        break;
                    }
                }

                if (e.active && nowSec >= this.shipInvulnUntil && intersects(ea, this.getShipAABB())) {
                    e.active = false;
                    this.lives = Math.max(0, this.lives - 1);
                    this.shipInvulnUntil = nowSec + 1.0;
                    this.audio.playEffect("shipHit");
                }
            }
        }

        if (this.lives <= 0) this.state = GameState.LOST;
        else if (nowSec >= this.gameEndAtSec) this.state = GameState.WON;

        this.input.endFrame();
    }

    drawEnemies() {
        if (!this.asteroidField) return;
        const ctx = this.ctx;
        const active = this.asteroidField.getActive();

        for (const e of active) {
            if (!e.active) continue;
            const img = e.__enemyImage;
            if (!img) continue;

            const frameW = img.width || 64;
            const frameH = img.height || 64;
            const scale = Number.isFinite(e.scale) && e.scale > 0 ? e.scale : 1;
            const w = frameW * scale;
            const h = frameH * scale;
            const rot = Number.isFinite(e.__rot) ? e.__rot : 0;

            ctx.save();
            ctx.translate(e.x, e.y);
            ctx.rotate(rot);
            ctx.drawImage(img, -w * 0.5, -h * 0.5, w, h);
            ctx.restore();
        }
    }

    render() {
        const { ctx, canvas } = this;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        this.parallax.draw(ctx, canvas.width, canvas.height);
        this.starField.draw(ctx);
        this.drawEnemies();
        if (this.lasers) this.lasers.draw(ctx);

        if (this.playerImage) {
            const nowSec = performance.now() / 1000;
            const blink = nowSec < this.shipInvulnUntil && Math.floor(nowSec * 20) % 2 === 0;
            if (!blink && this.state === GameState.PLAYING) {
                const w = this.playerW * this.ship.scale;
                const h = this.playerH * this.ship.scale;
                ctx.drawImage(this.playerImage, this.ship.x - w * 0.5, this.ship.y - h * 0.5, w, h);
            }
        }

        const nowSec = performance.now() / 1000;
        const remaining = Math.max(0, Math.ceil(this.gameEndAtSec - nowSec));

        ctx.fillStyle = "#ffffff";
        ctx.font = "24px sans-serif";
        ctx.fillText(`Lives: ${this.lives}`, 20, 36);
        ctx.fillText(`Time: ${remaining}`, 20, 68);
        ctx.fillText(`Audio: ${this.audio.enabled ? "On" : "Off"} (M)`, 20, 100);

        if (this.state !== GameState.PLAYING) {
            const msg = this.state === GameState.WON ? "You Win" : "You Lose";
            ctx.textAlign = "center";
            ctx.fillStyle = "#ffffff";
            ctx.font = "64px sans-serif";
            ctx.fillText(msg, canvas.width * 0.5, canvas.height * 0.45);
            ctx.font = "28px sans-serif";
            ctx.fillText("Press R or Enter to Restart", canvas.width * 0.5, canvas.height * 0.58);
            ctx.textAlign = "start";
        }

        if (this.debug) this.parallax.drawDebug(ctx);
    }
}