/**
 * qrcode-lite.js —— 自带的最小 QR 编码器：QR Model 2、字节模式、纠错等级 L、版本 1-10。
 *
 * 「设置 → 手机连接」与手机配对页都要画二维码，正文是一条局域网 URL（几十字符），
 * 版本 1-10（21-57 模块）加纠错 L 足够。仓库的依赖规矩是不引第三方 QR 库，编码器写在
 * 这里。对外两件事：qrMatrix(text) 出布尔矩阵（true = 深色），drawQr(matrix, canvas) 画进
 * canvas（含 4 模块静区）。分块表与 ISO/IEC 18004 附录 D 一致，格式信息与版本信息由 BCH
 * 现算；测试里配了一份解码器做往返与伴随式校验。
 */

// 版本 1-10 的纠错 L 分块表：数据码字数、每块纠错码字数、块数
const DATA_CODEWORDS_L = [19, 34, 55, 80, 108, 136, 156, 194, 232, 274];
const EC_PER_BLOCK_L = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const BLOCK_COUNT_L = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
// 版本 1 没有余位；版本 2-6 余 7 位，版本 7-13 余 14 位（附录 D 的余数位）
const REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 14, 14, 14, 14];
const MAX_VERSION = 10;
const QUIET_ZONE = 4;
const FORMAT_POLY = 0x537;      // 格式信息的 BCH(15,5) 生成式
const FORMAT_XOR = 0x5412;      // 格式信息固定掩码（101010000010010）
const VERSION_POLY = 0x1F25;    // 版本信息的 BCH(18,6) 生成式
const LEVEL_L_BITS = 0b01;      // 纠错等级 L 在格式信息里占的两位
const MODE_BYTE = 0b0100;
// 校正图案中心坐标（附录 I，版本 1 无）：中心两两组合，落在定位图案角上的三组不画
const ALIGN_CENTERS = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

function alignCenters(version, size) {
    const centers = ALIGN_CENTERS[version - 1] || [];
    const out = [];
    for (const r of centers) for (const c of centers) {
        const inFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
        if (!inFinder) out.push([r, c]);
    }
    return out;
}


// GF(256) 指数/对数表，本原多项式 0x11D
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function buildGfTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x = (x << 1) ^ ((x & 0x80) ? 0x11D : 0);
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 度数 t 的 RS 生成多项式，系数降幂排列（首项 1 在内）。 */
export function rsGenerator(t) {
    let poly = [1];
    for (let i = 0; i < t; i++) {
        const next = new Array(poly.length + 1).fill(0);
        for (let j = 0; j < poly.length; j++) {
            next[j] ^= poly[j];
            next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
        }
        poly = next;
    }
    return poly;
}

/** 码字串对生成式的余式，即纠错码字。 */
export function rsRemainder(data, gen) {
    const res = new Uint8Array(gen.length - 1);
    for (const byte of data) {
        const factor = byte ^ res[0];
        res.copyWithin(0, 1);
        res[res.length - 1] = 0;   // 移位的空位必须清零：留着旧值会被当成系数乘进去
        for (let i = 0; i < gen.length - 1; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
    return res;
}

/** BCH 余式：按位长除，生成式度数 = width，返回 width 位余数。 */
export function bchRemainder(data, poly, width) {
    let v = data << width;
    for (let shift = width; shift >= 0; shift--)
        if (v & (1 << (width + shift))) v ^= poly << shift;
    return v & ((1 << width) - 1);
}

/** 格式信息 15 位：等级两位 + 掩码三位 → BCH(15,5) → 异或固定掩码。 */
export function formatBits(levelBits, mask) {
    const data = (levelBits << 3) | mask;
    return ((data << 10) | bchRemainder(data, FORMAT_POLY, 10)) ^ FORMAT_XOR;
}

/** 版本信息 18 位：版本 6 位 + BCH(18,6)（版本 7 起才有）。 */
export function versionBits(version) {
    return (version << 12) | bchRemainder(version, VERSION_POLY, 12);
}


/** 字节模式的码字串：段头 + 数据 + 结束符 + 位补齐 + 交替填充字节。 */
function dataCodewords(bytes, version) {
    const capBits = DATA_CODEWORDS_L[version - 1] * 8;
    const bits = [];
    const push = (value, width) => {
        for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };
    push(MODE_BYTE, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, capBits - bits.length));   // 结束符最多 4 个 0，装不下就丢
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        out.push(byte);
    }
    for (let fill = 0x10; out.length < DATA_CODEWORDS_L[version - 1]; fill ^= 0x11)
        out.push(fill);
    return out;
}

function pickVersion(byteLen) {
    for (let v = 1; v <= MAX_VERSION; v++) {
        if (4 + (v <= 9 ? 8 : 16) + byteLen * 8 <= DATA_CODEWORDS_L[v - 1] * 8) return v;
    }
    return 0;
}

