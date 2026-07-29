/* ════════ あらいの遊び場 共通BGMエンジン(WebAudio・音源ファイル不要) ════════
 *
 * ネットのゲームBGM制作knowledgeに基づく設計:
 *  - 短いループ(4小節)を、最後のコードが先頭へ自然につながる進行で繰り返す
 *  - シーン心理に合わせたテンポ: 落ち着き70-100 / 街・親しみ90-120 / 戦闘・スピード120-160
 *  - メニュー/パズルは一定リズムで疲れさせず集中を守る。アクションはアップテンポ
 *  - シンプルなコード進行+音色の変化で飽きさせない
 *
 * 使い方: <script src="/bgm.js"></script> <script>AraiBGM.init('home')</script>
 *  - 🔊ボタン+音量スライダーを自動設置(#bgmSlotがあればそこに、なければ左下に)
 *  - ON/OFF・音量は localStorage で全ゲーム共通に記憶
 *  - ブラウザの自動再生制限対応: 最初のクリック/キー入力で再生開始 */
'use strict';
(function () {
  /* ══ 楽曲データ ══
   * 64ステップ(16分×4小節)ループ。イベント: [step, midiノート, 長さ(step数)]
   * chords: [step, [midi...], 長さ] / drums: kick,hat,snareはstep配列 */
  const TRACKS = {
    /* ホーム: 「街・親しみ」92BPM Cメジャー。ゆったりスウィング+柔らかアルペジオ。
     * C→Am→F→G(→C) でループの継ぎ目が自然につながる王道進行 */
    home: {
      bpm: 92, swing: 0.13,
      leadType: 'triangle', leadVol: 0.11, bassVol: 0.15, chordVol: 0.045,
      bass: [
        [0, 36, 3], [8, 36, 2], [12, 43, 2],
        [16, 33, 3], [24, 33, 2], [28, 40, 2],
        [32, 29, 3], [40, 29, 2], [44, 36, 2],
        [48, 31, 3], [56, 31, 2], [60, 38, 2],
      ],
      lead: [
        [2, 64, 2], [6, 67, 2], [10, 72, 3], [14, 67, 2],
        [18, 64, 2], [22, 69, 2], [26, 72, 3], [30, 69, 2],
        [34, 65, 2], [38, 69, 2], [42, 72, 3], [46, 69, 2],
        [50, 62, 2], [54, 67, 2], [58, 71, 2], [62, 74, 2],
      ],
      chords: [
        [0, [60, 64, 67], 14], [16, [57, 60, 64], 14],
        [32, [57, 60, 65], 14], [48, [59, 62, 67], 14],
      ],
      kick: [0, 8, 16, 24, 32, 40, 48, 56],
      hat: [4, 12, 20, 28, 36, 44, 52, 60],
      snare: [],
    },
    /* ジャンデッキケン: カードバトルの読み合い。120BPM Aマイナー。
     * シンコペのベース+緊張感のある単音リード(リラックスさせすぎない) */
    jandekken: {
      bpm: 120, swing: 0,
      leadType: 'square', leadVol: 0.07, bassVol: 0.16, chordVol: 0.04,
      bass: [
        [0, 33, 2], [3, 33, 1], [6, 40, 2], [8, 33, 2], [11, 33, 1], [14, 40, 2],
        [16, 29, 2], [19, 29, 1], [22, 36, 2], [24, 29, 2], [27, 29, 1], [30, 36, 2],
        [32, 38, 2], [35, 38, 1], [38, 45, 2], [40, 38, 2], [43, 38, 1], [46, 45, 2],
        [48, 40, 2], [51, 40, 1], [54, 47, 2], [56, 40, 2], [59, 44, 1], [62, 47, 2],
      ],
      lead: [
        [0, 76, 3], [12, 72, 3],
        [16, 77, 3], [28, 72, 3],
        [32, 74, 3], [44, 69, 3],
        [48, 76, 2], [52, 75, 2], [56, 76, 2], [60, 79, 3],
      ],
      chords: [
        [4, [69, 72, 76], 2], [12, [69, 72, 76], 2],
        [20, [65, 69, 72], 2], [28, [65, 69, 72], 2],
        [36, [62, 65, 69], 2], [44, [62, 65, 69], 2],
        [52, [64, 68, 71], 2], [60, [64, 68, 71], 2],
      ],
      kick: [0, 10, 16, 26, 32, 42, 48, 58],
      hat: [2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58, 62],
      snare: [4, 12, 20, 28, 36, 44, 52, 60],
    },
    /* カウントフルーツ: 数える集中+心理戦。96BPM Fメジャー。
     * ミニマルで一定(集中の邪魔をしない)、柔らかいベル系スタッカート */
    countfruits: {
      bpm: 96, swing: 0.08,
      leadType: 'triangle', leadVol: 0.10, bassVol: 0.13, chordVol: 0.035,
      bass: [
        [0, 41, 4], [8, 41, 4],
        [16, 46, 4], [24, 46, 4],
        [32, 48, 4], [40, 48, 4],
        [48, 41, 4], [56, 43, 3],
      ],
      lead: [
        [0, 69, 2], [6, 72, 2], [10, 77, 2],
        [16, 70, 2], [22, 74, 2], [26, 77, 2],
        [32, 72, 2], [38, 76, 2], [42, 79, 2],
        [48, 77, 3], [54, 72, 2], [58, 69, 3],
      ],
      chords: [
        [0, [57, 60, 65], 15], [16, [58, 62, 65], 15],
        [32, [60, 64, 67], 15], [48, [57, 60, 65], 15],
      ],
      kick: [0, 16, 32, 48],
      hat: [8, 24, 40, 56],
      snare: [],
    },
    /* ドロボウ市場: 泥棒のかけひき。116BPM Dマイナーのスウィング。
     * こそこそ歩くようなウォーキングベース+ピチカート風の短い音 */
    dorobou: {
      bpm: 116, swing: 0.22,
      leadType: 'triangle', leadVol: 0.10, bassVol: 0.17, chordVol: 0.03,
      bass: [
        [0, 38, 1], [2, 41, 1], [4, 43, 1], [6, 45, 1], [8, 46, 1], [10, 45, 1], [12, 43, 1], [14, 39, 1],
        [16, 43, 1], [18, 46, 1], [20, 48, 1], [22, 50, 1], [24, 51, 1], [26, 50, 1], [28, 48, 1], [30, 44, 1],
        [32, 45, 1], [34, 48, 1], [36, 50, 1], [38, 52, 1], [40, 53, 1], [42, 52, 1], [44, 50, 1], [46, 49, 1],
        [48, 38, 1], [50, 41, 1], [52, 43, 1], [54, 45, 1], [56, 46, 1], [58, 45, 1], [60, 43, 1], [62, 40, 1],
      ],
      lead: [
        [0, 62, 1], [3, 65, 1], [6, 69, 1], [10, 67, 1], [12, 65, 1],
        [19, 70, 1], [22, 67, 1], [26, 65, 1],
        [32, 69, 1], [35, 72, 1], [38, 76, 1], [42, 73, 1], [44, 69, 1],
        [51, 74, 1], [54, 70, 1], [56, 69, 2], [60, 61, 1], [62, 62, 2],
      ],
      chords: [],
      kick: [0, 8, 16, 24, 32, 40, 48, 56],
      hat: [2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58, 62],
      snare: [12, 28, 44, 60],
    },
    /* ボムわけ!: アクション・スコアアタック。144BPM Cメジャー。
     * 四つ打ち+疾走アルペジオ(アップテンポで手が軽く動く) */
    bombsort: {
      bpm: 144, swing: 0,
      leadType: 'square', leadVol: 0.06, bassVol: 0.15, chordVol: 0.03,
      bass: [
        [0, 36, 1], [2, 48, 1], [4, 36, 1], [6, 48, 1], [8, 36, 1], [10, 48, 1], [12, 36, 1], [14, 48, 1],
        [16, 36, 1], [18, 48, 1], [20, 36, 1], [22, 48, 1], [24, 36, 1], [26, 48, 1], [28, 36, 1], [30, 48, 1],
        [32, 29, 1], [34, 41, 1], [36, 29, 1], [38, 41, 1], [40, 29, 1], [42, 41, 1], [44, 29, 1], [46, 41, 1],
        [48, 31, 1], [50, 43, 1], [52, 31, 1], [54, 43, 1], [56, 31, 1], [58, 43, 1], [60, 31, 1], [62, 43, 1],
      ],
      lead: [
        [0, 72, 1], [2, 76, 1], [4, 79, 1], [6, 84, 1], [8, 79, 1], [10, 76, 1], [12, 72, 1], [14, 76, 1],
        [16, 72, 1], [18, 76, 1], [20, 79, 1], [22, 84, 1], [24, 79, 1], [26, 76, 1], [28, 72, 1], [30, 67, 1],
        [32, 69, 1], [34, 72, 1], [36, 77, 1], [38, 81, 1], [40, 77, 1], [42, 72, 1], [44, 69, 1], [46, 72, 1],
        [48, 71, 1], [50, 74, 1], [52, 79, 1], [54, 83, 1], [56, 79, 1], [58, 74, 1], [60, 71, 1], [62, 74, 1],
      ],
      chords: [],
      kick: [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60],
      hat: [2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58, 62],
      snare: [4, 12, 20, 28, 36, 44, 52, 60],
    },
    /* クアドルカラー: パズルレース。126BPM Gメジャー。
     * 一定の8分パルスで集中を守りつつ、レースの推進力を出すモトリック */
    quadcolor: {
      bpm: 126, swing: 0,
      leadType: 'triangle', leadVol: 0.09, bassVol: 0.15, chordVol: 0.035,
      bass: [
        [0, 43, 2], [4, 43, 2], [8, 43, 2], [12, 43, 2],
        [16, 40, 2], [20, 40, 2], [24, 40, 2], [28, 40, 2],
        [32, 36, 2], [36, 36, 2], [40, 36, 2], [44, 36, 2],
        [48, 38, 2], [52, 38, 2], [56, 38, 2], [60, 38, 2],
      ],
      lead: [
        [0, 71, 2], [4, 74, 2], [8, 71, 2], [12, 74, 2],
        [16, 71, 2], [20, 76, 2], [24, 71, 2], [28, 76, 2],
        [32, 72, 2], [36, 76, 2], [40, 72, 2], [44, 79, 2],
        [48, 74, 2], [52, 78, 2], [56, 74, 2], [60, 78, 2],
      ],
      chords: [
        [0, [59, 62, 67], 14], [16, [59, 64, 67], 14],
        [32, [60, 64, 67], 14], [48, [62, 66, 69], 14],
      ],
      kick: [0, 8, 16, 24, 32, 40, 48, 56],
      hat: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62],
      snare: [8, 24, 40, 56],
    },
    /* マーダーミステリー: 66BPM Dハーモニックマイナー。
     * 通話しながら話し合う場なので、邪魔をしないことを最優先にした。
     * ・ドラムはバスドラ1小節1発だけ(遅い心音)＋裏拍のハイハット(時計の音)
     * ・低音は持続、和音は Dm→B♭→Gm→A7 で解決しないまま回り続ける
     * ・リードは1小節に2音だけ。三連や細かい動きは入れない */
    mystery: {
      bpm: 66, swing: 0,
      leadType: 'triangle', leadVol: 0.06, bassVol: 0.17, chordVol: 0.05,
      bass: [
        [0, 38, 8], [8, 38, 6],
        [16, 34, 8], [24, 34, 6],
        [32, 31, 8], [40, 31, 6],
        [48, 33, 8], [56, 33, 6],
      ],
      lead: [
        [2, 74, 6], [10, 77, 4],
        [18, 77, 6], [26, 74, 4],
        [34, 79, 6], [42, 77, 4],
        [50, 73, 6], [58, 74, 4],
      ],
      chords: [
        [0,  [62, 65, 69], 14],
        [16, [58, 62, 65], 14],
        [32, [55, 58, 62], 14],
        [48, [57, 61, 64], 14],
      ],
      kick: [0, 16, 32, 48],
      hat: [8, 24, 40, 56],
      snare: [],
    },
  };
  const STEPS = 64;

  /* ══ エンジン ══ */
  let ac = null, master = null, timer = null;
  let track = null, stepIdx = 0, nextTime = 0, started = false;
  let on = true, vol = 40;
  try {
    if (localStorage.getItem('arai_bgm_on') === '0') on = false;
    const v = localStorage.getItem('arai_bgm_vol');
    if (v !== null) vol = Math.max(0, Math.min(100, Number(v)));
  } catch (e) {}

  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  function ensureAC() {
    if (ac) return;
    ac = new (window.AudioContext || window.webkitAudioContext)();
    master = ac.createGain();
    master.gain.value = 0;
    master.connect(ac.destination);
  }
  function masterTarget() { return (vol / 100) * 0.55; }

  function tone(t0, midi, durSec, type, v, filterHz) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.value = mtof(midi);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(v, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.05, durSec));
    let node = o;
    if (filterHz) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = filterHz;
      o.connect(f); node = f;
    }
    node.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + durSec + 0.1);
  }
  function kick(t0) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t0);
    o.frequency.exponentialRampToValueAtTime(44, t0 + 0.12);
    g.gain.setValueAtTime(0.5, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + 0.2);
  }
  function noiseBurst(t0, durSec, v, hpHz) {
    const len = Math.max(1, Math.floor(ac.sampleRate * durSec));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const n = ac.createBufferSource();
    n.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = hpHz;
    const g = ac.createGain();
    g.gain.setValueAtTime(v, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
    n.connect(f); f.connect(g); g.connect(master);
    n.start(t0);
  }
  function playStep(s, tBase) {
    const spb = 60 / track.bpm / 4;
    const t0 = tBase + (s % 2 === 1 ? track.swing * spb : 0); // スウィング: 裏拍を遅らせる
    for (const [st, m, d] of track.bass) if (st === s) tone(t0, m, d * spb * 0.9, 'triangle', track.bassVol, 900);
    for (const [st, m, d] of track.lead) if (st === s) tone(t0, m, d * spb * 0.9, track.leadType, track.leadVol, 3500);
    for (const [st, ns, d] of track.chords) if (st === s) ns.forEach(m => tone(t0, m, d * spb, 'sawtooth', track.chordVol, 1400));
    if (track.kick.includes(s)) kick(t0);
    if (track.hat.includes(s)) noiseBurst(t0, 0.04, 0.07, 6500);
    if (track.snare.includes(s)) { noiseBurst(t0, 0.09, 0.13, 1800); tone(t0, 55, 0.07, 'triangle', 0.08); }
  }
  function scheduler() {
    const spb = 60 / track.bpm / 4;
    while (nextTime < ac.currentTime + 0.3) {
      playStep(stepIdx % STEPS, nextTime);
      stepIdx++;
      nextTime += spb;
    }
  }
  function start() {
    if (!track || started) return;
    ensureAC();
    if (ac.state === 'suspended') ac.resume();
    started = true;
    stepIdx = 0;
    nextTime = ac.currentTime + 0.1;
    master.gain.cancelScheduledValues(ac.currentTime);
    master.gain.setValueAtTime(0.0001, ac.currentTime);
    master.gain.linearRampToValueAtTime(masterTarget(), ac.currentTime + 1.2); // フェードイン
    clearInterval(timer);
    timer = setInterval(scheduler, 60);
  }
  function stop() {
    started = false;
    clearInterval(timer);
    timer = null;
    if (ac && master) {
      master.gain.cancelScheduledValues(ac.currentTime);
      master.gain.setValueAtTime(master.gain.value, ac.currentTime);
      master.gain.linearRampToValueAtTime(0.0001, ac.currentTime + 0.4);
    }
  }
  function applyVol() {
    if (ac && master && started) master.gain.setTargetAtTime(masterTarget(), ac.currentTime, 0.1);
  }

  /* ══ UI(🔊ボタン+音量) ══ */
  function buildUI() {
    const slot = document.getElementById('bgmSlot');
    const box = document.createElement('div');
    box.id = 'araiBgmBox';
    box.style.cssText = slot
      ? 'display:flex;align-items:center;gap:6px'
      : 'position:fixed;left:12px;bottom:12px;z-index:90;display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.88);border:2px solid #dde5f0;border-radius:99px;padding:5px 10px;backdrop-filter:blur(4px)';
    const btn = document.createElement('button');
    btn.id = 'araiBgmBtn';
    btn.title = 'BGM ON/OFF';
    btn.style.cssText = 'border:2px solid #dde5f0;background:#fff;border-radius:99px;width:36px;height:36px;font-size:15px;cursor:pointer;font-family:inherit';
    const rng = document.createElement('input');
    rng.type = 'range'; rng.min = 0; rng.max = 100; rng.value = vol;
    rng.style.cssText = 'width:74px;accent-color:#5b6cff';
    rng.title = 'BGM音量';
    const sync = () => { btn.textContent = on ? '🔊' : '🔇'; btn.style.opacity = on ? 1 : 0.55; };
    btn.onclick = () => {
      on = !on;
      try { localStorage.setItem('arai_bgm_on', on ? '1' : '0'); } catch (e) {}
      if (on) start(); else stop();
      sync();
    };
    rng.oninput = () => {
      vol = Number(rng.value);
      try { localStorage.setItem('arai_bgm_vol', String(vol)); } catch (e) {}
      applyVol();
      if (on && !started) start();
    };
    sync();
    box.append(btn, rng);
    if (slot) { slot.innerHTML = ''; slot.appendChild(box); }
    else document.body.appendChild(box);
  }

  /* ══ 公開API ══ */
  window.AraiBGM = {
    init(name) {
      track = TRACKS[name] || TRACKS.home;
      const boot = () => buildUI();
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
      else boot();
      // 自動再生制限対応: 最初の操作で開始
      const kickstart = () => {
        if (on && !started) start();
        document.removeEventListener('pointerdown', kickstart);
        document.removeEventListener('keydown', kickstart);
      };
      document.addEventListener('pointerdown', kickstart);
      document.addEventListener('keydown', kickstart);
    },
    tracks: Object.keys(TRACKS),
  };
})();
