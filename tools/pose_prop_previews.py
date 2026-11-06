#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
r"""给云端道具补齐卡片预览图：逐件从注册表行登记的来源页取那张官方渲染，写回云端索引行。

道具卡片只在注册表行写了 preview 时才出图（studio/web/pose/pose.js 的 propPreviewUrl 把那一行的相对
路径拼成 `<OSS 基址>/props/preview/<name>.png`）。云端那批 CC0 道具上云时注册表行没写 preview，OSS 的
props/preview/ 底下一张图都没有 —— 面板上每一张「云端」卡因此是「无预览」。

预览图不在这里渲染，取来源页对同一件模型的官方渲染：Poly Haven 用 api.polyhaven.com/info/<slug> 的
thumbnail_url（改到卡片那一档的 PNG），BlenderKit 用注册表 assetUrl 那行里最大的一张 thumbnail。
本项目自制的 stick / sword 没有上游，取随包渲染好的 studio/pose_dist/models/props/preview/<id>.png。
授权门禁不在这里重做：能进这份索引的件已经过了 pose_deploy_oss.py 的授权行（CC0 与本项目自制），
预览图与 GLB 出自同一来源页，署名行（source）本来随条目一起上云。

默认不动云端：先跑一遍看清单与出图，加 --apply 才传 props/preview/*.png 与改过的索引。索引只多
`registry.preview` 一个键，上传前的那份存在 <out>/index.before.json，要退回就传那一份。

用法：
    python tools/pose_prop_previews.py                                    # 索引取 oss_presets.json 的 pose_index_url
    python tools/pose_prop_previews.py --index tmp/index.json --out tmp/previews
    python tools/pose_prop_previews.py --props katana machete --apply
"""

import argparse
import json
import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pose_deploy_oss import (  # noqa: E402
    DEFAULT_PREFIX, data_root, load_credentials, put_bytes, put_file)

REPO = Path(__file__).resolve().parents[1]
SHIPPED_PREVIEWS = REPO / "studio" / "pose_dist" / "models" / "props"
OSS_PRESETS_FILE = data_root() / "configs" / "oss_presets.json"
PREVIEW_SIDE = 256          # 卡片的图框是 64px 高 + contain（pose.css 的 .ns-pose-prop-thumb），256 边长够 2x 屏不发糊
MAX_FETCH_BYTES = 8 * 1024 * 1024
FETCH_TIMEOUT = 30
USER_AGENT = "neo-studio-prop-preview/1.0"
POLYH_INFO = "https://api.polyhaven.com/info/{slug}"
POLYH_HOME = "https://polyhaven.com/"
SELF_MADE_SOURCE = "pose-repo"
# BlenderKit 一档一个字段，从大到小落：256 档在卡片上会糊，能拿大的就拿大的
BLENDEKIT_THUMBS = ("thumbnailLargeUrlNonsquared", "thumbnailLargeUrl",
                    "thumbnailMiddleUrlNonsquared", "thumbnailMiddleUrl",
                    "thumbnailSmallUrlNonsquared", "thumbnailSmallUrl")