/** 数据码字分块，逐块算纠错码字：分块不整除时，多出的码字给最后几块（规格表里的分组顺序）。 */
function splitBlocks(codewords, version) {
    const blocks = BLOCK_COUNT_L[version - 1];
    const gen = rsGenerator(EC_PER_BLOCK_L[version - 1]);
    const k = Math.floor(codewords.length / blocks);
    const bigFrom = blocks - codewords.length % blocks;
    const data = [], ec = [];
    for (let b = 0; b < blocks; b++) {
        const len = k + (b >= bigFrom ? 1 : 0);
        const slice = codewords.slice(b * k + Math.max(0, b - bigFrom), b * k + Math.max(0, b - bigFrom) + len);
        data.push(slice);
        ec.push(Array.from(rsRemainder(slice, gen)));
    }
    return { data, ec };
}

/** 交织：数据码字逐块轮转，接纠错码字轮转，尾随余数位补 0。 */
function interleave(blocks, remainderBits) {
    const out = [];
    const maxK = Math.max(...blocks.data.map((b) => b.length));
    for (let i = 0; i < maxK; i++) for (const b of blocks.data) if (i < b.length) out.push(b[i]);
    const maxE = Math.max(...blocks.ec.map((b) => b.length));
    for (let i = 0; i < maxE; i++) for (const b of blocks.ec) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < remainderBits; i++) out.push(0);
    return out;
}

/** 功能图形与保留区占位表：true = 该模块不参与数据放置。 */
function reservedMatrix(size, version) {
    const res = Array.from({ length: size }, () => new Array(size).fill(false));
    const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) res[r][c] = true; };
    for (const [r0, c0] of [[0, 0], [0, size - 8], [size - 8, 0]])   // 定位图案 + 分隔符
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
            mark(r0 === 0 ? r : size - 8 + r, c0 === 0 ? c : size - 8 + c);
    for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }       // 时序图案：第 6 行与第 6 列
    for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }          // 格式信息两条
    for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
    mark(size - 8, 8);                                               // 固定黑点
    for (const [r, c] of alignCenters(version, size))               // 校正图案 5x5
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    if (version >= 7) {                                              // 版本信息两个角区
        for (let r = 0; r < 6; r++) for (let c = 0; c < 3; c++) {
            mark(r, size - 11 + c);
            mark(size - 11 + c, r);
        }
    }
    return res;
}

const MASK_FN = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

export const maskFn = (mask) => MASK_FN[mask];

/**
 * 一版掩码下的完整图：功能图形 → 数据条带放置 → 掩码 → 格式信息 → 版本信息。
 * 坐标一律 matrix[行][列]；格式信息与版本信息两处副本的位置按附录 C 的条带走。
 */
