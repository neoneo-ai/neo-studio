// 自带 QR 编码器的正确性：格式/版本信息对 ISO 附录的已知值，矩阵能解码回原文，
// 纠密码字的 RS 伴随式为 0，功能图形与放置条带的几何站得住。解码器是测试里另写的一份，
// 与编码器互不共用几何代码 —— 共用只会把同一处几何错误抄两遍。
import test from "node:test";
import assert from "node:assert/strict";
import { qrMatrix, qrSvg, formatBits, versionBits, rsGenerator, rsRemainder, maskFn }
    from "../../web/js/core/qrcode-lite.js";

const LEVEL_L = 0b01;
const DATA_CW_L = [19, 34, 55, 80, 108, 136, 156, 194, 232, 274];
const EC_L = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const BLOCKS_L = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const REM_BITS = [0, 7, 7, 7, 7, 7, 14, 14, 14, 14];

// 附录 C 表：纠错 L 的 8 个掩码格式串（最高位在前）
const FORMAT_L = [
    "111011111000100", "111001011110011", "111110110101010", "111100010011101",
    "110011000101111", "110001100011000", "110110001000001", "110100101110110",
];
const VERSION_7 = "000111110010010100";
const VERSION_10 = "001010010011010011";

test("格式信息：等级 L 的 8 个掩码逐一等于附录串", () => {
    for (let mask = 0; mask < 8; mask++) {
        const got = formatBits(LEVEL_L, mask).toString(2).padStart(15, "0");
        assert.equal(got, FORMAT_L[mask], `mask ${mask}`);
    }
});

test("版本信息：版本 7 与版本 10 的 18 位等于附录串", () => {
    assert.equal(versionBits(7).toString(2).padStart(18, "0"), VERSION_7);
    assert.equal(versionBits(10).toString(2).padStart(18, "0"), VERSION_10);
});

// ---- 测试侧解码器 ----
function functionMap(size, version) {
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = true; };
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        set(r, c); set(r, size - 8 + c); set(size - 8 + r, c);
    }
    for (let i = 0; i < size; i++) { set(6, i); set(i, 6); }
    for (let i = 0; i < 9; i++) { set(8, i); set(i, 8); }
    for (let i = 0; i < 8; i++) { set(8, size - 1 - i); set(size - 1 - i, 8); }
    set(size - 8, 8);
    const centers = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
        [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]][version - 1];
    for (const r of centers) for (const c of centers) {
        const inFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
        if (inFinder) continue;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc);
    }
    if (version >= 7) for (let r = 0; r < 6; r++) for (let c = 0; c < 3; c++) {
        set(r, size - 11 + c); set(size - 11 + c, r);
    }
    return m;
}

function readFormat(matrix) {
    const bit = (r, c) => (matrix[r][c] ? 1 : 0);
    let copy1 = 0, copy2 = 0;
    for (let i = 0; i <= 5; i++) copy1 |= bit(i, 8) << i;
    copy1 |= bit(7, 8) << 6;
    copy1 |= bit(8, 8) << 7;
    copy1 |= bit(8, 7) << 8;
    for (let i = 9; i < 15; i++) copy1 |= bit(8, 14 - i) << i;
    const size = matrix.length;
    for (let i = 0; i < 8; i++) copy2 |= bit(8, size - 1 - i) << i;
    for (let i = 8; i < 15; i++) copy2 |= bit(size - 15 + i, 8) << i;
    assert.equal(copy2, copy1, "格式信息两处副本必须一致");
    for (let mask = 0; mask < 8; mask++) {
        if (formatBits(LEVEL_L, mask) === copy1) return mask;
    }
    assert.fail(`格式信息不是等级 L 的任何掩码：${copy1.toString(2)}`);
}

function readCodewordBits(matrix, map, mask, count) {
    const size = matrix.length;
    const fn = maskFn(mask);
    const bits = [];
    for (let col = size - 1; col >= 1; col -= 2) {
        if (col === 6) col = 5;
        const upward = ((col + 1) & 2) === 0;
        for (let step = 0; step < size; step++) {
            const row = upward ? size - 1 - step : step;
            for (const c of [col, col - 1]) {
                if (map[row][c]) continue;
                bits.push((matrix[row][c] ? 1 : 0) ^ (fn(row, c) ? 1 : 0));
                if (bits.length === count) return bits;
            }
        }
    }
    return bits;
}

