// The pan / tilt servos' calibration, from pictures of the checkerboard
// (Lynx.camServo; the robot side is app_camservo.js).
//
// Each picture gives the camera's attitude to the board (its pose from the
// corners, the lens known): yaw, pitch and roll. The servos are measured by
// differences, so the board needn't be square to anything:
//   Pan: the chassis turns by -c while the pan servo is told +c, so the
//     board stays in view. The servo's real angle there is the camera's yaw
//     change to the board minus the chassis's turn (odometry):
//       actual(c) = actual(0) + [yaw(c) - yaw(0)] - [th(c) - th(0)]
//     actual(0) -- where "straight ahead" really points -- from a drive
//     straight back and forth at pan 0: how the board's middle moved in the
//     camera's own frame is the chassis's path seen from the camera (the
//     small turns on the way taken out with odometry).
//   Tilt: at pan 0, the camera's pitch change to the board.
// New servo pulses then put the servo where it's told: a table of pulses for
// -90, -75, ..., +90 degrees (servo_table.hpp on the robot -- hobby servos
// aren't linear enough for min / center / max alone), each where the servo
// really is at that angle: between the measured angles interpolated, past
// them extended along a line through the outermost few. The tilt's 0 stays:
// its offset is the camera's mount tilt (cameraTiltDeg).
//
//   attitude(R, t, mid) -> {yaw, pitch, roll, C, mid}    (pose: board -> camera; mid: the board's middle, board X, Y)
//   analyze(samples, panMap, tiltMap) -> {pan, tilt, lean: {fwdDeg, leftDeg}, p0Deg, ...} | {error}
//     samples: {kind: "zero" | "pan" | "tilt", pan, tilt (commanded, deg), x, y, th (odometry, m / rad), att}
//     maps: {minA, maxA, minP, cenP, maxP, table} (the robot's settings; table: its pulses
//     for -90..90 every 15 degrees, or null -- what the measurements were taken with)

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const D2R = Math.PI / 180;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const clamp1 = (x) => Math.max(-1, Math.min(1, x));

  // The board's frame: X along its rows (right), Y down it, Z into it. Yaw is
  // about the board's "up" (-Y), positive to the left as the robot's angles
  // are; pitch positive up; roll positive with the picture's right side low.
  function attitude(R, t, mid) {
    const a = R[2]; // the optical axis on the board
    return {
      mid: mid ? [0, 1, 2].map((k) => R[k][0] * mid[0] + R[k][1] * mid[1] + t[k]) : null, // the board's middle in the camera's frame
      yaw: Math.atan2(-a[0], a[2]),
      pitch: Math.asin(clamp1(-a[1])),
      roll: Math.asin(clamp1(R[0][1])),
      C: [0, 1, 2].map((k) => -(R[0][k] * t[0] + R[1][k] * t[1] + R[2][k] * t[2])), // the camera on the board's frame
    };
  }

  // the robot's pulse for a commanded angle, and back
  const TABLE_N = 13;
  const TABLE_STEP = 15; // degrees, from -90
  const tableAngles = () => Array.from({ length: TABLE_N }, (_, i) => -90 + i * TABLE_STEP);
  function pulseOf(m, a) {
    if (m.table) {
      const x = (Math.max(-90, Math.min(90, a)) + 90) / TABLE_STEP;
      const i = Math.max(0, Math.min(TABLE_N - 2, Math.floor(x)));
      return m.table[i] + (x - i) * (m.table[i + 1] - m.table[i]);
    }
    return a <= 0 ? m.cenP + (a / m.minA) * (m.minP - m.cenP) : m.cenP + (a / m.maxA) * (m.maxP - m.cenP);
  }
  // The table: for each of its angles, the pulse at which the servo really
  // is there -- interpolated between measured {actual, pulse} pairs.
  function tableFrom(pairs, keepZero) {
    const s = pairs.slice().sort((a, b) => a.actual - b.actual);
    // past the measured range: on from the outermost point at that side's
    // average rate (from the point nearest 0) -- steadier than the last few
    // points' own slope, which may sit on a local wiggle
    const mid = s.reduce((b, p) => (Math.abs(p.actual) < Math.abs(b.actual) ? p : b), s[0]);
    const rate = (end) => (end.actual !== mid.actual ? (end.pulse - mid.pulse) / (end.actual - mid.actual) : 0);
    const first = s[0];
    const last = s[s.length - 1];
    const at = (A) => {
      if (A <= first.actual) return first.pulse + (A - first.actual) * rate(first);
      if (A >= last.actual) return last.pulse + (A - last.actual) * rate(last);
      let i = 0;
      while (A > s[i + 1].actual) i++;
      const a = s[i];
      const b = s[i + 1];
      return a.pulse + ((A - a.actual) / (b.actual - a.actual)) * (b.pulse - a.pulse);
    };
    const r1 = (x) => Math.round(x * 10) / 10;
    const t = tableAngles().map((A) => r1(at(A)));
    if (keepZero !== undefined) t[(TABLE_N - 1) / 2] = keepZero;
    return t;
  }
  // one way throughout (a servo turns one way as the pulse grows)
  const monotone = (t) => t.every((v, i) => i === 0 || (v - t[i - 1]) * (t[TABLE_N - 1] - t[0]) > 0);
  function angleOf(m, p) {
    return (p - m.cenP) * (m.maxP - m.cenP) >= 0 ? ((p - m.cenP) / (m.maxP - m.cenP)) * m.maxA : ((p - m.cenP) / (m.minP - m.cenP)) * m.minA;
  }
  // The pulses at which the servo really is at minA / 0 / maxA, from the
  // measured {actual (deg), pulse} pairs: between them interpolated, past the
  // outermost two extended along them.
  function fitPulses(m, pairs, straight) {
    const s = pairs.slice().sort((a, b) => a.actual - b.actual);
    const r1 = (x) => Math.round(x * 10) / 10;
    if (straight) {
      // a line through the center (actual 0) per side, least squares
      const c = pairs.filter((p) => Math.abs(p.actual) < 1e-9);
      const cen = c.length ? c.reduce((a, p) => a + p.pulse, 0) / c.length : m.cenP;
      const side = (sgn) => {
        const q = pairs.filter((p) => p.actual * sgn > 1e-9);
        return q.reduce((a, p) => a + p.actual * (p.pulse - cen), 0) / q.reduce((a, p) => a + p.actual * p.actual, 0);
      };
      return { ...m, minP: r1(cen + side(-1) * m.minA), cenP: r1(cen), maxP: r1(cen + side(1) * m.maxA) };
    }
    const at = (A) => {
      let i = 0;
      while (i < s.length - 2 && A > s[i + 1].actual) i++;
      const a = s[i];
      const b = s[i + 1];
      return a.pulse + ((A - a.actual) / (b.actual - a.actual)) * (b.pulse - a.pulse);
    };
    return { ...m, minP: r1(at(m.minA)), cenP: r1(at(0)), maxP: r1(at(m.maxA)) };
  }
  // repeated commands averaged: [{cmd, actual, n}]
  function byCommand(list) {
    const g = new Map();
    list.forEach(({ cmd, actual }) => {
      const e = g.get(cmd) || { cmd, sum: 0, n: 0, all: [] };
      e.sum += actual;
      e.n++;
      e.all.push(actual);
      g.set(cmd, e);
    });
    return [...g.values()].map((e) => ({ cmd: e.cmd, actual: e.sum / e.n, n: e.n, spread: Math.max(...e.all) - Math.min(...e.all) })).sort((a, b) => a.cmd - b.cmd);
  }

  // 3 x 3 linear system (Cramer)
  function solve3(A, b) {
    const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    const d = det(A);
    if (Math.abs(d) < 1e-12) return null;
    return [0, 1, 2].map((k) => det(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / d);
  }

  function analyze(samples, panMap, tiltMap) {
    // pan's zero, from each leg of the drive (consecutive "zero" pictures, the
    // whole board in view): the board's middle in the camera's frame at both
    // ends -- the far end's turned back by the chassis's turn (odometry; about
    // the camera's up) -- gives the camera's move in its own frame; odometry
    // says how the chassis was heading to that move (whatever the path's
    // curve, or turns on the spot at the end)
    const zp = samples.filter((s) => s.kind === "zero" && s.att.mid);
    const legs = [];
    for (let k = 1; k < zp.length; k++) {
      const a = zp[k - 1];
      const b = zp[k];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.1) continue;
      const d = wrap(b.th - a.th);
      const [bx, , bz] = b.att.mid;
      const qx = bx * Math.cos(d) - bz * Math.sin(d);
      const qz = bx * Math.sin(d) + bz * Math.cos(d);
      const mx = a.att.mid[0] - qx; // the camera's move, in its frame at a (x right, z ahead)
      const mz = a.att.mid[2] - qz;
      const inCam = Math.atan2(-mx, mz); // (to the left of the optical axis)
      const inOdo = wrap(Math.atan2(b.y - a.y, b.x - a.x) - a.th); // (to the left of the chassis's heading)
      legs.push({ p0: wrap(inOdo - inCam), cm: Math.hypot(mx, mz) * 100 });
    }
    if (!legs.length) return { error: "The drive back and forth (for the pan's zero) needs the whole board in view at both ends, 10 cm or more apart" };
    const p0 = Math.atan2(legs.reduce((s, l) => s + Math.sin(l.p0), 0), legs.reduce((s, l) => s + Math.cos(l.p0), 0));
    // pan: every picture at tilt 0, its yaw less the chassis's heading, against the pan-0 ones
    const panPics = samples.filter((s) => (s.kind === "pan" || s.kind === "zero") && s.tilt === 0);
    const zeros = panPics.filter((s) => s.pan === 0);
    if (!zeros.length) return { error: "No picture at pan 0" };
    const ref = Math.atan2(
      zeros.reduce((a, s) => a + Math.sin(s.att.yaw - s.th), 0),
      zeros.reduce((a, s) => a + Math.cos(s.att.yaw - s.th), 0),
    );
    const pan = byCommand(panPics.map((s) => ({ cmd: s.pan, actual: (p0 + wrap(s.att.yaw - s.th - ref)) / D2R })));
    if (!pan.some((p) => p.cmd > 0) || !pan.some((p) => p.cmd < 0)) return { error: "Need pan pictures to both sides" };
    // tilt: pitch against the tilt-0 ones (pan 0)
    const tiltPics = samples.filter((s) => (s.kind === "tilt" || s.kind === "pan" || s.kind === "zero") && s.pan === 0);
    const tz = tiltPics.filter((s) => s.tilt === 0);
    const e0 = tz.reduce((a, s) => a + s.att.pitch, 0) / tz.length;
    const tilt = byCommand(tiltPics.map((s) => ({ cmd: s.tilt, actual: (s.att.pitch - e0) / D2R })));
    if (!tilt.some((p) => p.cmd > 0) || !tilt.some((p) => p.cmd < 0)) return { error: "Need tilt pictures up and down" };
    // new pulses, and how far off each measured angle is with them (the mapping is two straight lines)
    // the tables (the tilt's 0 stays where it is: its offset is the mount tilt's)
    const panTable = tableFrom(pan.map((p) => ({ actual: p.actual, pulse: pulseOf(panMap, p.cmd) })));
    const tiltTable = tableFrom(tilt.map((p) => ({ actual: p.actual, pulse: pulseOf(tiltMap, p.cmd) })), Math.round(pulseOf(tiltMap, 0) * 10) / 10);
    if (!monotone(panTable) || !monotone(tiltTable)) return { error: "The measured angles don't line up (a servo turning back and forth?) -- run it again" };
    // how far off the servos were (what the tables put right)
    pan.forEach((p) => (p.before = p.actual - p.cmd));
    tilt.forEach((p) => (p.before = p.actual - p.cmd));
    // (min / center / max as well: the table's ends and middle)
    const newPan = { ...panMap, minP: panTable[0], cenP: panTable[(TABLE_N - 1) / 2], maxP: panTable[TABLE_N - 1] };
    const newTilt = { ...tiltMap, minP: tiltTable[0], cenP: tiltTable[(TABLE_N - 1) / 2], maxP: tiltTable[TABLE_N - 1] };
    const roll = zeros.reduce((a, s) => a + s.att.roll, 0) / zeros.length;
    // The chassis's lean (the pan axis not vertical): panned to p, the camera
    // (facing the board all along) pitches by -fwd cos p - left sin p --
    // nose down, left side down. Least squares over the pan pictures; the
    // constant is the camera's own tilt (and the board's lean).
    let lean = null;
    const lp = panPics.map((s) => ({ p: p0 + wrap(s.att.yaw - s.th - ref), e: s.att.pitch }));
    if (lp.length >= 5 && lp.some((q) => q.p > 0.5) && lp.some((q) => q.p < -0.5)) {
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      const b = [0, 0, 0];
      lp.forEach(({ p, e }) => {
        const row = [1, -Math.cos(p), -Math.sin(p)];
        for (let i = 0; i < 3; i++) {
          b[i] += row[i] * e;
          for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j];
        }
      });
      const x = solve3(A, b);
      if (x) {
        const res = lp.map(({ p, e }) => e - (x[0] - x[1] * Math.cos(p) - x[2] * Math.sin(p)));
        lean = { fwdDeg: x[1] / D2R, leftDeg: x[2] / D2R, rmsDeg: Math.sqrt(res.reduce((a, r) => a + r * r, 0) / res.length) / D2R };
      }
    }
    // Backlash left over (with the robot's compensation as it is): the same
    // setpoint (pan 0 / tilt 0) arrived at turning + and turning -; where it
    // ends turning + less where it ends turning - (degrees).
    const gap = (kind, key) => {
      const up = samples.filter((s) => s.kind === kind && s.dir > 0).map((s) => s.att[key]);
      const down = samples.filter((s) => s.kind === kind && s.dir < 0).map((s) => s.att[key]);
      if (!up.length || !down.length) return null;
      const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
      // (yaw: positive to the left, as the pan; pitch: positive up, as the tilt)
      return (mean(up) - mean(down)) / D2R;
    };
    const backlash = { panGapDeg: gap("blPan", "yaw"), tiltGapDeg: gap("blTilt", "pitch") };
    return { pan, tilt, newPan, newTilt, panTable, tiltTable, lean, backlash, p0Deg: p0 / D2R, horizonDeg: e0 / D2R, rollDeg: roll / D2R, legs: legs.map((l) => ({ p0Deg: l.p0 / D2R, cm: l.cm })) };
  }

  Lynx.camServo = { attitude, analyze, pulseOf, angleOf, fitPulses, tableFrom, tableAngles };
})(window.Lynx);