def main() -> int:
    parser = argparse.ArgumentParser(description="云端道具卡片预览图：取来源页的官方渲染，写回云端索引行")
    parser.add_argument("--index", default="",
                        help="云端索引 JSON 文件；不给就读 <数据根>/configs/oss_presets.json 的 pose_index_url")
    parser.add_argument("--out", default="",
                        help=f"预览图与索引的落点，默认 {data_root() / 'pose' / 'props_preview'}")
    parser.add_argument("--props", nargs="*", default=[],
                        help="只处理点名的道具 id（katana 与 katana.glb 同一个落点）；默认处理没写 preview 的全部可见件")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX, help=f"OSS 键前缀，默认 {DEFAULT_PREFIX}")
    parser.add_argument("--config", default="", help="凭据 JSON，默认 <数据根>/configs/backyard_oss.json")
    parser.add_argument("--endpoint", default="")
    parser.add_argument("--bucket", default="")
    parser.add_argument("--access-key-id", default="")
    parser.add_argument("--access-key-secret", default="")
    parser.add_argument("--apply", action="store_true", help="真上传；不加就只出图与列清单（默认不动云端）")
    args = parser.parse_args()

    index = load_index(args)
    if index is None:
        print("[ERROR] 读不到云端索引：给 --index <file>，或在 <数据根>/configs/oss_presets.json 里写 pose_index_url")
        return 1
    rows = visible_rows(index, args.props)
    out_dir = Path(args.out) if args.out else data_root() / "pose" / "props_preview"
    out_dir.mkdir(parents=True, exist_ok=True)
    # 改索引前留一份原样：这条只往注册表行加 preview 一个键，出问题要退回就传这份
    write_json(out_dir / "index.before.json", index)
    print(f"云端索引 {len(index.get('props') or [])} 件道具 · 要补预览图 {len(rows)} 件")

    done = []
    for row in rows:
        rel = preview_rel(row)
        note = render_preview(row, out_dir / rel)
        if note:
            print(f"[SKIP] {row_id(row)}：{note}")
            continue
        registry = row.setdefault("registry", {})
        registry["preview"] = rel      # 读侧（pose_cloud.py 的 _prop_row）吃的就是注册表这一行
        done.append(rel)
        print(f"  PREVIEW {rel} · {row.get('label')}")

    prefix = args.prefix.strip().lstrip("/")
    prefix = prefix + "/" if prefix and not prefix.endswith("/") else prefix
    write_json(out_dir / "index.json", index)
    print(f"预览图 {len(done)}/{len(rows)} 张 → {out_dir / 'preview'}")
    print(f"索引副本 → {out_dir / 'index.json'}（原样在 index.before.json）")
    for rel in done:
        print(f"  {prefix}props/{rel}")

    if not args.apply:
        print("\n[DRY RUN] 没加 --apply：云端没动")
        print("要在姿势仓库留图：把上面这些 PNG 复制进 <pose repo>/dist/models/props/preview/，")
        print("之后 pose_deploy_oss.py 与 pose_prune_oss.py 就按同一口径认它们")
        return 0

    creds = load_credentials(args)
    if not (creds["endpoint"] and creds["bucket"] and creds["key_id"] and creds["key_secret"]):
        print(f"[ERROR] 凭据不全（读 {creds['config_path']}；命令行与环境变量可覆盖）")
        return 1
    try:
        import oss2
    except ImportError:
        print("[ERROR] 缺 oss2 依赖：pip install oss2")
        return 1
    bucket = oss2.Bucket(oss2.Auth(creds["key_id"], creds["key_secret"]), creds["endpoint"], creds["bucket"])
    for rel in done:
        put_file(bucket, f"{prefix}props/{rel}", out_dir / rel)
        print(f"UP {prefix}props/{rel}")
    put_bytes(bucket, f"{prefix}index.json",
              json.dumps(index, ensure_ascii=False, indent=1).encode("utf-8"))
    print(f"UP {prefix}index.json（{index.get('count')} 条场景 · {len(index.get('props') or [])} 件道具）")
    return 0


