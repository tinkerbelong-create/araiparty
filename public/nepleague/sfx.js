/* ファイブリーグ 効果音 — WebAudioで生成(音源ファイル不要)
 *   NpSfx.roll()   … オープン前のドラムロール(ルルルル…)
 *   NpSfx.stop()   … ロールを止める
 *   NpSfx.correct()… ピンポーン(正解)
 *   NpSfx.wrong()  … ブブー(不正解)
 *   NpSfx.perfect()… パーフェクトのファンファーレ
 *   NpSfx.tick()   … 文字が確定したときの小さな音
 * 音量は BGM と同じ localStorage(arai_bgm_vol / arai_bgm_on)を見る。 */
(function () {
  'use strict';
  let ac = null, rollTimer = null, rollGain = null;

  function ctx() {
    if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ac = new AC(); }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function vol() {
    try {
      if (localStorage.getItem('arai_bgm_on') === '0') return 0;
      const v = localStorage.getItem('arai_bgm_vol');
      return (v === null ? 40 : Math.max(0, Math.min(100, Number(v)))) / 100;
    } catch (e) { return 0.4; }
  }

  /* 単音 */
  function tone(freq, t0, dur, type, peak) {
    const a = ctx(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'triangle';
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime((peak || 0.2) * vol(), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(a.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  /* ノイズ(打楽器用) */
  function noise(t0, dur, peak, hz) {
    const a = ctx(); if (!a) return;
    const n = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, n, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = a.createBufferSource(); src.buffer = buf;
    const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = hz || 1800; bp.Q.value = 1.1;
    const g = a.createGain(); g.gain.value = (peak || 0.25) * vol();
    src.connect(bp); bp.connect(g); g.connect(a.destination);
    src.start(t0);
  }

  const NpSfx = {
    /* ドラムロール: 細かい打点を鳴らし続け、だんだん大きく速くする */
    roll() {
      const a = ctx(); if (!a) return;
      NpSfx.stop();
      let interval = 62, elapsed = 0;
      rollGain = 0.10;
      const beat = () => {
        noise(a.currentTime, 0.05, rollGain, 2200);
        if (elapsed % 4 === 0) tone(70, a.currentTime, 0.07, 'sine', rollGain * 0.9);
        elapsed++;
        if (interval > 34) interval -= 1.1;
        if (rollGain < 0.26) rollGain += 0.006;
        rollTimer = setTimeout(beat, interval);
      };
      beat();
    },
    stop() { if (rollTimer) { clearTimeout(rollTimer); rollTimer = null; } },

    /* ピンポーン */
    correct() {
      const a = ctx(); if (!a) return;
      NpSfx.stop();
      const t = a.currentTime;
      tone(880, t, 0.42, 'sine', 0.32);
      tone(1318.5, t + 0.16, 0.62, 'sine', 0.32);
    },

    /* ブブー(べべっ) */
    wrong() {
      const a = ctx(); if (!a) return;
      NpSfx.stop();
      const t = a.currentTime;
      tone(180, t, 0.30, 'square', 0.24);
      tone(150, t + 0.005, 0.30, 'sawtooth', 0.16);
      tone(170, t + 0.34, 0.44, 'square', 0.24);
      tone(140, t + 0.345, 0.44, 'sawtooth', 0.16);
    },

    /* パーフェクトのファンファーレ */
    perfect() {
      const a = ctx(); if (!a) return;
      NpSfx.stop();
      const t = a.currentTime;
      [[523.25, 0], [659.25, 0.13], [783.99, 0.26], [1046.5, 0.40]]
        .forEach(([f, d]) => tone(f, t + d, d === 0.40 ? 0.9 : 0.24, 'triangle', 0.3));
      [[659.25, 0.40], [783.99, 0.40]].forEach(([f, d]) => tone(f, t + d, 0.9, 'triangle', 0.16));
      noise(t + 0.40, 0.5, 0.18, 5200);
    },

    /* 文字が確定したときの小さな音 */
    tick() {
      const a = ctx(); if (!a) return;
      tone(1200, a.currentTime, 0.07, 'sine', 0.13);
    },
  };

  window.NpSfx = NpSfx;
})();
