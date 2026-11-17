// 技能落点的那一句副标题：落点由首页那一条点击路由判（pages/home-page.js 的 landingAppId——判据要读技能表
// 字段与生视频清单，那一发在这块页上），这一模块只把落点写成卡上的那一句话：「添加卡片」落盘时写进版式，
// 首页渲染读的就是版式里存的这一句。直连本页的落点报注册表里的页名，图片编辑那一发报对得上的那一发。
import { t, tf } from "../js/core/i18n.js";
import { appById } from "./app-registry.js";
import { HOME_CARDS } from "./home-layout.js";   // 那一发模式的名字读首页那叠编辑卡同一份，不自造第二套叫法

/** 技能卡的默认副标题：跳转类型落在技能上时先填这一句，选上了具体技能就按落点换成下面那几句 */
export const LANDING_SUB_DEFAULT = "打开这一发技能的应用页";

const LANDING_SUBS = {
    video: "进出视频页，这一发直接排成片子",
    paint: "进输入页，写下画面就出图",
    edit: "进图片编辑，带一张参考图改这一张",
    enhance: "进提示词增强页，先把这一发润色到位",
    voice: "进语音页，用克隆出的音色念这段字",
    skills: "先进技能页，在这一叠里挑着用它",
};

/** 落点那一页说在副标题上：首页那几发直连的写得顺一点，其余页报注册表里的页名；
 *  mode 是这张技能对得上的那一发编辑模式（扩图 / 局部 / 姿势 / 机位），对不上就只说落图片编辑 */
export function landingSub(appId, { mode = "" } = {}) {
    if (appId === "edit") {
        const title = mode && HOME_CARDS.find((c) => c.id === `edit-${mode}`)?.title;
        return title ? tf("进图片编辑 · {mode}那一发", { mode: t(title) }) : t(LANDING_SUBS.edit);
    }
    if (LANDING_SUBS[appId]) return t(LANDING_SUBS[appId]);
    const app = appById(appId);
    return tf("进「{page}」那一页", { page: t(app?.tab || app?.title || appId) });
}