def load_index(args) -> dict | None:
    """要补的那份云端索引：--index 的本地文件优先，没给就从配置里那条 pose_index_url 取一份。"""
    if args.index:
        try:
            payload = json.loads(Path(args.index).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None
    try:
        cfg = json.loads(OSS_PRESETS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    url = pose_index_url(cfg if isinstance(cfg, dict) else {})
    body = http_get(url) if url else None
    if body is None:
        return None
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def pose_index_url(cfg: dict) -> str:
    """云端索引地址：pose_index_url 写了就用它，没写就从预设索引的目录推 —— 与读侧 cloud_urls 同口径。"""
    url = str(cfg.get("pose_index_url") or "").strip()
    if url:
        return url
    presets = str(cfg.get("index_url") or "").strip()
    if not presets:
        return ""
    parent = presets.rsplit("/", 1)[0].rsplit("/", 1)[0]
    return f"{parent}/pose/index.json"


def visible_rows(index: dict, wanted: list) -> list:
    """要补图的那批条目：hidden 行不进面板卡片（图发了没人看），已写 preview 的行不动。"""
    wanted = {str(name).rsplit(".", 1)[0] for name in (wanted or [])}
    rows = []
    for row in index.get("props") or []:
        if not isinstance(row, dict):
            continue
        registry = row.get("registry") if isinstance(row.get("registry"), dict) else {}
        if registry.get("hidden") or registry.get("preview"):
            continue
        if wanted and row_id(row) not in wanted:
            continue
        rows.append(row)
    return rows


def row_id(row: dict) -> str:
    """道具 id：索引没写 id 时从文件名取 —— 与读侧 _prop_row 的口径同一条。"""
    ident = str(row.get("id") or "").strip()
    if ident:
        return ident
    return str(row.get("file") or "").rsplit(".", 1)[0]


def preview_rel(row: dict) -> str:
    """注册表 preview 的写法：道具目录里的相对路径，上云的键是 props/preview/<id>.png。"""
    return f"preview/{row_id(row)}.png"


def render_preview(row: dict, dest: Path) -> str:
    """取一件的预览图落进 dest；成功返回空串，失败返回要说给用户的那一句。"""
    registry = row.get("registry") if isinstance(row.get("registry"), dict) else {}
    source = str(row.get("source") or registry.get("source") or "")
    asset = str(registry.get("assetUrl") or "")
    if asset:
        url = blendkit_thumb(asset)
    elif source.startswith(POLYH_HOME):
        url = polyhaven_thumb(source)
    elif source == SELF_MADE_SOURCE:
        return copy_shipped_preview(row, dest)
    else:
        return "注册表行没有 assetUrl 与可取图的 source"
    if not url:
        return "来源页没有预览图字段"
    body = http_get(url)
    if body is None:
        return f"取不到 {url}"
    return write_card_png(body, dest)


def polyhaven_thumb(source: str) -> str:
    """Poly Haven 的来源页 → 官方预览图：info/<slug> 的 thumbnail_url 改到卡片那一档的 PNG。"""
    slug = source.rstrip("/").rsplit("/", 1)[-1]
    info = json_get(POLYH_INFO.format(slug=slug))
    thumb = str((info or {}).get("thumbnail_url") or "").strip()
    return card_size_thumb(thumb) if thumb else ""


def card_size_thumb(url: str) -> str:
    """把官方缩略图的档位改成卡片用的边长：来源页默认给 256 档，摆到卡片上是糊的。"""
    head, _, query = url.partition("?")
    params = dict(urllib.parse.parse_qsl(query))
    params.update({"width": str(PREVIEW_SIDE), "height": str(PREVIEW_SIDE), "format": "png"})
    return f"{head}?{urllib.parse.urlencode(params)}"


def blendkit_thumb(asset_url: str) -> str:
    """BlenderKit 的 assetUrl → 那份资产记录里最大的一张 thumbnail。"""
    payload = json_get(asset_url)
    for entry in (payload or {}).get("files") or []:
        if not isinstance(entry, dict):
            continue
        for key in BLENDEKIT_THUMBS:
            # BlenderKit 的 URL 字段两头带空格，不去掉就是 urllib 报 unknown url type
            url = str(entry.get(key) or "").strip()
            if url:
                return url
    return ""


def copy_shipped_preview(row: dict, dest: Path) -> str:
    """自制道具没有上游：随包那张就是姿势仓库 npm run prop:preview 渲的，原样搬过来，不渲第二遍。"""
    shipped = SHIPPED_PREVIEWS / preview_rel(row)
    if not shipped.is_file():
        return (f"自制道具没有随包渲染图：在姿势仓库跑 npm run prop:preview，"
                f"把 {preview_rel(row)} 随道具一起同步进 {SHIPPED_PREVIEWS}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(shipped, dest)
    return ""


def write_card_png(body: bytes, dest: Path) -> str:
    """来源页的图 → 卡片用的 PNG：等比缩到边长上限，档位与随包预览图同一档（面板按 contain 摆）。"""
    import io

    from PIL import Image
    try:
        with Image.open(io.BytesIO(body)) as img:
            img.thumbnail((PREVIEW_SIDE, PREVIEW_SIDE))
            dest.parent.mkdir(parents=True, exist_ok=True)
            img.convert("RGBA" if img.mode == "RGBA" else "RGB").save(dest, "PNG")
    except (OSError, ValueError) as exc:
        return f"那张图解不开（{type(exc).__name__}）"
    return ""


def json_get(url: str) -> dict | None:
    body = http_get(url)
    if body is None:
        return None
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def http_get(url: str) -> bytes | None:
    """一次公开 GET：来源页的 JSON 与图都是公开资源，签名与后台轮询都不在这条路上。"""
    if not url:
        return None
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as resp:
            body = resp.read(MAX_FETCH_BYTES + 1)
    except Exception as exc:      # noqa: BLE001 - 来源页缺图、限流、断网都只说明这一件补不上
        print(f"[FETCH] {url} · {type(exc).__name__}: {exc}")
        return None
    if len(body) > MAX_FETCH_BYTES:
        print(f"[FETCH] {url} · 超过 {MAX_FETCH_BYTES} 字节上限")
        return None
    return body


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())