function buildMatrix(version, codewordBits, mask) {
    const size = 17 + version * 4;
    const matrix = Array.from({ length: size }, () => new Array(size).fill(false));
    const reserved = reservedMatrix(size, version);
    for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
        for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
            const ring = r === 0 || r === 6 || c === 0 || c === 6;
            const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
            matrix[r0 === 0 ? r : size - 7 + r][c0 === 0 ? c : size - 7 + c] = ring || core;
        }
    }
    // 时序图案只在两块定位图案之间的那段（第 8 到 size-9），整行整列写会把定位图案的环抹掉
    for (let i = 8; i <= size - 9; i++) { matrix[6][i] = i % 2 === 0; matrix[i][6] = i % 2 === 0; }
    // 校正图案：外环深、内环浅、中心深
    for (const [r, c] of alignCenters(version, size))
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
            matrix[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;

    // 数据条带：两列一组自右下往左上蛇形，第 6 列是时序图案，整列跳过
    let bit = 0;
    for (let col = size - 1; col >= 1; col -= 2) {
        if (col === 6) col = 5;
        const upward = ((col + 1) & 2) === 0;
        for (let step = 0; step < size; step++) {
            const row = upward ? size - 1 - step : step;
            for (const c of [col, col - 1]) {
                if (reserved[row][c]) continue;
                matrix[row][c] = bit < codewordBits.length ? codewordBits[bit] === 1 : false;
                bit++;
            }
        }
    }

    const fn = MASK_FN[mask];
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
        if (!reserved[r][c] && fn(r, c)) matrix[r][c] = !matrix[r][c];

    const fmt = formatBits(LEVEL_L_BITS, mask);
    const fmtBit = (i) => ((fmt >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) matrix[i][8] = fmtBit(i);
    matrix[7][8] = fmtBit(6);
    matrix[8][8] = fmtBit(7);
    matrix[8][7] = fmtBit(8);
    for (let i = 9; i < 15; i++) matrix[8][14 - i] = fmtBit(i);
    for (let i = 0; i < 8; i++) matrix[8][size - 1 - i] = fmtBit(i);
    for (let i = 8; i < 15; i++) matrix[size - 15 + i][8] = fmtBit(i);
    matrix[size - 8][8] = true;   // 固定黑点：格式条带旁的那一颗，与掩码无关

    if (version >= 7) {
        const vb = versionBits(version);
        for (let i = 0; i < 18; i++) {
            const bitOn = ((vb >> i) & 1) === 1;
            const r = Math.floor(i / 3), c = i % 3;
            matrix[r][size - 11 + c] = bitOn;
            matrix[size - 11 + c][r] = bitOn;
        }
    }
    return matrix;
}

/** 掩码评价：四条罚则（附录 D 的 1-4 号），分低的掩码胜出。 */
function penalty(matrix) {
    const size = matrix.length;
    let score = 0;
    const runPenalty = (line) => {
        let sum = 0, run = 1;
        for (let i = 1; i <= line.length; i++) {
            if (i < line.length && line[i] === line[i - 1]) { run++; continue; }
            if (run >= 5) sum += 3 + (run - 5);
            run = 1;
        }
        return sum;
    };
    for (let r = 0; r < size; r++) score += runPenalty(matrix[r]);
    for (let c = 0; c < size; c++) score += runPenalty(matrix.map((row) => row[c]));
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
        const v = matrix[r][c];
        if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3;
    }
    // 1:1:3:1:1 定位样形（正反两向），前后各带 4 个浅色模块才算
    const PAT = [true, false, true, true, true, false, true];
    const LIGHT4 = [false, false, false, false];
    const matchAt = (line, at, pat) => pat.every((v, k) => line[at + k] === v);
    const lineOf = (r) => matrix[r];
    const colOf = (c) => matrix.map((row) => row[c]);
    const scan = (line) => {
        let sum = 0;
        for (let i = 0; i + 11 <= line.length; i++) {
            if (matchAt(line, i, PAT) && matchAt(line, i + 7, LIGHT4)) sum += 40;
            if (matchAt(line, i, LIGHT4) && matchAt(line, i + 4, PAT)) sum += 40;
        }
        return sum;
    };
    for (let r = 0; r < size; r++) score += scan(lineOf(r));
    for (let c = 0; c < size; c++) score += scan(colOf(c));
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r][c]) dark++;
    const total = size * size;
    score += 10 * Math.floor(Math.abs(dark * 2 - total) / (total / 5));
    return score;
}

/**
 * 出二维码矩阵：qrMatrix(text) -> 布尔二维数组；带 mask 参数时固定用该掩码（测试用）。
 * 文本按 UTF-8 字节编码，超过版本 10 的容量抛错（配对页的 URL 远在容量之内）。
 */
export function qrMatrix(text, mask = null) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    const version = pickVersion(bytes.length);
    if (!version) throw new Error(`二维码容量不足：${bytes.length} 字节超出版本 ${MAX_VERSION}`);
    const codewords = dataCodewords(bytes, version);
    const bits = [];
    for (const byte of interleave(splitBlocks(codewords, version), REMAINDER_BITS[version - 1]))
        for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
    const masks = mask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask];
    let best = null, bestScore = Infinity;
    for (const m of masks) {
        const candidate = buildMatrix(version, bits, m);
        const score = penalty(candidate);
        if (score < bestScore) { bestScore = score; best = candidate; }
    }
    return best;
}

/** 画进 canvas（含静区）；scale 是每模块像素，返回边长。 */
export function drawQr(matrix, canvas, scale = 6) {
    const side = (matrix.length + QUIET_ZONE * 2) * scale;
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, side, side);
    ctx.fillStyle = "#000000";
    for (let r = 0; r < matrix.length; r++) for (let c = 0; c < matrix.length; c++)
        if (matrix[r][c]) ctx.fillRect((c + QUIET_ZONE) * scale, (r + QUIET_ZONE) * scale, scale, scale);
    return side;
}

/** 矩阵转 SVG 字符串（打印与内联展示用，静区同样 4 模块）。 */
export function qrSvg(matrix, scale = 6) {
    const side = matrix.length + QUIET_ZONE * 2;
    let cells = "";
    for (let r = 0; r < matrix.length; r++) for (let c = 0; c < matrix.length; c++)
        if (matrix[r][c])
            cells += `<rect x="${c + QUIET_ZONE}" y="${r + QUIET_ZONE}" width="1" height="1"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${side * scale}" height="${side * scale}" `
        + `viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">`
        + `<rect width="${side}" height="${side}" fill="#fff"/>${cells}</svg>`;
}