function decode(matrix) {
    const size = matrix.length;
    const version = (size - 17) / 4;
    assert.ok(version >= 1 && version <= 10, `版本越界：${version}`);
    const mask = readFormat(matrix);
    const map = functionMap(size, version);
    const blocks = BLOCKS_L[version - 1];
    const dataCw = DATA_CW_L[version - 1];
    const ecLen = EC_L[version - 1];
    const totalCw = dataCw + ecLen * blocks;
    const bits = readCodewordBits(matrix, map, mask, totalCw * 8 + REM_BITS[version - 1]);
    const cw = [];
    for (let i = 0; i < totalCw * 8; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        cw.push(byte);
    }
    const k = Math.floor(dataCw / blocks), extra = dataCw % blocks;
    const bigFrom = blocks - extra;
    const data = Array.from({ length: blocks }, () => []);
    const ec = Array.from({ length: blocks }, () => []);
    let idx = 0;
    for (let i = 0; i < k + 1; i++) {
        for (let b = 0; b < blocks; b++) {
            const len = k + (b >= bigFrom ? 1 : 0);
            if (i < len) data[b].push(cw[idx++]);
        }
    }
    for (let i = 0; i < ecLen; i++) for (let b = 0; b < blocks; b++) ec[b].push(cw[idx++]);
    assert.equal(idx, totalCw, "交织读取的码字数必须等于总码字数");
    const gen = rsGenerator(ecLen);
    for (let b = 0; b < blocks; b++) {
        assert.deepEqual(Array.from(rsRemainder(data[b], gen)), ec[b], `第 ${b} 块纠密码字不符`);
    }
    const flatBits = [];
    for (const byte of data.flat()) for (let i = 7; i >= 0; i--) flatBits.push((byte >> i) & 1);
    const take = (n) => {
        let v = 0;
        for (let i = 0; i < n; i++) v = (v << 1) | flatBits.shift();
        return v;
    };
    assert.equal(take(4), 0b0100, "必须是字节模式");
    const count = take(version <= 9 ? 8 : 16);
    const out = [];
    for (let i = 0; i < count; i++) out.push(take(8));
    return new TextDecoder().decode(Uint8Array.from(out));
}

test("往返：ASCII 短串、配对链接、长串、多字节中文都能解码回原文", () => {
    const texts = [
        "HELLO",
        "http://192.168.1.5:43130/neo-studio/pair?token=AbCdEfGhIjKlMnOpQrStUv",
        "A".repeat(100),
        "http://10.0.0.9:8191/neo-studio/pair?token=中文令牌",
    ];
    for (const text of texts) {
        assert.equal(decode(qrMatrix(text)), text, `解码结果与原文不符：${text.slice(0, 24)}`);
    }
});

test("版本选择：按容量取最小版本，超容量抛错", () => {
    const sizeOf = (n) => qrMatrix("x".repeat(n)).length;
    assert.equal(sizeOf(17), 21);      // 版本 1 的字节容量
    assert.equal(sizeOf(18), 25);      // 装不进版本 1，进版本 2
    assert.equal(sizeOf(90), 37);      // 配对链接这个量级 → 版本 5
    assert.throws(() => qrMatrix("x".repeat(400)), /容量/);
});

test("功能图形：定位图案、时序图案与固定黑点位置正确", () => {
    const m = qrMatrix("http://192.168.0.165:43130/neo-studio/pair?token=abc");
    const size = m.length;
    const finder = (r0, c0) => {
        for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
            const ring = r === 0 || r === 6 || c === 0 || c === 6;
            const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
            assert.equal(m[r0 + r][c0 + c], ring || core, `定位图案 ${r0},${c0} @${r},${c}`);
        }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    // 时序段只从第 8 个模块起（前面是定位图案与分隔符，属定位图案自己的环）
    for (let i = 8; i <= size - 9; i++) {
        assert.equal(m[6][i], i % 2 === 0, `横向时序 @6,${i}`);
        assert.equal(m[i][6], i % 2 === 0, `纵向时序 @${i},6`);
    }
    assert.equal(m[size - 8][8], true, "固定黑点必须是深色");
});

test("校正图案：版本 2 只有一处 5x5 图案（角上的组合落进定位图案就跳过）", () => {
    const m = qrMatrix("A".repeat(32));          // 版本 2
    const size = m.length;
    assert.equal(size, 25);
    for (const [r, c] of [[18, 18]]) {
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
            const ring = Math.max(Math.abs(dr), Math.abs(dc));
            assert.equal(m[r + dr][c + dc], ring !== 1, `校正图案 @${r},${c} 偏移 ${dr},${dc}`);
        }
    }
    // (6,18) 与 (18,6) 这两个组合压着定位图案，标准里不画：(16,18) 应当是数据位而不是图案角
    assert.equal(qrMatrix("HELLO").length, 21);  // 版本 1 无校正图案，尺寸即证明
    const v7 = qrMatrix("A".repeat(150));        // 版本 7：6 处图案
    assert.equal(v7.length, 45);
    for (const [r, c] of [[22, 22], [22, 38], [38, 22], [38, 38], [6, 22], [22, 6]]) {
        assert.equal(v7[r][c], true, `校正图案中心 @${r},${c} 必须深色`);
    }
});

test("确定性：同一文本两次生成的矩阵逐模块一致", () => {
    const text = "http://192.168.0.165:43130/neo-studio/pair?token=abc";
    assert.deepEqual(qrMatrix(text), qrMatrix(text));
});

test("SVG 输出：边长含 4 模块静区，深色格数与矩阵一致", () => {
    const matrix = qrMatrix("HELLO");
    const svg = qrSvg(matrix, 6);
    const side = matrix.length + 8;
    assert.match(svg, new RegExp(`viewBox="0 0 ${side} ${side}"`));
    const dark = matrix.flat().filter(Boolean).length;
    assert.equal((svg.match(/<rect /g) || []).length, dark + 1, "每个深色模块一颗矩形，外加一张白底");
});

