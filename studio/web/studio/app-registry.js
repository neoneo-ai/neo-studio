// Neo Studio 应用注册表：一条描述符 = 首页上的一个应用页。
//
// 首页卡（home-layout.js 的 HOME_CARDS）、路由（studio-app.js 的 route）与顶栏页签的可见性都从
// 这一张表派生。以前加一页要在三处各点一次名——route 的 if/else 链、卡表、页签——漏一处就是
// 「卡点下去停在空白页」或「页签在、卡不在」。
//
// 静态常量表，不接收运行时注册：运行时注册表是一份跨页共享的全局 store，还会绕过
// app/studio_caps.py 那张唯一的离线闸门。页的实现（build）在 studio-app.js 的 PAGE_BUILDERS 里
// 按 id 点名——只有那一份认识 #ns-view、桌面桥与能力表。
//
// id 与 cardId 存在用户版式 configs/home_layout.json 的 order/hidden 里：改名等于把用户排好的
// 首页拖散，所以这两枚与 hash 路由名是锁死的。cardId 只在与页名不同处写（旧版式里存过的那两名）。

export const STUDIO_APPS = [
    { id: "home", tab: "首页", eager: true },   // 首页不是一张直连卡：它就是这一页本身
    {
        id: "director", tab: "导演", section: "create", icon: "play",
        title: "导演视频", sub: "多段配方，生成整片视频",
        eager: true, deep: "recipe",   // 深链 #/director?recipe= 开那一份配方
    },
    {
        id: "paint", tab: "绘画", section: "create", icon: "sparkles",
        title: "生成图片", sub: "描述画面，直接出图",
        eager: true,
    },
    // 编辑板块铺的是那七发模式（home-layout.js 里的 edit-* 卡），不是本页的一张直连卡
    { id: "edit", tab: "编辑", eager: true },
    {
        id: "gallery", tab: "素材", section: "material", icon: "folder",
        title: "素材库", sub: "浏览与管理全部生成素材",
    },
    {
        id: "video", tab: "视频", section: "create", icon: "film",
        title: "生成视频", sub: "一句话加首帧，出一段视频",
    },
    {
        id: "pose", tab: "姿势", section: "create", icon: "pose",
        title: "3D 姿势", sub: "姿势 · 整场 · 全景",
    },
    {
        id: "skills", section: "material", icon: "wand",
        title: "技能", sub: "管理预设与技能包",
    },
    {
        id: "settings", section: "material", icon: "gear",
        title: "设置", sub: "生成默认值与界面语言",
        deep: "tab",   // 深链 #/settings?tab=mcp：智能体页的「MCP」入口跳来这
    },
    {
        id: "agent", section: "create", icon: "target",
        title: "智能体", sub: "说出目标，工具链多轮跑完",
    },
    {
        id: "frames", section: "edit", icon: "film",
        title: "视频抽帧", sub: "挑一条视频，抽帧存进素材库",
    },
    {
        id: "reverse", section: "edit", icon: "eye",
        title: "图片反推", sub: "挑一张图，反推出提示词",
    },
    {
        id: "reverse_video", cardId: "reverse-video", section: "edit", icon: "eye",
        title: "视频反推", sub: "挑一条视频，抽帧反推出提示词",
    },
    {
        id: "voice", section: "create", icon: "volume",
        title: "声音克隆", sub: "用一段参考音频的音色朗读文字",
    },
    {
        id: "enhance", cardId: "prompt-enhance", section: "create", icon: "wand",
        title: "提示词增强", sub: "选技能，把一句话写成完整提示词",
    },
    // 宫格图分镜是装配层的一页（顶栏不给它页签）：页上只铺高级模式的故事板那一面。
    // 宫格图拆分 → 逐格出提示词 → 生成配方全在这一页里走现成的链，整片参数与出片留在导演页。
    {
        id: "storyboard", section: "create", icon: "image",
        title: "宫格图分镜", sub: "宫格图拆成多段，逐格出提示词",
        defaultHidden: true,
    },
    {
        id: "canvas", tab: "画布", section: "create", icon: "image",
        title: "画布编排", sub: "图片与提示词，铺在一张画布上",
    },
];

/** 这一条描述符是哪一页：认不出（旧版式里的页名、别的构建里删掉的页）就交回 null，路由落回首页 */
export function appById(id) {
    return STUDIO_APPS.find((app) => app.id === id) || null;
}

/** 首页上直连本页的那一叠卡：带 section 的描述符各出一张，形状与内置卡表同字段。
 *  target 定 page、value 就是页 id——卡与页在注册表里是同一条描述符，不再两处点名。
 *  键 = 卡 id（旧版式里存的那两名与页名不同） */
export function homeCards() {
    const cards = {};
    for (const app of STUDIO_APPS) {
        if (!app.section) continue;
        const cardId = app.cardId || app.id;
        cards[cardId] = {
            id: cardId,
            section: app.section,
            icon: app.icon,
            title: app.title,
            sub: app.sub,
            target: "page",
            value: app.id,
            ...(app.defaultHidden ? { defaultHidden: true } : {}),
        };
    }
    return cards;
}

/** 顶栏出页签的那一撮页 id：页签的 DOM 与顺序在 index.html 里（冷启动不等模块图），
 *  这一份只说「哪些页该有页签」——两边对不上由用例说，不在运行时兜 */
export function tabAppIds() {
    return STUDIO_APPS.filter((app) => app.tab).map((app) => app.id);
}
